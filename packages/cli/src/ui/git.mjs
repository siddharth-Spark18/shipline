// git helpers and diff parsing. Copied from apps/local/src/server/git.ts and diff.ts, plus
// parseUnifiedDiff from packages/shared/src/local.ts. Node 20+, no dependencies.
import { execFile } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MAX_PATCH_LINES = 3000;

// Runs the user's own `git`. Resolves with the exit code instead of rejecting for codes in `okCodes`
// (for example `git diff --no-index` exits 1 when files differ).
export function gitRun(cwd, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: String(stdout), code: 0 });
        const code = typeof err.code === 'number' ? err.code : -1;
        if (okCodes.includes(code)) return resolve({ stdout: String(stdout), code });
        reject(new Error(String(stderr).trim() || err.message));
      },
    );
  });
}

// stdout of a git command, trimmed.
export async function git(cwd, args) {
  return (await gitRun(cwd, args)).stdout.trim();
}

export async function gitOk(cwd, args) {
  try {
    await gitRun(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

// Pure parser for the body of `git diff` output of ONE file (everything from the first `@@`).
// Lines before the first hunk (headers) are ignored.
export function parseUnifiedDiff(patch) {
  const hunks = [];
  let current = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+'))
      current.lines.push({ type: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw.startsWith('-'))
      current.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw.startsWith(' '))
      current.lines.push({ type: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return hunks;
}

function headBytes(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    return buf.subarray(0, readSync(fd, buf, 0, 8000, 0));
  } finally {
    closeSync(fd);
  }
}

// The diff of one `git status` entry ({ path, oldPath?, index, worktree }): { hunks, truncated? } or
// { binary: true }. `absPath` is the resolved real path of an untracked file (read only to detect binary).
export async function fileDiff(root, change, absPath) {
  const untracked = change.index === '?' && change.worktree === '?';
  let patch;
  if (untracked) {
    if (absPath && looksBinary(headBytes(absPath))) return { binary: true };
    patch = (
      await gitRun(
        root,
        ['diff', '--no-color', '--no-index', '--', '/dev/null', change.path],
        [0, 1],
      )
    ).stdout;
  } else {
    const pathspec = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const hasCommits = await gitOk(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const args = hasCommits
      ? ['diff', '--no-color', '-M', 'HEAD', '--', ...pathspec]
      : ['diff', '--no-color', '--cached', '--', ...pathspec];
    patch = (await gitRun(root, args)).stdout;
  }
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch))
    return { binary: true };
  const lines = patch.split('\n');
  const truncated = lines.length > MAX_PATCH_LINES;
  const hunks = parseUnifiedDiff(truncated ? lines.slice(0, MAX_PATCH_LINES).join('\n') : patch);
  return truncated ? { hunks, truncated: true } : { hunks };
}

// Diffs two strings through two temporary files in .shipline/.state/ui/tmp/. Removed lines whose
// trimmed text starts with `#` are marked `comment: true`.
export async function textDiff(root, a, b) {
  const base = path.join(root, '.shipline', '.state', 'ui', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'diff-'));
  try {
    const fa = path.join(dir, 'a');
    const fb = path.join(dir, 'b');
    writeFileSync(fa, a);
    writeFileSync(fb, b);
    const { stdout } = await gitRun(
      root,
      ['diff', '--no-index', '--no-color', '-U3', '--', fa, fb],
      [0, 1],
    );
    const hunks = parseUnifiedDiff(stdout);
    for (const h of hunks) {
      for (const l of h.lines)
        if (l.type === 'del' && l.text.trim().startsWith('#')) l.comment = true;
    }
    return hunks;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
