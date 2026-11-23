// Detects the test, lint and build commands of a repo from the files at its root. Reads files only: it never runs
// a project script or a package manager (it only asks git for the repo root). Node 22+, no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const all = (file) => ({ test: file, lint: file, build: file });

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

const lockfileManager = (dir) => (LOCKFILES.find(([f]) => existsSync(path.join(dir, f))) || [])[1] || null;

// The git work tree root above `dir`, or null outside git (or when git is missing).
function gitToplevel(dir) {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout.trim() ? path.resolve(dir, r.stdout.trim()) : null;
  } catch {
    return null;
  }
}

// The package manager: the target's own lockfile, else (a subfolder of a monorepo) the one at the git root, else npm.
function packageManager(root) {
  const own = lockfileManager(root);
  if (own) return own;
  const top = gitToplevel(root);
  return (top && path.resolve(top) !== path.resolve(root) && lockfileManager(top)) || 'npm';
}

function node(root) {
  const text = read(path.join(root, 'package.json'));
  if (text === null) return null;
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null; // unparsable package.json: skip this detector, quietly
  }
  const scripts = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const has = (name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '';
  const pm = packageManager(root);
  const out = {};
  if (has('test') && !scripts.test.includes('no test specified')) out.test = `${pm} test`;
  if (has('lint')) out.lint = `${pm} run lint`;
  if (has('build')) out.build = `${pm} run build`;
  else if (has('typecheck')) out.build = `${pm} run typecheck`;
  return { files: { test: 'package.json', lint: 'package.json', build: 'package.json' }, commands: out };
}

function python(root) {
  const names = ['pyproject.toml', 'setup.cfg', 'setup.py'];
  try {
    names.push(...readdirSync(root).filter((n) => /^requirements.*\.txt$/.test(n)).sort());
  } catch {
    // Unreadable root: nothing to add.
  }
  const found = names.filter((n) => existsSync(path.join(root, n)));
  if (!found.length) return null;
  const texts = found.map((n) => [n, read(path.join(root, n)) || '']);
  const where = (re) => (texts.find(([, t]) => re.test(t)) || [])[0];
  const prefix = existsSync(path.join(root, 'uv.lock')) ? 'uv run ' : existsSync(path.join(root, 'poetry.lock')) ? 'poetry run ' : '';
  const out = {};
  const files = {};
  const set = (key, re, cmd) => {
    const f = where(re);
    if (f) {
      out[key] = cmd;
      files[key] = f;
    }
    return Boolean(f);
  };
  set('test', /pytest/, `${prefix}pytest`);
  if (!set('lint', /ruff/, `${prefix}ruff check .`)) set('lint', /flake8/, `${prefix}flake8`);
  return { files, commands: out };
}

const go = (root) => (existsSync(path.join(root, 'go.mod')) ? { files: all('go.mod'), commands: { test: 'go test ./...', lint: 'go vet ./...', build: 'go build ./...' } } : null);

const rust = (root) =>
  existsSync(path.join(root, 'Cargo.toml')) ? { files: all('Cargo.toml'), commands: { test: 'cargo test', lint: 'cargo clippy', build: 'cargo build' } } : null;

function make(root) {
  const name = ['Makefile', 'makefile'].find((n) => existsSync(path.join(root, n)));
  if (!name) return null;
  const text = read(path.join(root, name)) || '';
  const out = {};
  for (const target of ['test', 'lint', 'build']) {
    if (new RegExp(`^${target}\\s*:`, 'm').test(text)) out[target] = `make ${target}`;
  }
  return { files: all(name), commands: out };
}

// detectCommands(root) -> { test, lint, build, sources: { test: 'package.json', ... } }
// A command that no detector finds is '' (and has no entry in sources). For each command the first detector with an
// answer wins, in the order Node, Python, Go, Rust, Make.
export function detectCommands(root) {
  const result = { test: '', lint: '', build: '', sources: {} };
  for (const detect of [node, python, go, rust, make]) {
    const found = detect(root);
    if (!found) continue;
    for (const key of ['test', 'lint', 'build']) {
      if (!result[key] && found.commands[key]) {
        result[key] = found.commands[key];
        result.sources[key] = found.files[key];
      }
    }
  }
  return result;
}

// True when `command` (a bare program name such as `pytest`) can be found on PATH. Uses `command -v` on POSIX and
// `where` on Windows; a failed lookup counts as not found.
export function toolOnPath(command) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(command)) return false;
  try {
    const r =
      process.platform === 'win32'
        ? spawnSync('where', [command], { stdio: 'ignore', windowsHide: true })
        : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}
