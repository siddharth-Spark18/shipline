// Detects the test, lint and build commands of a repo from the files at its root. Reads files only: it never runs
// a project script or a package manager. Node 18+, no dependencies.
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
  const pm = existsSync(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))
        ? 'bun'
        : 'npm';
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
