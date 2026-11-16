// Finds the repo the UI serves and loads its own vendored lib.mjs, so parsing always uses the code the
// hooks run. Node 20+, no dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INTERFACE,
  compareInterface,
  isPreOne,
  preOneMessage,
  readRepoVersion,
} from '../interface.mjs';
import { HttpError } from './http.mjs';

// Walks up from `dir` to the first folder with .shipline/config.yml. Unlike findRoot in lib.mjs it
// ignores CLAUDE_PROJECT_DIR.
export function findRepoRoot(dir) {
  let cur = path.resolve(dir || process.cwd());
  for (;;) {
    if (existsSync(path.join(cur, '.shipline', 'config.yml'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// The git root of `dir`, or null when it isn't in a git repository (or git isn't installed). Found as `dir` plus
// git's way up (`--show-cdup`, e.g. '../../'), so the root keeps the caller's spelling of the path: on Windows
// `--show-toplevel` gives the long form of a short (8.3) temp path, which would name the store differently.
export function gitRootOf(dir) {
  try {
    const up = execFileSync('git', ['rev-parse', '--show-cdup'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return path.resolve(dir, up);
  } catch {
    return null;
  }
}

// The realpath of git's common dir for `dir` (`git rev-parse --git-common-dir`), or null outside git. Every worktree
// of one repository has the same value, which is how the project switcher groups them.
export function gitCommonDir(dir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!out) return null;
    const abs = path.resolve(dir, out);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  } catch {
    return null;
  }
}

// The checked-out branch of `root`, read from HEAD without running git (so listing many repos spawns nothing).
// A linked worktree has `.git` as a file pointing at its own git dir. null for a detached HEAD or outside git.
export function gitBranch(root) {
  try {
    const dotGit = path.join(root, '.git');
    if (statSync(dotGit).isDirectory()) return branchFromHead(dotGit);
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? branchFromHead(path.resolve(root, m[1].trim())) : null;
  } catch {
    return null;
  }
}

function branchFromHead(gitDir) {
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Where the install wizard installs: the git root of `dir`, or `dir` itself outside git.
export function installRootFor(dir) {
  return gitRootOf(dir) || path.resolve(dir);
}

// The repo's own vendored lib.mjs (loaded once per path by Node). Used for parseYaml, loadConfig and loadWorkflow.
export function loadRepoLib(root) {
  return import(pathToFileURL(path.join(root, '.shipline', 'bin', 'lib.mjs')).href);
}

// 'pre-1.0' (set up before 1.0: uninstall, then init), or how the repo's interface compares with this UI's.
function versionStateOf(version) {
  return isPreOne(version) ? 'pre-1.0' : compareInterface(version, INTERFACE);
}

// What the UI does with a registered repo, from small files only (no context, no lib import):
// 'ok' (served), 'pre-1.0', 'repo-newer' or 'missing' (the folder or its .shipline/config.yml is gone).
// `message` is the card text for the states that aren't 'ok'.
export function probeRepo(root) {
  if (!existsSync(path.join(root, '.shipline', 'config.yml'))) {
    return { state: 'missing', version: null, message: 'Folder not found' };
  }
  const version = readRepoVersion(root);
  const vs = versionStateOf(version);
  if (vs === 'pre-1.0') return { state: 'pre-1.0', version, message: preOneMessage(version) };
  if (vs === 'repo-newer') {
    const v = version.package || 'latest';
    return {
      state: 'repo-newer',
      version,
      message: `This repo uses Shipline ${v}. Stop this server (Ctrl+C) and run \`npx @forgeyard/shipline@${v} ui\`.`,
    };
  }
  return { state: 'ok', version, message: null };
}

export async function resolveRepo(dir) {
  const root = findRepoRoot(dir);
  if (!root) {
    const e = new Error('No .shipline/config.yml found');
    e.code = 'NO_REPO';
    throw e;
  }
  // Used only for parseYaml and loadConfig.
  const lib = await loadRepoLib(root);
  const version = readRepoVersion(root);
  const state = versionStateOf(version);
  const versionMessage = state === 'pre-1.0' ? preOneMessage(version) : null;

  let current = null;
  const load = () => {
    try {
      current = { cfg: lib.loadConfig(root) };
    } catch (e) {
      current = { cfg: null, error: e.message };
    }
    return current;
  };
  load();

  return {
    root,
    lib,
    version,
    state,
    // The pre-1.0 guidance (the same text `upgrade` refuses with), or null.
    versionMessage,
    // { cfg } or { cfg: null, error }; a config that doesn't parse never stops the server.
    getConfig: () => current,
    reloadConfig: load,
    // Saves, chat start, messages and ! commands: refused for a pre-1.0 repo and for one set up with a newer Shipline.
    requireWritable() {
      if (state === 'pre-1.0') throw new HttpError(423, 'pre-1.0', versionMessage);
      if (state === 'repo-newer') {
        const v = version.package ? `${version.package}` : `interface ${version.interface}`;
        throw new HttpError(
          423,
          'repo-newer',
          `This repo was set up with Shipline ${v}. Run \`npx @forgeyard/shipline@${version.package || 'latest'} ui\`.`,
        );
      }
    },
  };
}
