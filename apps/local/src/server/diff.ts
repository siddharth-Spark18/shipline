import fs from 'fs';
import path from 'path';
import {
  DiffFileDTO,
  DiffFileDetailDTO,
  DiffFileStatus,
  DiffMode,
  DiffSummaryDTO,
  parseUnifiedDiff,
} from '@shipline/shared';
import { git, gitOk, gitRun } from './git';

/** Per-file line cap for the unified diff; `full=1` lifts it. */
const MAX_PATCH_LINES = 1500;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * Branch mode compares the working tree with the merge-base of the project base branch and HEAD
 * (committed + uncommitted work). Uncommitted mode compares it with HEAD.
 */
async function resolveRef(worktree: string, baseBranch: string, mode: DiffMode): Promise<string> {
  if (mode === 'uncommitted') return 'HEAD';
  const baseRef = (await gitOk(worktree, ['rev-parse', '--verify', `origin/${baseBranch}`])) ? `origin/${baseBranch}` : baseBranch;
  return git(worktree, ['merge-base', baseRef, 'HEAD']);
}

interface Numstat {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstatZ(out: string): Numstat[] {
  const tokens = out.split('\0');
  const rows: Numstat[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    const binary = m[1] === '-';
    const base = { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '') {
      // Rename: the next two tokens are old and new path.
      const oldPath = tokens[i++];
      rows.push({ ...base, path: tokens[i++], oldPath });
    } else {
      rows.push({ ...base, path: m[3], oldPath: null });
    }
  }
  return rows;
}

function parseNameStatusZ(out: string): Map<string, DiffFileStatus> {
  const tokens = out.split('\0');
  const map = new Map<string, DiffFileStatus>();
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      i++; // old path
      map.set(tokens[i++], code[0] === 'R' ? 'renamed' : 'added');
    } else {
      const file = tokens[i++];
      map.set(file, code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified');
    }
  }
  return map;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function untrackedFiles(worktree: string): Promise<DiffFileDTO[]> {
  const out = (await gitRun(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
  const files: DiffFileDTO[] = [];
  for (const rel of out.split('\0').filter(Boolean)) {
    let additions = 0;
    let binary = false;
    try {
      const abs = path.join(worktree, rel);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_UNTRACKED_BYTES) {
        const buf = fs.readFileSync(abs);
        binary = looksBinary(buf);
        if (!binary) additions = buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0);
      } else if (stat.isFile()) {
        binary = true; // too large to count; listed without hunks
      }
    } catch {
      continue;
    }
    files.push({ path: rel, oldPath: null, status: 'added', additions, deletions: 0, binary });
  }
  return files;
}

export async function diffSummary(worktree: string, baseBranch: string, mode: DiffMode): Promise<DiffSummaryDTO> {
  const ref = await resolveRef(worktree, baseBranch, mode);
  const [numstat, nameStatus, untracked] = await Promise.all([
    gitRun(worktree, ['diff', '--no-color', '-M', '--numstat', '-z', ref]),
    gitRun(worktree, ['diff', '--no-color', '-M', '--name-status', '-z', ref]),
    untrackedFiles(worktree),
  ]);
  const statuses = parseNameStatusZ(nameStatus.stdout);
  const tracked: DiffFileDTO[] = parseNumstatZ(numstat.stdout).map((n) => ({
    path: n.path,
    oldPath: n.oldPath,
    status: statuses.get(n.path) ?? 'modified',
    additions: n.additions,
    deletions: n.deletions,
    binary: n.binary,
  }));
  const files = [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
  return {
    mode,
    base: ref,
    baseBranch,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

export async function diffFile(
  worktree: string,
  baseBranch: string,
  mode: DiffMode,
  filePath: string,
  oldPath: string | null,
  full: boolean,
): Promise<DiffFileDetailDTO> {
  const ref = await resolveRef(worktree, baseBranch, mode);
  const pathspec = oldPath ? [oldPath, filePath] : [filePath];
  let patch = (await gitRun(worktree, ['diff', '--no-color', '-M', ref, '--', ...pathspec])).stdout;
  if (!patch) {
    // Untracked files are not part of `git diff <ref>`: diff them against nothing.
    const abs = path.resolve(worktree, filePath);
    const inside = path.relative(worktree, abs);
    if (!inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(abs)) {
      patch = (await gitRun(worktree, ['diff', '--no-color', '--no-index', '--', '/dev/null', filePath], [0, 1])).stdout;
    }
  }
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) {
    return { path: filePath, binary: true, hunks: [], truncated: false, totalLines: 0 };
  }
  const lines = patch.split('\n');
  const truncated = !full && lines.length > MAX_PATCH_LINES;
  const shown = truncated ? lines.slice(0, MAX_PATCH_LINES).join('\n') : patch;
  return { path: filePath, binary: false, hunks: parseUnifiedDiff(shown), truncated, totalLines: lines.length };
}
