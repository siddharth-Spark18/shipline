// The UI's own log: JSON lines in <store>/ui/ui.log (outside the repo), rotated at 1 MB.
// Node 20+, no dependencies.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { uiDir } from '../store.mjs';

const MAX_BYTES = 1024 * 1024;
const SECRET_KEY = /secret|token|cookie/i;

let file = null;

export function initLog(root) {
  file = path.join(uiDir(root), 'ui.log');
  mkdirSync(path.dirname(file), { recursive: true });
}

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

export function log(event, data = {}) {
  if (!file) return;
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
}

// The last n lines, for the diagnostics view.
export function tail(n) {
  if (!file) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}
