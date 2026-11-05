// The chat session index (sessions.json) and the one-chat-per-checkout lock (lock.json), both in
// <store>/ui/ (outside the repo). Node 20+, no dependencies.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uiDir } from '../store.mjs';
import { log } from './log.mjs';

const STALE_EMPTY_LOCK_MS = 10_000;

export const uiStateDir = (root) => uiDir(root);
const sessionsFile = (root) => path.join(uiStateDir(root), 'sessions.json');
const lockFile = (root) => path.join(uiStateDir(root), 'lock.json');

export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// An entry's task_dirs: every task folder the chat bound to, oldest first, no duplicates. An entry written before
// 0.10.0 has none and reads as [task_dir] (or []); a task_dir missing from the list is appended.
function normalize(chat) {
  if (!chat || typeof chat !== 'object') return chat;
  const dirs = [];
  const add = (d) => {
    if (typeof d === 'string' && d && !dirs.includes(d)) dirs.push(d);
  };
  if (Array.isArray(chat.task_dirs)) chat.task_dirs.forEach(add);
  add(chat.task_dir);
  return { ...chat, task_dirs: dirs };
}

// [{ id, title, created, last_active, task_dir | null, task_dirs: string[], status: 'active' | 'ended' }]
// task_dir is the current (last bound) task.
export function listChats(root) {
  try {
    const list = JSON.parse(readFileSync(sessionsFile(root), 'utf8'));
    return Array.isArray(list) ? list.map(normalize) : [];
  } catch {
    return [];
  }
}

export function getChat(root, id) {
  return listChats(root).find((c) => c.id === id) || null;
}

export function addChat(root, chat) {
  const list = listChats(root).filter((c) => c.id !== chat.id);
  list.push(chat);
  writeAtomic(sessionsFile(root), JSON.stringify(list, null, 2) + '\n');
  return chat;
}

// Adds a task folder to the chat's task_dirs (no change when it is already there). Returns the updated entry, or
// null when the id is unknown.
export function addTaskDir(root, id, dir) {
  const chat = getChat(root, id);
  if (!chat) return null;
  if (chat.task_dirs.includes(dir)) return chat;
  return updateChat(root, id, { task_dirs: [...chat.task_dirs, dir] });
}

// Returns the updated entry, or null when the id is unknown.
export function updateChat(root, id, patch) {
  const list = listChats(root);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  writeAtomic(sessionsFile(root), JSON.stringify(list, null, 2) + '\n');
  return list[i];
}

export function readLock(root) {
  try {
    return JSON.parse(readFileSync(lockFile(root), 'utf8'));
  } catch {
    return null;
  }
}

// The lock held by *another* UI server that is still running, or null. A lock left behind by a server
// that exited without releasing it (same host, dead pid) does not count, and neither does this
// server's own lock (same pid and `ownPort`): the caller asks its own chats for that.
export function liveLock(root, ownPort) {
  const lock = readLock(root);
  if (!lock || typeof lock !== 'object') return null;
  if (lock.hostname === os.hostname()) {
    if (lock.pid === process.pid && lock.port === ownPort) return null;
    if (lock.pid !== process.pid && !pidAlive(lock.pid)) return null;
  }
  return lock;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === 'ESRCH'); // EPERM: it exists, we just can't signal it
  }
}

// Takes lock.json with the `wx` flag. Returns { acquired: true }, or { acquired: false, heldBy, sessionId }
// where heldBy is 'self' (this server already has a chat active; POST /api/chats turns that into 409
// chat-active), or the port of the other UI server (409 lock-held). heldBy is null when the holder is unknown.
export function acquireLock(root, { sessionId, port }) {
  const file = lockFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const mine = { pid: process.pid, hostname: os.hostname(), port, session_id: sessionId };
  let held = { acquired: false, heldBy: null, sessionId: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      log('lock-taken', { sessionId, port });
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // released between our write and read: retry
    }
    let lock = null;
    try {
      lock = JSON.parse(raw);
    } catch {
      // A crash between creating and writing the file leaves it empty or partial.
    }
    let stale = false;
    if (!lock || typeof lock !== 'object') {
      let age = 0;
      try {
        age = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_EMPTY_LOCK_MS) stale = true;
      else return held;
    } else if (lock.pid === process.pid && lock.port === port) {
      return { acquired: false, heldBy: 'self', sessionId: lock.session_id };
    } else if (lock.hostname === os.hostname() && lock.pid !== process.pid && !pidAlive(lock.pid)) {
      stale = true;
    }
    if (!stale) {
      return { acquired: false, heldBy: lock.port ?? null, sessionId: lock.session_id ?? null };
    }
    log('lock-stale', { lock });
    try {
      unlinkSync(file);
    } catch {
      // Someone else removed it first.
    }
  }
  return held;
}

// Removes lock.json only when it is this process's (and, when given, this server's port).
export function releaseLock(root, port) {
  const file = lockFile(root);
  const lock = readLock(root);
  if (!lock || lock.pid !== process.pid) return false;
  if (port !== undefined && lock.port !== port) return false;
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    return false;
  }
  log('lock-released', { sessionId: lock.session_id });
  return true;
}
