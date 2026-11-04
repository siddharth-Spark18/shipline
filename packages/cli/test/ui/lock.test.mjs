// Plan item 58, Lock (plan "Lock and session index", item 50): one active chat per checkout, recovery after a
// crash, and no take-over. Runs the UI server(s) in-process against test/fixtures/fake-claude.mjs.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_ROOT, makeRepo, removeDir } from '../helpers.mjs';
import { api, openEvents, startUi } from './helpers.mjs';
import { lockPath, postChat, readLockFile, readSessions, startChat, stopChat, uiDir, useFakeClaude } from './chat-helpers.mjs';

let dir;
let fake;
let ui;
let ev;

const writeLock = (content, ageMs = 0) => {
  mkdirSync(uiDir(dir), { recursive: true });
  writeFileSync(lockPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(lockPath(dir), t, t);
  }
};

// A pid that is certainly not running: a child that has already exited.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

before(async () => {
  fake = useFakeClaude();
  dir = makeRepo({ commitInit: true });
  ui = await startUi(dir);
  ev = await openEvents(ui);
});

after(async () => {
  if (ev) ev.close();
  if (ui) await ui.close();
  removeDir(dir);
  if (fake) fake.cleanup();
});

describe('one chat per checkout', () => {
  test('a second chat in the same server gets 409 chat-active with the active chat id', async () => {
    fake.script('hang');
    const id = await startChat(ui, ev);
    try {
      const r = await postChat(ui, 'another');
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'chat-active');
      assert.equal(r.json.error.details.chatId, id);
      // Continuing another chat while one is active is refused the same way.
      const other = readSessions(dir).find((c) => c.id !== id);
      if (other) {
        const c = await api(ui, 'POST', `/api/chats/${other.id}/continue`);
        assert.equal(c.status, 409);
        assert.equal(c.json.error.code, 'chat-active');
      }
      assert.equal(fake.runs().length, 1, 'only one claude was spawned');
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('a second server on the same checkout gets 409 lock-held with heldBy = the first server\'s port', async () => {
    fake.script('hang');
    const id = await startChat(ui, ev);
    const second = await startUi(dir);
    try {
      const r = await postChat(second, 'from the second server');
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error.code, 'lock-held');
      assert.equal(r.json.error.details.heldBy, ui.port);
      assert.match(r.json.error.message, new RegExp(`port ${ui.port}`));
      // Continue from the second server is refused the same way, and the first server's lock is untouched.
      const c = await api(second, 'POST', `/api/chats/${id}/continue`);
      assert.equal(c.status, 409);
      assert.equal(c.json.error.code, 'lock-held');
      assert.equal(readLockFile(dir).port, ui.port);
      assert.equal(readLockFile(dir).session_id, id);
      // The second server lists the chat as active (another live server's lock names it).
      const list = await api(second, 'GET', '/api/chats');
      assert.equal(list.json.chats.find((x) => x.id === id).status, 'active');
    } finally {
      await second.close();
      await stopChat(ui, ev, id);
    }
    assert.equal(existsSync(lockPath(dir)), false);
  });

  test('a lock held by another live process on this host gives lock-held with its port', async () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      writeLock({ pid: holder.pid, hostname: os.hostname(), port: 54321, session_id: '22222222-2222-4222-8222-222222222222' });
      fake.script('hang');
      const r = await postChat(ui);
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'lock-held');
      assert.equal(r.json.error.details.heldBy, 54321);
      assert.equal(readLockFile(dir).pid, holder.pid, 'a live lock is never replaced');
      assert.equal(fake.runs().length, 0);
    } finally {
      holder.kill();
      removeDir(lockPath(dir));
    }
  });

  test('a lock from another host is never treated as stale, even with a dead pid', async () => {
    writeLock({ pid: deadPid(), hostname: `not-${os.hostname()}`, port: 4444, session_id: null });
    try {
      fake.script('hang');
      const r = await postChat(ui);
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'lock-held');
      assert.equal(r.json.error.details.heldBy, 4444);
    } finally {
      removeDir(lockPath(dir));
    }
  });
});

describe('stale locks', () => {
  test('a lock whose pid is dead (same host) is replaced', async () => {
    writeLock({ pid: deadPid(), hostname: os.hostname(), port: 1, session_id: '33333333-3333-4333-8333-333333333333' });
    fake.script('hang');
    const id = await startChat(ui, ev);
    try {
      assert.deepEqual(readLockFile(dir), { pid: process.pid, hostname: os.hostname(), port: ui.port, session_id: id });
    } finally {
      await stopChat(ui, ev, id);
    }
    assert.equal(existsSync(lockPath(dir)), false);
  });

  test('an empty lock file older than 10 s is replaced', async () => {
    writeLock('', 20_000);
    fake.script('hang');
    const id = await startChat(ui, ev);
    try {
      assert.equal(readLockFile(dir).session_id, id);
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('a partial (unparseable) lock file younger than 10 s is not replaced', async () => {
    writeLock('{"pid": 12');
    try {
      fake.script('hang');
      const r = await postChat(ui);
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'lock-held');
      assert.equal(readFileSync(lockPath(dir), 'utf8'), '{"pid": 12');
      assert.equal(fake.runs().length, 0);
    } finally {
      removeDir(lockPath(dir));
    }
  });
});

describe('no take-over', () => {
  test('there is no endpoint that takes over or clears another server\'s lock', async () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const lock = { pid: holder.pid, hostname: os.hostname(), port: 54321, session_id: '44444444-4444-4444-8444-444444444444' };
      writeLock(lock);
      for (const p of ['/api/lock', '/api/chats/lock', '/api/chats/takeover', '/api/chats/take-over', '/api/lock/takeover', '/api/lock/release']) {
        for (const m of ['POST', 'DELETE']) {
          const r = await api(ui, m, p, { body: m === 'POST' ? {} : undefined });
          assert.ok([404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
        }
      }
      assert.deepEqual(readLockFile(dir), lock);
      // And no source file in the server mentions a take-over.
      const src = path.join(CLI_ROOT, 'src', 'ui');
      for (const f of readdirSync(src).filter((n) => n.endsWith('.mjs'))) {
        assert.doesNotMatch(readFileSync(path.join(src, f), 'utf8'), /take-?over|takeOver|force-?unlock/i, f);
      }
    } finally {
      holder.kill();
      removeDir(lockPath(dir));
    }
  });
});
