// Shared helpers for the CLI tests. Not a test file (no test glob matches it). Node 18+, no dependencies.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePath } from '../templates/shipline/bin/lib.mjs';

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(CLI_ROOT, 'bin', 'shipline.mjs');
export const TEMPLATES = path.join(CLI_ROOT, 'templates', 'shipline');
export const FIXTURES = path.join(CLI_ROOT, 'test', 'fixtures');

// The task store lives outside the repo ($SHIPLINE_HOME, default ~/.shipline). Tests must never touch the
// real one, so this process (and the in-process UI server, store.mjs imports) gets its own temp home as a
// safety net, removed on exit; and every temp dir from tmpDir() gets its own SHIPLINE_HOME, removed with it.
const PROCESS_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shipline-home-proc-')));
process.env.SHIPLINE_HOME = PROCESS_HOME;
process.on('exit', () => rmSync(PROCESS_HOME, { recursive: true, force: true }));

const HOMES = new Map(); // temp dir -> its SHIPLINE_HOME

// The SHIPLINE_HOME of the temp dir that contains `dir` (or the process-wide one).
export function homeFor(dir) {
  if (dir) {
    let d = path.resolve(dir);
    for (;;) {
      if (HOMES.has(d)) return HOMES.get(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return PROCESS_HOME;
}

// The store folder of a repo: <its SHIPLINE_HOME>/projects/<encoded realpath>.
export function storeOf(dir) {
  return path.join(homeFor(dir), 'projects', encodePath(realpathSync(dir)));
}

// The hooks' findRoot honours CLAUDE_PROJECT_DIR and stage.mjs reads SHIPLINE_SESSION; when these tests
// run inside a Claude Code session those would point at the wrong repo, so children never inherit them.
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['CLAUDE_PROJECT_DIR', 'SHIPLINE_SESSION', 'CLAUDE_ENV_FILE', 'SHIPLINE_UI_DEV_ORIGIN']) {
    if (!(k in extra)) delete env[k];
  }
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Shipline Test';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'test@example.com';
  return env;
}

// Children run with the SHIPLINE_HOME of the temp dir they run in, unless env sets one.
export function run(cmd, args, { cwd, input, env } = {}) {
  const e = { SHIPLINE_HOME: homeFor(cwd), ...env };
  const r = spawnSync(cmd, args, { cwd, input, env: cleanEnv(e), encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function git(cwd, ...args) {
  const r = run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function tmpDir(prefix = 'shipline-test-') {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  HOMES.set(dir, realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shipline-home-'))));
  return dir;
}

// Removes a dir; for a tmpDir() dir, its SHIPLINE_HOME too.
export function removeDir(dir) {
  if (!dir) return;
  // Windows refuses to delete a folder a process still has open (a watcher closing, git, a relay child
  // still exiting): retry briefly, and on Windows leave a stubborn temp folder to the OS rather than fail
  // the test file from an after() hook. Elsewhere a failure here is a real leak and still throws.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    console.error(`removeDir: left ${dir} behind (${e.code}); Windows still has it open`);
  }
  if (HOMES.has(dir)) {
    const home = HOMES.get(dir);
    // A late write by a closing in-process server then lands in the process home (removed on exit), not here.
    if (process.env.SHIPLINE_HOME === home) process.env.SHIPLINE_HOME = PROCESS_HOME;
    rmSync(home, { recursive: true, force: true });
    HOMES.delete(dir);
  }
}

// `shipline init` through the real bin. The children have no terminal, and init refuses to ask questions without
// one, so --yes (install the defaults) is passed unless the flags start with { yes: false }.
export function runInit(dir, ...flags) {
  let yes = true;
  if (flags.length && typeof flags[0] === 'object' && flags[0] !== null) yes = flags.shift().yes !== false;
  return run(process.execPath, [BIN, 'init', dir, ...(yes ? ['--yes'] : []), ...flags], { cwd: dir });
}

// `shipline init` with everything chosen (every workflow with its UI stages, every agent, the standalone
// `reviewer` too): test/fixtures/init-all.mjs, which runs init's own code with the questions answered.
// Since 0.12.0 `init --yes` installs only what the chosen workflows use, so this is the full install.
// With a selection, init gets those answers instead (it fills what they leave out).
export function runInitAll(dir, selection = null) {
  const args = [path.join(FIXTURES, 'init-all.mjs'), dir, ...(selection ? [JSON.stringify(selection)] : [])];
  return run(process.execPath, args, { cwd: dir });
}

// A temporary git repo with one commit, then `shipline init` with everything chosen (runInitAll), or with
// opts.yes the real bin's `init --yes` (trimmed to what the workflows use, and to no UI stages here).
// opts.commitInit: also commit the files init wrote, so `git status` starts clean.
export function makeRepo({ init = true, commitInit = false, yes = false } = {}) {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Shipline Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  if (init) {
    const r = yes ? runInit(dir) : runInitAll(dir);
    if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
    if (commitInit) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'shipline init');
    }
  }
  return dir;
}

export function stage(dir, args, session) {
  return run(process.execPath, [path.join(dir, '.shipline', 'bin', 'stage.mjs'), ...args, ...(session ? ['--session', session] : [])], {
    cwd: dir,
  });
}

// Runs a vendored hook script with a JSON payload on stdin. Returns { code, stdout, json }.
export function hook(dir, script, payload) {
  const r = run(process.execPath, [path.join(dir, '.shipline', 'bin', script)], { cwd: dir, input: JSON.stringify(payload) });
  let json = null;
  if (r.stdout.trim()) json = JSON.parse(r.stdout);
  return { ...r, json };
}

// ---------- Windows ----------

export const IS_WIN = process.platform === 'win32';
export const FAKE_CLAUDE_MJS = path.join(FIXTURES, 'fake-claude.mjs');

// Writes a .cmd shim that runs `script` with node, and returns the shim's path. Windows ignores shebang lines
// and can't start a .mjs directly, so the chat tests start the fake `claude` through one (cleanup plan, C).
export function writeCmdShim(shim, script) {
  writeFileSync(shim, `@node "${script}" %*\r\n`);
  return shim;
}

// What SHIPLINE_CLAUDE_BIN points at: test/fixtures/fake-claude.mjs, or on Windows the fake-claude.cmd shim
// written next to it (`@node "%~dp0fake-claude.mjs" %*`; gitignored).
export function fakeClaudeBin() {
  if (!IS_WIN) return FAKE_CLAUDE_MJS;
  const shim = path.join(FIXTURES, 'fake-claude.cmd');
  writeFileSync(shim, '@node "%~dp0fake-claude.mjs" %*\r\n');
  return shim;
}

// Windows: { pid: image name } of every running process, from `tasklist` (no `ps` there).
export function tasklist() {
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const procs = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) procs.set(Number(m[2]), m[1]);
  }
  return procs;
}

// The pids in `pids` that are still running: `tasklist` on Windows, signal 0 elsewhere.
export function livePids(pids) {
  const wanted = pids.filter(Boolean);
  if (IS_WIN) {
    const procs = tasklist();
    return wanted.filter((pid) => procs.has(pid));
  }
  return wanted.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  });
}
