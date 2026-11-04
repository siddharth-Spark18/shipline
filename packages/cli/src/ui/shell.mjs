// The `!` runner: shell commands typed in the chat composer, run as the developer in the repo root.
// claude -p has no bash mode, so the UI server runs them. Node 20+, no dependencies.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { killProcessTree } from './chat.mjs';
import { log } from './log.mjs';

export const OUTPUT_CAP_BYTES = 1024 * 1024;
const KILL_AFTER_MS = 5000;
const EXIT_GRACE_MS = 1000;

// chatId -> Map(runId -> run)
const runs = new Map();

function track(run) {
  let m = runs.get(run.chatId);
  if (!m) runs.set(run.chatId, (m = new Map()));
  m.set(run.runId, run);
}

function untrack(run) {
  const m = runs.get(run.chatId);
  if (!m) return;
  m.delete(run.runId);
  if (m.size === 0) runs.delete(run.chatId);
}

// Starts `command` in `root`. onEvent gets { chatId, runId, kind: 'start' | 'output' | 'truncated' | 'exit', ... }.
// Returns { runId, stop }; stop() returns false when the run already finished.
export function startShell({ chatId, root, command, onEvent }) {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const emit = (e) => {
    try {
      onEvent({ chatId, runId, ...e });
    } catch (err) {
      log('shell-event-error', { chatId, runId, message: err && err.message });
    }
  };
  const win = process.platform === 'win32';
  let child;
  let spawnError = null;
  try {
    if (win) {
      child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(process.env.SHELL || '/bin/sh', ['-c', command], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // its own process group, so Stop takes the whole tree
      });
    }
  } catch (e) {
    spawnError = e;
  }

  const run = { chatId, runId, child, done: false, killTimer: null, exitTimer: null };
  run.exited = new Promise((resolve) => (run.resolve = resolve));
  log('shell-start', { chatId, runId, command });
  emit({ kind: 'start', command, startedAt: new Date(startedAt).toISOString() });
  track(run);

  let bytes = 0;
  let truncated = false;
  const wire = (stream, name) => {
    const dec = new StringDecoder('utf8'); // invalid bytes become U+FFFD; split characters are kept whole
    stream.on('data', (buf) => {
      if (truncated) return;
      let chunk = buf;
      if (bytes + chunk.length > OUTPUT_CAP_BYTES) {
        chunk = chunk.subarray(0, OUTPUT_CAP_BYTES - bytes);
        truncated = true;
      }
      bytes += chunk.length;
      const data = dec.write(chunk);
      if (data) emit({ kind: 'output', stream: name, data });
      if (truncated) emit({ kind: 'truncated' }); // the process keeps running; the rest is dropped
    });
  };

  function finish(code, signal, error) {
    if (run.done) return;
    run.done = true;
    clearTimeout(run.killTimer);
    clearTimeout(run.exitTimer);
    if (error) emit({ kind: 'output', stream: 'stderr', data: `${error}\n` });
    const durationMs = Date.now() - startedAt;
    log('shell-exit', { chatId, runId, command, code, signal, durationMs });
    untrack(run);
    emit({ kind: 'exit', code: code ?? null, signal: signal ?? null, durationMs });
    run.resolve();
  }

  if (!child) {
    setImmediate(() => finish(null, null, spawnError && spawnError.message));
  } else {
    wire(child.stdout, 'stdout');
    wire(child.stderr, 'stderr');
    child.on('error', (e) => finish(null, null, e && e.message));
    child.on('exit', (code, signal) => {
      // 'close' follows once the pipes drain; don't wait forever if a grandchild holds them open.
      run.exitTimer = setTimeout(() => finish(code, signal), EXIT_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
  }

  const stop = () => {
    if (run.done) return false;
    if (child && child.pid && !run.killTimer) {
      killProcessTree(child.pid, 'SIGTERM', child);
      run.killTimer = setTimeout(() => {
        if (!run.done) killProcessTree(child.pid, 'SIGKILL', child);
      }, KILL_AFTER_MS);
    }
    return true;
  };
  run.stop = stop;
  return { runId, stop };
}

// Stops one run. False when it doesn't exist (anymore) for that chat.
export function stopRun(chatId, runId) {
  const run = runs.get(chatId) && runs.get(chatId).get(runId);
  return run ? run.stop() : false;
}

async function stopRuns(list) {
  for (const r of list) r.stop();
  let cap;
  await Promise.race([
    Promise.all(list.map((r) => r.exited)),
    new Promise((resolve) => (cap = setTimeout(resolve, KILL_AFTER_MS + 2000))),
  ]);
  clearTimeout(cap);
}

// Stops every run of one chat; resolves once they have exited.
export function stopAll(chatId) {
  const m = runs.get(chatId);
  return stopRuns(m ? [...m.values()] : []);
}

// Server shutdown: stops every run of every chat.
export function stopEverything() {
  return stopRuns([...runs.values()].flatMap((m) => [...m.values()]));
}
