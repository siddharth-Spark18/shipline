// The chat process manager: one `claude` child per active chat, its lock, stream and stop path.
// Node 20+, no dependencies.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MCP_TOOL_TIMEOUT_ENV, buildArgs, findClaude, startSpec } from './claude.mjs';
import {
  controlRequest,
  modeFromControl,
  parseControlResponse,
  pickContext,
  pickEffort,
  pickModels,
  readDefaults,
  requests,
  writeDefaults,
} from './controls.mjs';
import { HttpError } from './http.mjs';
import { stateDir } from '../store.mjs';
import { log } from './log.mjs';
import { stopAll as stopShells } from './shell.mjs';
import { acquireLock, addChat, getChat, releaseLock, updateChat } from './sessions.mjs';
import {
  KNOWN_TYPES,
  classifyHookMessage,
  guardDenial,
  hookSystemMessage,
  isInit,
  isResult,
  isUsageLimit,
  jiraStatus,
  parseLine,
  userMessage,
} from './stream.mjs';
import { watchState } from './watch.mjs';

const STDERR_TAIL_BYTES = 4096;
const KILL_AFTER_MS = 5000;
const EXIT_GRACE_MS = 1000;
const TITLE_LIMIT = 60;
const ORPHAN_CHECK_MS = 400; // after claude exits: lets processes that handle SIGTERM finish dying
const ORPHAN_POLL_MS = 2000; // while the notice is shown: has the group emptied by itself?
const CONTROL_TIMEOUT_MS = 10_000; // a control_request that gets no control_response
const TRUST_MESSAGE = /this workspace has not been trusted/;
const TRUST_PATH = /projects\["([^"]+)"\]/;
const CONTROL_LABEL = { model: 'model', effort: 'effort', permissionMode: 'mode' };
const CONTROL_KEYS = Object.keys(CONTROL_LABEL);

const pickKeys = (o) => {
  const out = {};
  for (const k of CONTROL_KEYS) if (o && o[k]) out[k] = o[k];
  return out;
};

// Signals a process group (POSIX, the child leads its own group) or tree (Windows). `child` is the fallback handle.
export function killProcessTree(pid, signal, child) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // No process groups on Windows: taskkill /T takes down the whole tree (the shell and the claude under it).
    // The polite stop often needs /F for console-less processes, so a stop usually takes the full 5 s.
    try {
      const args = ['/PID', String(pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const tk = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      tk.on('error', () => {});
      tk.unref();
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      if (child) child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export const resumeCommand = (id) => `claude --resume ${id}`;

// POSIX: does the process group still have members? (EPERM means it has, owned by someone else.)
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

export function createChats(app) {
  const root = app.repo.root;
  let active = null;
  const emit = (payload) => app.hub.send('chat', payload);
  // chatId -> { pgid, poll }: processes left running in a stopped chat's group (POSIX), until killed or gone.
  const orphans = new Map();
  // chatId -> { mcpServers, slashCommands, terminalSlashCommands } from the chat's last system/init. Kept after the
  // chat ends (until the server stops) so the Jira notice and the command list still work.
  const inits = new Map();

  function clearOrphans(chatId, announce) {
    const o = orphans.get(chatId);
    if (!o) return;
    clearInterval(o.poll);
    clearTimeout(o.first);
    orphans.delete(chatId);
    if (announce) emit({ chatId, kind: 'orphans-cleared' });
  }

  // After a Stop: once claude is gone, tell the UI if anything it started still runs in its process group.
  function watchOrphans(chatId, pgid) {
    clearOrphans(chatId, false);
    const o = { pgid, poll: null, first: null };
    orphans.set(chatId, o);
    o.first = setTimeout(() => {
      if (orphans.get(chatId) !== o) return;
      if (!groupAlive(pgid)) {
        orphans.delete(chatId);
        return;
      }
      emit({ chatId, kind: 'orphans', pgid });
      o.poll = setInterval(() => {
        if (!groupAlive(pgid)) clearOrphans(chatId, true);
      }, ORPHAN_POLL_MS);
      o.poll.unref();
    }, ORPHAN_CHECK_MS);
    o.first.unref();
  }

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
    // Control responses answer our own control_requests: never forwarded, never "unknown".
    if (event.type === 'control_response') {
      onControlResponse(chat, event);
      return;
    }
    if (isInit(event)) {
      chat.sawInit = true;
      // Verified 2026-11-05 (claude 2.1.317): system/init reports the session id the UI chose.
      if (event.session_id && event.session_id !== chat.id)
        log('session-id-mismatch', { chatId: chat.id, reported: event.session_id });
      onInit(chat, event);
    }
    if (event.type === 'system' && event.subtype === 'status') onStatus(chat, event);
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
    if (isResult(event)) afterTurn(chat);
  }

  // ---------- chat controls: control_request / control_response ----------

  // Writes one control_request and returns a promise for its control_response's `response` object. Rejects with an
  // Error on an error response, after CONTROL_TIMEOUT_MS, or when the chat has ended.
  function sendControl(chat, request) {
    return new Promise((resolve, reject) => {
      if (chat.done || chat.stopping) return reject(new Error('The chat has ended'));
      const requestId = `shipline-${++chat.controlSeq}`;
      const timer = setTimeout(() => {
        chat.waiters.delete(requestId);
        reject(new Error('No answer from Claude within 10 seconds'));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      chat.waiters.set(requestId, { resolve, reject, timer });
      try {
        chat.child.stdin.write(controlRequest(requestId, request));
      } catch (e) {
        clearTimeout(timer);
        chat.waiters.delete(requestId);
        reject(e);
      }
    });
  }

  function onControlResponse(chat, event) {
    const r = parseControlResponse(event);
    const w = r && chat.waiters.get(r.requestId);
    if (!w) return;
    chat.waiters.delete(r.requestId);
    clearTimeout(w.timer);
    if (r.ok) w.resolve(r.response);
    else w.reject(new Error(r.error));
  }

  function failWaiters(chat) {
    for (const w of chat.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('The chat has ended'));
    }
    chat.waiters.clear();
  }

  const pendingOrNull = (chat) => (Object.keys(chat.pending).length ? { ...chat.pending } : null);

  function emitControls(chat, error) {
    const payload = {
      chatId: chat.id,
      kind: 'controls',
      controls: { ...chat.controls },
      models: chat.models,
      pending: pendingOrNull(chat),
    };
    if (error) payload.error = error;
    emit(payload);
  }

  // What this chat passes to claude on the next start or continue, and the pending changes, on its sessions.json entry.
  function persistControls(chat) {
    const pending = pendingOrNull(chat);
    updateChat(root, chat.id, { controls: { ...chat.picked, ...(pending ? { pending } : {}) } });
  }

  // The picker value for a resolved model id (init and get_settings report ids, the picker uses aliases).
  // Several aliases can resolve to the same id (`default` and `opus`), so the chat's current value wins when it fits.
  function modelValue(chat, reported) {
    const fits = (x) => x.value === reported || x.resolvedModel === reported;
    const current = chat.models.find((x) => x.value === chat.controls.model);
    if (current && fits(current)) return current.value;
    const m = chat.models.find(fits);
    return m ? m.value : reported;
  }

  function setObserved(chat, patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v && chat.controls[k] !== v) {
        chat.controls[k] = v;
        changed = true;
      }
    }
    if (changed) emitControls(chat);
  }

  function onInit(chat, event) {
    inits.set(chat.id, {
      mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
      slashCommands: Array.isArray(event.slash_commands) ? event.slash_commands : [],
      terminalSlashCommands: Array.isArray(event.terminal_slash_commands)
        ? event.terminal_slash_commands
        : [],
    });
    setObserved(chat, {
      model: typeof event.model === 'string' ? modelValue(chat, event.model) : null,
      permissionMode:
        typeof event.permissionMode === 'string' ? modeFromControl(event.permissionMode) : null,
    });
    if (!chat.busy) refreshContext(chat);
  }

  function onStatus(chat, event) {
    if (typeof event.permissionMode === 'string')
      setObserved(chat, { permissionMode: modeFromControl(event.permissionMode) });
  }

  // get_context_usage -> SSE `context`. Never while a turn runs; the next result asks again.
  async function refreshContext(chat) {
    if (chat.busy || chat.done || chat.stopping) return;
    try {
      chat.context = pickContext(await sendControl(chat, requests.getContextUsage()));
      emit({ chatId: chat.id, kind: 'context', context: chat.context });
    } catch (e) {
      log('control-failed', {
        chatId: chat.id,
        what: 'get_context_usage',
        message: e && e.message,
      });
    }
  }

  // At start: the model list and the effort in force. Sent before the first user message of a new chat, never
  // during a turn. Only models[], current_permission_mode, applied.effort and applied.model are kept.
  async function startupControls(chat) {
    const init = sendControl(chat, requests.initialize());
    const settings = sendControl(chat, requests.getSettings());
    const [i, s] = await Promise.allSettled([init, settings]);
    if (i.status === 'fulfilled') {
      const { models, permissionMode } = pickModels(i.value);
      if (models.length) {
        chat.models = models;
        try {
          writeDefaults(root, { models });
        } catch (e) {
          log('controls-write-failed', { message: e && e.message });
        }
      }
      setObserved(chat, { permissionMode });
    } else
      log('control-failed', {
        chatId: chat.id,
        what: 'initialize',
        message: i.reason && i.reason.message,
      });
    if (s.status === 'fulfilled') {
      const { effort, model } = pickEffort(s.value);
      setObserved(chat, { effort, model: model ? modelValue(chat, model) : null });
    } else
      log('control-failed', {
        chatId: chat.id,
        what: 'get_settings',
        message: s.reason && s.reason.message,
      });
    emitControls(chat);
    if (chat.resume && !chat.busy) refreshContext(chat);
  }

  const request = {
    model: (v) => requests.setModel(v),
    effort: (v) => requests.setEffort(v),
    permissionMode: (v) => requests.setPermissionMode(v),
  };

  // Sends one change. On success it becomes the chat's value; on failure the old value stays and the UI gets the error.
  async function applyControl(chat, key, value) {
    try {
      await sendControl(chat, request[key](value));
      chat.controls[key] = value;
      chat.picked[key] = value;
      return true;
    } catch (e) {
      log('control-failed', { chatId: chat.id, what: key, message: e && e.message });
      emitControls(chat, `Couldn't change ${CONTROL_LABEL[key]}: ${e && e.message}`);
      return false;
    }
  }

  // Sends changes one after the other while the chat is idle, then refreshes the context reading.
  async function applyChanges(chat, changes) {
    chat.applying++;
    try {
      let modelChanged = false;
      for (const [key, value] of Object.entries(changes)) {
        const ok = await applyControl(chat, key, value);
        if (ok && key === 'model') modelChanged = true;
      }
      persistControls(chat);
      emitControls(chat);
      return modelChanged;
    } finally {
      chat.applying--;
    }
  }

  // After a turn's result: send what was picked during the turn, then read the context.
  async function afterTurn(chat) {
    if (chat.done || chat.stopping) return;
    const changes = chat.pending;
    chat.pending = {};
    if (Object.keys(changes).length) {
      persistControls(chat); // pending is empty now; applyChanges stores what stuck
      await applyChanges(chat, changes);
    }
    refreshContext(chat);
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
    failWaiters(chat);
    if (chat.stateWatch) chat.stateWatch.close();
    stopShells(chat.id).catch(() => {});
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
    if (chat.stopping && process.platform !== 'win32' && chat.child && chat.child.pid)
      watchOrphans(chat.id, chat.child.pid);
    chat.resolveExited();
  }

  function killGroup(chat, signal) {
    if (!chat.child || !chat.child.pid) return;
    killProcessTree(chat.child.pid, signal, chat.child);
  }

  // Closes stdin, SIGTERM to the process group, SIGKILL after 5 s, then (in finish) denies pending prompts and
  // releases the lock. The promise always settles; errors are logged, not thrown.
  async function stopChat(chat) {
    if (chat.done) return;
    chat.stopping = true;
    stopShells(chat.id).catch(() => {}); // `!` commands end with their chat
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

  // Takes the lock and spawns claude. `message` (and `images`) is the first user message for a new chat.
  // `claudeVersion` is only for the log.
  async function begin({ id, resume, message, images, claudeVersion }) {
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
      controlSeq: 0,
      waiters: new Map(), // request_id -> { resolve, reject, timer }
      applying: 0,
      controls: {}, // what the UI shows: picks plus what claude reported
      picked: {}, // what was chosen: passed as flags on the next start or continue
      pending: {}, // picked during a turn, sent after its result
      models: [],
      context: null,
      trustSent: false,
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
      const defaults = readDefaults(root);
      const entry = resume ? getChat(root, id) : null;
      // A new chat starts with the repo's last picks; a continued one uses its own entry (pending changes included).
      chat.picked = resume
        ? {
            ...pickKeys(entry && entry.controls),
            ...pickKeys(entry && entry.controls && entry.controls.pending),
          }
        : pickKeys(defaults);
      chat.controls = { ...chat.picked };
      chat.models = defaults.models;
      const mcpConfig = app.prompts.writeMcpConfig(id, app.port);
      const argv = buildArgs({ sessionId: id, resume, mcpConfig, controls: chat.picked });
      const env = { ...process.env, SHIPLINE_SESSION: id };
      // Verified 2026-11-05 (claude 2.1.317): Bash sees SHIPLINE_SESSION with the UI's value under -p.
      if (MCP_TOOL_TIMEOUT_ENV) env.MCP_TOOL_TIMEOUT = MCP_TOOL_TIMEOUT_ENV;
      log('spawn', { argv, claudeVersion, sessionId: id, resume });
      const spec = startSpec(bin, argv);
      child = spawn(spec.command, spec.args, {
        cwd: root,
        env,
        detached: process.platform !== 'win32', // POSIX: its own process group, stopped with kill(-pid)
        stdio: ['pipe', 'pipe', 'pipe'],
        ...spec.options,
      });
    } catch (e) {
      app.prompts.removeMcpConfig(id);
      releaseLock(root, app.port);
      throw e;
    }
    chat.child = child;
    active = chat;

    const now = new Date().toISOString();
    if (resume)
      updateChat(root, id, {
        status: 'active',
        last_active: now,
        ...(Object.keys(chat.picked).length ? { controls: { ...chat.picked } } : {}),
      });
    else
      addChat(root, {
        id,
        title: (message.replace(/\r\n|\r|\n/g, ' ').trim() || 'Image').slice(0, TITLE_LIMIT),
        created: now,
        last_active: now,
        task_dir: null,
        status: 'active',
        ...(Object.keys(chat.picked).length ? { controls: { ...chat.picked } } : {}),
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
      checkTrust(chat);
    });
    child.on('error', (e) => finish(chat, null, null, e && e.message));
    child.on('exit', (code, signal) => {
      // 'close' follows once the pipes drain; don't wait forever if a grandchild holds them open.
      chat.exitTimer = setTimeout(() => finish(chat, code, signal), EXIT_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(chat, code, signal));

    chat.stateWatch = watchState(root, id, () => bindTask(chat));
    startupControls(chat).catch((e) =>
      log('control-failed', { chatId: id, what: 'startup', message: e && e.message }),
    );
    if (!resume) writeUser(chat, message, images);
    return id;
  }

  // Claude Code ignores permissions.allow in a repo that was never trusted and says so on stderr. One banner per chat.
  function checkTrust(chat) {
    if (chat.trustSent) return;
    const text = chat.stderr.toString('utf8');
    if (!TRUST_MESSAGE.test(text)) return;
    chat.trustSent = true;
    const m = TRUST_PATH.exec(text);
    const trustPath = m ? m[1] : root;
    log('trust-needed', { chatId: chat.id, path: trustPath });
    app.addBanner({
      id: 'trust',
      kind: 'trust',
      path: trustPath,
      text: "Claude Code ignores this repo's Shipline permission rules until the repo is trusted, so writing task files asks for permission.",
    });
  }

  function writeUser(chat, text, images) {
    chat.busy = true;
    chat.child.stdin.write(userMessage(text, images));
  }

  return {
    activeId: () => (active ? active.id : null),

    // { mcpServers, slashCommands, terminalSlashCommands } from the chat's last system/init, or null.
    initInfo: (id) => inits.get(id) || null,

    // GET /api/chat/controls: the chat's values (running, or from its sessions.json entry), else the repo defaults.
    getControls(id) {
      const defaults = readDefaults(root);
      const chat = id ? state(id) : null;
      if (chat)
        return {
          models: chat.models,
          ...pickKeys(chat.controls),
          context: chat.context,
          pending: pendingOrNull(chat),
        };
      const entry = id ? getChat(root, id) : null;
      if (entry) {
        const c = entry.controls || {};
        const pending = pickKeys(c.pending);
        return {
          models: defaults.models,
          ...pickKeys(defaults),
          ...pickKeys(c),
          context: null,
          pending: Object.keys(pending).length ? pending : null,
        };
      }
      return { models: defaults.models, ...pickKeys(defaults), context: null, pending: null };
    },

    // POST /api/chat/controls. `patch` is already validated. The repo defaults always take it. Returns
    // { controls, applied: 'now' | 'after-turn' | 'next-start' }.
    setControls(id, patch) {
      writeDefaults(root, patch);
      const chat = id ? state(id) : null;
      const usable = chat && !chat.stopping && !chat.done;
      if (usable && !chat.busy && chat.applying === 0) {
        applyChanges(chat, patch).then((modelChanged) => {
          if (modelChanged) refreshContext(chat);
        });
        return { controls: { ...chat.controls, ...patch }, applied: 'now' };
      }
      if (usable) {
        chat.pending = { ...chat.pending, ...patch }; // only the last value of each control is sent
        persistControls(chat);
        emitControls(chat);
        return { controls: { ...chat.controls }, applied: 'after-turn' };
      }
      if (id) {
        const entry = getChat(root, id);
        if (!entry) throw new HttpError(404, 'not-found', 'No such chat');
        const { pending, ...picks } = entry.controls || {};
        const rest = { ...pickKeys(pending) };
        for (const k of Object.keys(patch)) delete rest[k]; // the new pick wins over an older pending one
        updateChat(root, id, {
          controls: { ...picks, ...patch, ...(Object.keys(rest).length ? { pending: rest } : {}) },
        });
        return {
          controls: { ...pickKeys(readDefaults(root)), ...pickKeys(picks), ...patch },
          applied: 'next-start',
        };
      }
      return { controls: pickKeys(readDefaults(root)), applied: 'next-start' };
    },

    // New chat; the UI makes the session uuid.
    start({ message, images, claudeVersion }) {
      return begin({ id: crypto.randomUUID(), resume: false, message, images, claudeVersion });
    },

    // Existing chat, same uuid, --resume.
    resume({ id, claudeVersion }) {
      return begin({ id, resume: true, claudeVersion });
    },

    send(id, text, images) {
      const chat = state(id);
      if (!chat) {
        if (getChat(root, id)) throw new HttpError(409, 'chat-ended', 'This chat has ended.');
        throw new HttpError(404, 'not-found', 'No such chat');
      }
      if (chat.stopping || chat.done)
        throw new HttpError(409, 'chat-ended', 'This chat has ended.');
      if (chat.busy || chat.applying > 0)
        throw new HttpError(409, 'busy', 'Claude is still answering the last message.');
      writeUser(chat, text, images);
    },

    async stop(id) {
      const chat = state(id);
      if (!chat) {
        if (getChat(root, id)) return;
        throw new HttpError(404, 'not-found', 'No such chat');
      }
      await stopChat(chat);
    },

    // SIGKILLs what a stopped chat left running (POSIX). false when nothing is left; the notice is cleared either way.
    killOrphans(chatId) {
      const o = orphans.get(chatId);
      if (!o) return false;
      const alive = groupAlive(o.pgid);
      if (alive) killProcessTree(o.pgid, 'SIGKILL');
      clearOrphans(chatId, true);
      return alive;
    },

    // Shutdown: stop the claude process group and release the lock.
    async close() {
      for (const id of [...orphans.keys()]) clearOrphans(id, false); // left running: the developer decides
      if (active) await stopChat(active);
      releaseLock(root, app.port);
    },
  };
}
