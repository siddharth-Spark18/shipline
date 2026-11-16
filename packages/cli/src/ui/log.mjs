// The UI's logs: JSON lines, rotated at 1 MB. One logger per file: the server's own at <shiplineHome>/ui.log, and
// one per loaded repo at <store>/ui/ui.log (outside the repo). Node 20+, no dependencies.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { shiplineHome, uiDir } from '../store.mjs';

const MAX_BYTES = 1024 * 1024;
const SECRET_KEY = /secret|token|cookie/i;

// Replaces the value of any key whose name contains secret, token or cookie.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

// A logger for one file: { file, log(event, data), tail(n) }. The folder is made here; the file on the first line.
export function createLogger(file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Logging must never break the server.
  }
  return {
    file,
    log(event, data = {}) {
      try {
        try {
          if (statSync(file).size >= MAX_BYTES) renameSync(file, `${file}.1`);
        } catch {
          // No log yet.
        }
        appendFileSync(
          file,
          JSON.stringify(redact({ ts: new Date().toISOString(), event, ...data })) + '\n',
        );
      } catch {
        // Logging must never break the server.
      }
    },
    // The last n lines, for the diagnostics view.
    tail(n) {
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
      } catch {
        return [];
      }
    },
  };
}

// The server's own log: <shiplineHome>/ui.log (start, handoff, registry changes, remote on or off, shutdown).
export function serverLogFile() {
  return path.join(shiplineHome(), 'ui.log');
}

// Modules that log without a logger of their own (sessions, shell, trust, tasks) call log() below. It goes to the
// logger of the repo whose request or chat is running (see withLogger), else to the default logger.
const scope = new AsyncLocalStorage();
let fallback = null;

// Runs fn with `logger` as the logger log() writes to, for everything fn starts (requests, chats, watchers).
export function withLogger(logger, fn) {
  return scope.run(logger, fn);
}

export function setDefaultLogger(logger) {
  fallback = logger;
}

// The repo-store log as the default logger, for code that runs without a server (scripts, tests).
export function initLog(root) {
  fallback = createLogger(path.join(uiDir(root), 'ui.log'));
}

export function log(event, data = {}) {
  const logger = scope.getStore() || fallback;
  if (logger) logger.log(event, data);
}

// The last n lines of the current logger.
export function tail(n) {
  const logger = scope.getStore() || fallback;
  return logger ? logger.tail(n) : [];
}
