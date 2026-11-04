// Shared helpers for the CLI tests. Not a test file (no test glob matches it). Node 18+, no dependencies.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(CLI_ROOT, 'bin', 'shipline.mjs');
export const TEMPLATES = path.join(CLI_ROOT, 'templates', 'shipline');
export const FIXTURES = path.join(CLI_ROOT, 'test', 'fixtures');

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

export function run(cmd, args, { cwd, input, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, env: cleanEnv(env), encoding: 'utf8' });
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
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function runInit(dir, ...flags) {
  return run(process.execPath, [BIN, 'init', dir, ...flags], { cwd: dir });
}

// A temporary git repo with one commit, then `shipline init` run through the real bin.
// opts.commitInit: also commit the files init wrote, so `git status` starts clean.
export function makeRepo({ init = true, commitInit = false } = {}) {
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
    const r = runInit(dir);
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
