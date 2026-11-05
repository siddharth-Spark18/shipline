// Teams Phase 1, A: detectCommands(root) reads the files at a repo's root (never runs anything) and gives the test,
// lint and build commands, the first detector with an answer winning per command: Node, Python, Go, Rust, Make.
// Node 18+, no dependencies.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectCommands } from '../src/detect-commands.mjs';
import { removeDir, tmpDir } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeDir));

// A temp repo with { relative path: text } at its root.
function repo(files = {}) {
  const dir = tmpDir('shipline-detect-');
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const pkg = (scripts) => JSON.stringify({ name: 'app', scripts });
const NONE = { test: '', lint: '', build: '', sources: {} };

describe('Node', () => {
  const scripts = { test: 'vitest run', lint: 'eslint .', build: 'tsc -b' };

  for (const [lock, pm] of [[null, 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']]) {
    test(`${lock || 'no lock file'} -> ${pm}`, () => {
      const dir = repo({ 'package.json': pkg(scripts), ...(lock ? { [lock]: '' } : {}) });
      assert.deepEqual(detectCommands(dir), {
        test: `${pm} test`,
        lint: `${pm} run lint`,
        build: `${pm} run build`,
        sources: { test: 'package.json', lint: 'package.json', build: 'package.json' },
      });
    });
  }

  test("npm's placeholder test script is ignored", () => {
    const dir = repo({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' }) });
    const r = detectCommands(dir);
    assert.equal(r.test, '');
    assert.equal(r.lint, 'npm run lint');
    assert.deepEqual(r.sources, { lint: 'package.json' });
  });

  test('typecheck is the build fallback; build wins when both exist', () => {
    assert.equal(detectCommands(repo({ 'package.json': pkg({ typecheck: 'tsc --noEmit' }) })).build, 'npm run typecheck');
    assert.equal(detectCommands(repo({ 'package.json': pkg({ typecheck: 'tsc --noEmit', build: 'vite build' }) })).build, 'npm run build');
  });

  test('a package.json with no scripts gives nothing', () => {
    assert.deepEqual(detectCommands(repo({ 'package.json': '{"name":"x"}' })), NONE);
  });

  test('a broken package.json is skipped quietly; the other detectors still run', () => {
    const dir = repo({ 'package.json': '{ "scripts": { "test": ', Makefile: 'test:\n\tgo test\n' });
    const logged = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
    let r;
    try {
      r = detectCommands(dir);
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
    assert.deepEqual(r, { test: 'make test', lint: '', build: '', sources: { test: 'Makefile' } });
    assert.deepEqual(logged, [], 'nothing is printed');
  });
});

describe('Python', () => {
  test('pyproject.toml with pytest and ruff, no lock: no prefix', () => {
    const dir = repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\nline-length = 100\n' });
    assert.deepEqual(detectCommands(dir), {
      test: 'pytest',
      lint: 'ruff check .',
      build: '',
      sources: { test: 'pyproject.toml', lint: 'pyproject.toml' },
    });
  });

  test('uv.lock gives the `uv run ` prefix, poetry.lock `poetry run `', () => {
    const files = { 'pyproject.toml': 'dev = ["pytest", "ruff"]\n' };
    const uv = detectCommands(repo({ ...files, 'uv.lock': '' }));
    assert.equal(uv.test, 'uv run pytest');
    assert.equal(uv.lint, 'uv run ruff check .');
    const poetry = detectCommands(repo({ ...files, 'poetry.lock': '' }));
    assert.equal(poetry.test, 'poetry run pytest');
    assert.equal(poetry.lint, 'poetry run ruff check .');
  });

  test('ruff is preferred to flake8; flake8 alone is used', () => {
    assert.equal(detectCommands(repo({ 'requirements-dev.txt': 'flake8\nruff\n' })).lint, 'ruff check .');
    const flake = detectCommands(repo({ 'requirements-dev.txt': 'flake8==7.0\npytest\n' }));
    assert.equal(flake.lint, 'flake8');
    assert.equal(flake.test, 'pytest');
    assert.deepEqual(flake.sources, { test: 'requirements-dev.txt', lint: 'requirements-dev.txt' });
  });

  test('setup.cfg and setup.py count; no pytest or linter named means no commands', () => {
    assert.equal(detectCommands(repo({ 'setup.cfg': '[tool:pytest]\n' })).test, 'pytest');
    assert.equal(detectCommands(repo({ 'setup.py': 'tests_require=["pytest"]\n' })).test, 'pytest');
    assert.deepEqual(detectCommands(repo({ 'pyproject.toml': '[project]\nname = "x"\n' })), NONE);
  });
});

describe('Go, Rust and Make', () => {
  test('go.mod', () => {
    assert.deepEqual(detectCommands(repo({ 'go.mod': 'module example.com/x\n' })), {
      test: 'go test ./...',
      lint: 'go vet ./...',
      build: 'go build ./...',
      sources: { test: 'go.mod', lint: 'go.mod', build: 'go.mod' },
    });
  });

  test('Cargo.toml', () => {
    assert.deepEqual(detectCommands(repo({ 'Cargo.toml': '[package]\nname = "x"\n' })), {
      test: 'cargo test',
      lint: 'cargo clippy',
      build: 'cargo build',
      sources: { test: 'Cargo.toml', lint: 'Cargo.toml', build: 'Cargo.toml' },
    });
  });

  test('Make targets are used only when a `<target>:` line exists', () => {
    const r = detectCommands(repo({ Makefile: '.PHONY: test\ntest :\n\tpytest\n\nbuild: deps\n\tcc main.c\n# lint: not a target\n  lint:\n' }));
    assert.deepEqual(r, { test: 'make test', lint: '', build: 'make build', sources: { test: 'Makefile', build: 'Makefile' } });
    assert.deepEqual(detectCommands(repo({ Makefile: 'all:\n\techo hi\n' })), NONE);
  });

  test('a lower-case makefile is read too', () => {
    const r = detectCommands(repo({ makefile: 'lint:\n\techo lint\n' }));
    assert.equal(r.lint, 'make lint');
    assert.equal(r.test, '');
  });
});

describe('precedence and empty repos', () => {
  test('package.json and a Makefile: Node wins for each command it has; Make fills only the rest', () => {
    const dir = repo({ 'package.json': pkg({ test: 'jest' }), 'pnpm-lock.yaml': '', Makefile: 'test:\n\tx\nlint:\n\tx\nbuild:\n\tx\n' });
    assert.deepEqual(detectCommands(dir), {
      test: 'pnpm test',
      lint: 'make lint',
      build: 'make build',
      sources: { test: 'package.json', lint: 'Makefile', build: 'Makefile' },
    });
  });

  test('Python before Go: a repo with both takes pytest from Python and the rest from go.mod', () => {
    const r = detectCommands(repo({ 'requirements.txt': 'pytest\n', 'go.mod': 'module x\n' }));
    assert.equal(r.test, 'pytest');
    assert.equal(r.lint, 'go vet ./...');
    assert.equal(r.build, 'go build ./...');
    assert.deepEqual(r.sources, { test: 'requirements.txt', lint: 'go.mod', build: 'go.mod' });
  });

  test('only files at the root count', () => {
    assert.deepEqual(detectCommands(repo({ [path.join('packages', 'web', 'package.json')]: pkg({ test: 'jest' }) })), NONE);
  });

  test('an empty repo, and a folder that does not exist, give nothing', () => {
    assert.deepEqual(detectCommands(repo()), NONE);
    assert.deepEqual(detectCommands(path.join(repo(), 'missing')), NONE);
  });
});
