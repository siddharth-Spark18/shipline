// Workspace trust: sets projects["<repo path>"].hasTrustDialogAccepted = true in Claude Code's ~/.claude.json,
// and nothing else. Never logs or returns the file's contents. Node 20+, no dependencies.
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameRoot } from '../store.mjs';
import { HttpError } from './http.mjs';
import { log } from './log.mjs';

// Where Claude keeps its config: when CLAUDE_CONFIG_DIR is set, its own `.claude.json` or the one in its parent
// folder (whichever exists); otherwise ~/.claude.json. `opts.home` and `opts.env` exist for tests.
export function claudeConfigFile(opts = {}) {
  const home = opts.home || os.homedir();
  const dir = (opts.env || process.env).CLAUDE_CONFIG_DIR;
  const fallback = path.join(home, '.claude.json');
  if (!dir) return fallback;
  for (const f of [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')])
    if (existsSync(f)) return f;
  return fallback;
}

// Same-folder temp file with the original's mode (chmod too, so the umask can't change it), then rename.
// Not sessions.mjs's writeAtomic: that one doesn't keep the mode.
function writeKeepingMode(file, text, mode) {
  const tmp = `${file}.${process.pid}.shipline.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to remove.
    }
    throw e;
  }
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

// `trustPath` must resolve to the repo root; it is used exactly as given, since that is the key Claude reads.
// Returns { trusted: true, takesEffect: 'next chat' }.
export function trustRepo(root, trustPath, opts = {}) {
  const rootReal = real(root);
  const given =
    typeof trustPath === 'string' && path.isAbsolute(trustPath) ? real(trustPath) : null;
  if (!rootReal || !given || !sameRoot(given, rootReal)) {
    log('trust', { path: trustPath, outcome: 'bad-path' });
    throw new HttpError(400, 'bad-path', "That path isn't this repo.");
  }
  const file = claudeConfigFile(opts);
  if (!existsSync(file)) {
    log('trust', { path: trustPath, outcome: 'config-missing' });
    throw new HttpError(
      409,
      'claude-config-missing',
      'Claude Code has no ~/.claude.json yet: open Claude Code once, then try again.',
    );
  }
  // Read as late as possible: a running claude may have written the file since the page loaded.
  let json;
  let mode;
  try {
    mode = statSync(file).mode & 0o777;
    json = JSON.parse(readFileSync(file, 'utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
  } catch {
    log('trust', { path: trustPath, outcome: 'config-unreadable' });
    throw new HttpError(
      500,
      'claude-config-unreadable',
      "~/.claude.json couldn't be read as JSON, so nothing was changed.",
    );
  }
  if (!json.projects || typeof json.projects !== 'object' || Array.isArray(json.projects))
    json.projects = {};
  const entry = json.projects[trustPath];
  json.projects[trustPath] = {
    ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}),
    hasTrustDialogAccepted: true,
  };
  try {
    writeKeepingMode(file, JSON.stringify(json, null, 2) + '\n', mode);
  } catch {
    log('trust', { path: trustPath, outcome: 'write-failed' });
    throw new HttpError(500, 'claude-config-unwritable', "~/.claude.json couldn't be written.");
  }
  log('trust', { path: trustPath, outcome: 'trusted' });
  return { trusted: true, takesEffect: 'next chat' };
}
