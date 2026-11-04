// The chat process manager: one `claude` child per active chat, its lock, stream and stop path.
// Node 20+, no dependencies.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MCP_TOOL_TIMEOUT_ENV, buildArgs, findClaude } from './claude.mjs';
import { HttpError } from './http.mjs';
import { stateDir } from '../store.mjs';
import { log } from './log.mjs';
import { acquireLock, addChat, getChat, releaseLock, updateChat } from './sessions.mjs';
import {
  KNOWN_TYPES,
  classifyHookMessage,
  guardDenial,
  hookSystemMessage,
  isInit,
  isResult,
  isUsageLimit,
  parseLine,
  userMessage,
} from './stream.mjs';
import { watchState } from './watch.mjs';

const STDERR_TAIL_BYTES = 4096;
const KILL_AFTER_MS = 5000;
const EXIT_GRACE_MS = 1000;
const TITLE_LIMIT = 60;

export const resumeCommand = (id) => `claude --resume ${id}`;

export function createChats(app) {
  const root = app.repo.root;
  let active = null;
  const emit = (payload) => app.hub.send('chat', payload);

  const state = (id) => (active && active.id === id ? active : null);

  // Reads <store>/state/<id>.json (written by stage.mjs start or resume) and stores its task_dir.
  function bindTask(chat) {
    let taskDir = null;
    try {
      const j = JSON.parse(readFileSync(path.join(stateDir(root), `${chat.id}.json`), 'utf8'));
      if (j && typeof j.task_dir === 'string') taskDir = j.task_dir;
    } catch {
      return;
    }
    if (!taskDir || taskDir === chat.taskDir) return;
    chat.taskDir = taskDir;
    updateChat(root, chat.id, { task_dir: taskDir });
    emit({ chatId: chat.id, kind: 'task', taskDir });
  }

  // Turns one stream event into the SSE payload, adding `notices` for what the UI labels.
  function annotate(chat, event) {
    const notices = [];
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const b of event.message.content)
        if (b && b.type === 'tool_use' && b.id) chat.toolNames.set(b.id, b.name);
    }
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const b of event.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const text = guardDenial(b);
        if (text) notices.push({ kind: 'shipline-block', toolUseId: b.tool_use_id, text });
        else if (app.prompts.takeDenied(chat.id, b.tool_use_id, chat.toolNames.get(b.tool_use_id)))
          notices.push({ kind: 'you-denied', toolUseId: b.tool_use_id });
      }
    }
    const hook = hookSystemMessage(event);
    if (hook) {
      const c = classifyHookMessage(hook);
      notices.push({ kind: c.kind, text: hook });
      if (c.banner) app.addBanner({ id: c.banner, kind: c.banner, text: hook });
    }
    if (isResult(event) && isUsageLimit(event))
      app.addBanner({ id: 'usage-limit', kind: 'usage-limit', text: String(event.result) });
    return notices;
  }

  function onLine(chat, line) {
    if (chat.stopping || chat.done) return;
    const r = parseLine(line);
    if (r.skip) return;
    if (!r.ok) {
      // Not valid stream-json: stop, and show how to continue in a terminal.
      log('stream-parse-error', { chatId: chat.id, error: r.error });
      chat.fatal = { kind: 'fatal', reason: 'parse', resumeCommand: resumeCommand(chat.id) };
      stopChat(chat);
      return;
    }
    const event = r.event;
    if (isInit(event)) {
      chat.sawInit = true;
      // UNVERIFIED (chat test Q1): system/init reports the session id the UI chose.
      if (event.session_id && event.session_id !== chat.id)
        log('session-id-mismatch', { chatId: chat.id, reported: event.session_id });
    }
    if (isResult(event)) {
      chat.busy = false;
      updateChat(root, chat.id, { last_active: new Date().toISOString() });
    }
    if (!KNOWN_TYPES.has(event.type)) {
      log('unknown-event-type', { chatId: chat.id, type: event.type });
      return;
    }
    const notices = annotate(chat, event);
    const payload = { chatId: chat.id, kind: 'event', event };
    if (notices.length) payload.notices = notices;
    emit(payload);
  }

  // Runs once per chat, when the child is gone: cleanup first, then the final SSE event.
  function finish(chat, code, signal, spawnError) {
    if (chat.done) return;
    if (chat.buf.trim()) {
      const tail = chat.buf; // a last line with no newline still counts
      chat.buf = '';
      onLine(chat, tail);
    }
    chat.done = true;
    clearTimeout(chat.exitTimer);
    clearTimeout(chat.killTimer);
    const stderrTail = chat.stderr.toString('utf8');
    log('chat-exit', { chatId: chat.id, code, signal, stopping: chat.stopping, stderrTail });
    if (chat.stateWatch) chat.stateWatch.close();
    bindTask(chat);
    app.prompts.denyAll(chat.id);
    app.prompts.removeMcpConfig(chat.id);
    updateChat(root, chat.id, { status: 'ended', last_active: new Date().toISOString() });
    releaseLock(root, app.port);
    if (active === chat) active = null;
    chat.busy = false;

    if (chat.fatal) emit({ chatId: chat.id, ...chat.fatal });
    else if (chat.stopping) emit({ chatId: chat.id, kind: 'ended' });
    else if (chat.resume && !chat.sawInit)
      emit({
        chatId: chat.id,
        kind: 'fatal',
        reason: 'resume-failed',
        code,
        stderrTail: spawnError || stderrTail,
      });
    else
      emit({
        chatId: chat.id,
        kind: 'fatal',
        reason: 'exit',
        code,
        stderrTail: spawnError || stderrTail,
        resumeCommand: resumeCommand(chat.id),
      });
    chat.resolveExited();
  }

  function killGroup(chat, signal) {
    if (!chat.child || !chat.child.pid) return;
    try {
      process.kill(-chat.child.pid, signal); // the child leads its own process group
    } catch {
      try {
        chat.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  // Closes stdin, SIGTERM to the process group, SIGKILL after 5 s, then (in finish) denies pending prompts and
  // releases the lock. The promise always settles; errors are logged, not thrown.
  async function stopChat(chat) {
    if (chat.done) return;
    chat.stopping = true;
    try {
      try {
        chat.child.stdin.end();
      } catch {
        // stdin already closed.
      }
      killGroup(chat, 'SIGTERM');
      chat.killTimer = setTimeout(() => killGroup(chat, 'SIGKILL'), KILL_AFTER_MS);
      let cap;
      await Promise.race([
        chat.exited,
        new Promise((resolve) => (cap = setTimeout(resolve, KILL_AFTER_MS + 2000))),
      ]);
      clearTimeout(cap);
      if (!chat.done) finish(chat, null, null); // never leave the lock behind
    } catch (e) {
      log('stop-error', { chatId: chat.id, message: e && e.message });
    }
  }

  // Takes the lock and spawns claude. `message` is the first user message for a new chat.
  // `claudeVersion` is only for the log.
  async function begin({ id, resume, message, claudeVersion }) {
    if (active)
      throw new HttpError(409, 'chat-active', 'A chat is already active here.', {
        chatId: active.id,
      });
    const lock = acquireLock(root, { sessionId: id, port: app.port });
    if (!lock.acquired) {
      if (lock.heldBy === 'self')
        throw new HttpError(409, 'chat-active', 'A chat is already active here.', {
          chatId: lock.sessionId,
        });
      throw new HttpError(
        409,
        'lock-held',
        lock.heldBy
          ? `A chat is active in another Shipline UI on port ${lock.heldBy}; stop it there.`
          : 'A chat is active in another Shipline UI; stop it there.',
        { heldBy: lock.heldBy },
      );
    }
    let child;
    const chat = {
      id,
      resume,
      child: null,
      busy: false,
      sawInit: false,
      stopping: false,
      done: false,
      fatal: null,
      buf: '',
      stderr: Buffer.alloc(0),
      toolNames: new Map(),
      taskDir: null,
      stateWatch: null,
      exitTimer: null,
      killTimer: null,
    };
    chat.exited = new Promise((resolve) => (chat.resolveExited = resolve));
    try {
      const bin = findClaude();
      if (!bin)
        throw new HttpError(412, 'claude-missing', 'Install Claude Code and sign in, then reload.');
      const mcpConfig = app.prompts.writeMcpConfig(id, app.port);
      const argv = buildArgs({ sessionId: id, resume, mcpConfig });
      const env = { ...process.env, SHIPLINE_SESSION: id };
      // UNVERIFIED (chat test Q2): SHIPLINE_SESSION in claude's environment reaches the Bash tool under -p.
      if (MCP_TOOL_TIMEOUT_ENV) env.MCP_TOOL_TIMEOUT = MCP_TOOL_TIMEOUT_ENV;
      log('spawn', { argv, claudeVersion, sessionId: id, resume });
      child = spawn(bin, argv, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      app.prompts.removeMcpConfig(id);
      releaseLock(root, app.port);
      throw e;
    }
    chat.child = child;
    active = chat;

    const now = new Date().toISOString();
    if (resume) updateChat(root, id, { status: 'active', last_active: now });
    else
      addChat(root, {
        id,
        title: message.replace(/\r\n|\r|\n/g, ' ').slice(0, TITLE_LIMIT),
        created: now,
        last_active: now,
        task_dir: null,
        status: 'active',
      });
    const known = getChat(root, id);
    if (known && known.task_dir) chat.taskDir = known.task_dir;

    child.stdin.on('error', (e) => log('stdin-error', { chatId: id, message: e && e.message }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      chat.buf += data;
      let i;
      while ((i = chat.buf.indexOf('\n')) >= 0) {
        const line = chat.buf.slice(0, i);
        chat.buf = chat.buf.slice(i + 1);
        onLine(chat, line);
      }
    });
    child.stderr.on('data', (data) => {
      chat.stderr = Buffer.concat([chat.stderr, data]);
      if (chat.stderr.length > STDERR_TAIL_BYTES)
        chat.stderr = chat.stderr.subarray(-STDERR_TAIL_BYTES);
    });
    child.on('error', (e) => finish(chat, null, null, e && e.message));
    child.on('exit', (code, signal) => {
      // 'close' follows once the pipes drain; don't wait forever if a grandchild holds them open.
      chat.exitTimer = setTimeout(() => finish(chat, code, signal), EXIT_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(chat, code, signal));

    chat.stateWatch = watchState(root, id, () => bindTask(chat));
    if (!resume) writeUser(chat, message);
    return id;
  }

  function writeUser(chat, text) {
    chat.busy = true;
    chat.child.stdin.write(userMessage(text));
  }

  return {
    activeId: () => (active ? active.id : null),

    // New chat; the UI makes the session uuid.
    start({ message, claudeVersion }) {
      return begin({ id: crypto.randomUUID(), resume: false, message, claudeVersion });
    },

    // Existing chat, same uuid, --resume.
    resume({ id, claudeVersion }) {
      return begin({ id, resume: true, claudeVersion });
    },

    send(id, text) {
      const chat = state(id);
      if (!chat) {
        if (getChat(root, id)) throw new HttpError(409, 'chat-ended', 'This chat has ended.');
        throw new HttpError(404, 'not-found', 'No such chat');
      }
      if (chat.stopping || chat.done)
        throw new HttpError(409, 'chat-ended', 'This chat has ended.');
      if (chat.busy)
        throw new HttpError(409, 'busy', 'Claude is still answering the last message.');
      writeUser(chat, text);
    },

    async stop(id) {
      const chat = state(id);
      if (!chat) {
        if (getChat(root, id)) return;
        throw new HttpError(404, 'not-found', 'No such chat');
      }
      await stopChat(chat);
    },

    // Shutdown: stop the claude process group and release the lock.
    async close() {
      if (active) await stopChat(active);
      releaseLock(root, app.port);
    },
  };
}
