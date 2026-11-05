// Teams Phase 2 (docs/plans/shipline-teams-phase2.md), A and Tests: `stage.mjs check` (runs the configured test,
// lint and build commands and records the results in the manifest) and fingerprint(root) in the vendored lib.mjs
// (the git tree id of the working tree, computed with a temporary index). Node 18+, so it stays in test:hooks.
// Every command a test configures runs through the system shell (cmd.exe on Windows), so they are all
// `"<node>" "<script>"` with absolute paths, which both shells read the same way.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IS_WIN, git, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';
import { fingerprint } from '../templates/shipline/bin/lib.mjs';

let dir; // an initialised repo with a task
let scripts; // helper scripts the commands run, outside the repo
const SESSION = 'check-s1';
const SLUG = 'check-task';
let configText;

const NODE = `"${process.execPath}"`;
const script = (name) => `${NODE} "${path.join(scripts, name)}"`;
const manifest = () => JSON.parse(readFileSync(path.join(storeOf(dir), 'tasks', SLUG, 'manifest.json'), 'utf8'));

// Sets config.yml's commands (a missing name is left empty). YAML single quotes: no escapes, '' is a quote.
function setCommands(cmds) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const block = ['test', 'lint', 'build'].map((n) => `  ${n}: ${cmds[n] === undefined ? '""' : q(cmds[n])}`).join('\n');
  const re = /\ncommands:\n(?: {2}[^\n]*\n)*/;
  assert.match(configText, re, 'the config has a commands block');
  const text = configText.replace(re, `\ncommands:\n${block}\n`);
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), text);
}

const check = () => run(process.execPath, [path.join(dir, '.shipline', 'bin', 'stage.mjs'), 'check', '--session', SESSION], { cwd: dir });

before(() => {
  dir = makeRepo({ commitInit: true });
  scripts = tmpDir('shipline-check-scripts-');
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
  const w = (name, body) => writeFileSync(path.join(scripts, name), body);
  w('pass.js', "console.log('all good');\n");
  w('fail3.js', "console.log('checking');\nconsole.error('lint error: no-unused-vars');\nprocess.exit(3);\n");
  w('kill.js', "process.kill(process.pid, 'SIGKILL');\n");
  w('lines.js', "for (let i = 1; i <= 100; i++) console.log('line ' + i);\nprocess.exit(1);\n");
  w('wide.js', "for (let i = 1; i <= 40; i++) console.log(String(i).padStart(3, '0') + 'x'.repeat(196));\nprocess.exit(1);\n");
  const r = stage(dir, ['start', '--workflow', 'small', '--title', SLUG], SESSION);
  assert.equal(r.code, 0, r.stderr);
});
after(() => {
  removeDir(dir);
  removeDir(scripts);
});

describe('stage.mjs check', () => {
  test('pass, fail and a command that did not finish: all run, the summary and failing tails are printed, exit 1', () => {
    // A command that doesn't start can't be made portably through a shell: on Windows the shell itself is missing
    // (ComSpec), elsewhere the command is killed (exec replaces sh, so the signal reaches spawnSync). Both give exit null.
    // On Windows process.env is case-insensitive, so it is set here (children inherit it) rather than passed as a key.
    setCommands({ test: script('pass.js'), lint: script('fail3.js'), build: IS_WIN ? script('pass.js') : `exec ${script('kill.js')}` });
    const saved = process.env.ComSpec;
    if (IS_WIN) process.env.ComSpec = path.join(scripts, 'no-such-shell.exe');
    let r;
    try {
      r = check();
    } finally {
      if (IS_WIN) process.env.ComSpec = saved;
    }
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    const m = manifest();
    const results = m.checks.results;
    assert.deepEqual(results.map((x) => x.name), ['test', 'lint', 'build'], 'all three run, in order, even after a failure');
    for (const x of results) {
      assert.deepEqual(Object.keys(x).sort(), ['command', 'duration_ms', 'exit', 'name', 'tail']);
      assert.equal(typeof x.duration_ms, 'number');
    }
    if (IS_WIN) {
      // Without a shell nothing runs at all.
      assert.deepEqual(results.map((x) => x.exit), [null, null, null]);
      assert.match(r.stdout, /^test ✗ \(did not run\) · lint ✗ \(did not run\) · build ✗ \(did not run\)$/m);
      return;
    }
    assert.deepEqual(results.map((x) => x.exit), [0, 3, null]);
    assert.equal(results[0].command, script('pass.js'));
    assert.equal(results[0].tail, 'all good');
    assert.equal(results[1].tail, 'checking\nlint error: no-unused-vars', 'stdout and stderr are combined');
    assert.match(results[2].tail, /SIGKILL/);
    assert.match(r.stdout, /^Running test: .*pass\.js"$/m);
    assert.match(r.stdout, /^test ✓ \d+\.\ds · lint ✗ \(exit 3\) · build ✗ \(did not run\)$/m);
    assert.match(r.stdout, /^--- lint \(exit 3\) last output ---\nchecking\nlint error: no-unused-vars$/m);
    assert.match(r.stdout, /^--- build \(did not run\) last output ---$/m);
    assert.ok(!r.stdout.includes('--- test'), 'a passing command\'s output is not printed');
    assert.match(r.stdout, new RegExp(`^Fingerprint: ${m.checks.fingerprint.slice(0, 12)}$`, 'm'));
  });

  test('everything passes: exit 0, and the record has the fingerprint of the current code and an ISO time', () => {
    setCommands({ test: script('pass.js'), lint: script('pass.js'), build: script('pass.js') });
    const r = check();
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const { checks } = manifest();
    assert.deepEqual(checks.results.map((x) => x.exit), [0, 0, 0]);
    assert.equal(checks.fingerprint, fingerprint(dir));
    assert.match(checks.fingerprint, /^[0-9a-f]{40}$/);
    assert.equal(new Date(checks.ran_at).toISOString(), checks.ran_at);
    assert.match(r.stdout, /^test ✓ \d+\.\ds · lint ✓ \d+\.\ds · build ✓ \d+\.\ds$/m);
  });

  test('empty commands are skipped', () => {
    setCommands({ test: script('pass.js'), lint: '   ', build: '' });
    const r = check();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(manifest().checks.results.map((x) => x.name), ['test']);
    assert.ok(!r.stdout.includes('lint'), r.stdout);
  });

  test('no commands configured: says so, records an empty run, exit 0', () => {
    setCommands({});
    const r = check();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'No test, lint or build commands are configured in .shipline/config.yml.\n');
    const { checks } = manifest();
    assert.deepEqual(checks.results, []);
    assert.equal(checks.fingerprint, fingerprint(dir));
  });

  test('the tail keeps the last 40 lines', () => {
    setCommands({ test: script('lines.js') });
    assert.equal(check().code, 1);
    const tail = manifest().checks.results[0].tail;
    const want = [];
    for (let i = 61; i <= 100; i++) want.push(`line ${i}`);
    assert.equal(tail, want.join('\n'));
  });

  test('the tail is at most 4 KB, cut from the start', () => {
    setCommands({ test: script('wide.js') });
    assert.equal(check().code, 1);
    const tail = manifest().checks.results[0].tail;
    assert.ok(Buffer.byteLength(tail, 'utf8') <= 4096, String(Buffer.byteLength(tail, 'utf8')));
    assert.ok(Buffer.byteLength(tail, 'utf8') > 4000, 'not cut more than needed');
    assert.ok(tail.endsWith(`040${'x'.repeat(196)}`), 'the end is kept');
    assert.ok(!tail.includes('001x'), 'the start is dropped');
  });

  test('only the latest run is kept', () => {
    setCommands({ test: script('fail3.js'), lint: script('fail3.js') });
    assert.equal(check().code, 1);
    const first = manifest().checks;
    setCommands({ build: script('pass.js') });
    assert.equal(check().code, 0);
    const second = manifest().checks;
    assert.deepEqual(Object.keys(second).sort(), ['fingerprint', 'ran_at', 'results']);
    assert.deepEqual(second.results.map((x) => [x.name, x.exit]), [['build', 0]]);
    assert.ok(Date.parse(second.ran_at) >= Date.parse(first.ran_at));
  });

  test('check writes nothing into the repo', () => {
    setCommands({ test: script('pass.js') });
    const before = git(dir, 'status', '--porcelain', '--untracked-files=all');
    assert.equal(check().code, 0);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), before);
  });
});

describe('fingerprint(root)', () => {
  let repo;
  let tmp; // os.tmpdir() while fingerprint runs, to see that its temp index is removed
  const indexFile = () => path.join(repo, '.git', 'index');
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };
  // fingerprint() with os.tmpdir() pointed at `tmp` (os.tmpdir() reads these on every call).
  const fp = (root = repo) => {
    const keys = ['TMPDIR', 'TMP', 'TEMP'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = tmp;
    try {
      return fingerprint(root);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  };

  before(() => {
    repo = makeRepo({ init: false });
    tmp = tmpDir('shipline-fp-tmp-');
    write('.gitignore', '*.log\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ignore logs');
  });
  after(() => {
    removeDir(repo);
    removeDir(tmp);
  });

  test('a clean checkout: the same id twice, equal to HEAD^{tree}, and the temp index is removed', () => {
    const a = fp();
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.equal(fp(), a);
    assert.equal(a, git(repo, 'rev-parse', 'HEAD^{tree}'));
    assert.deepEqual(readdirSync(tmp), []);
  });

  test('an edit to a tracked file changes it; after committing exactly that code it equals HEAD^{tree}', () => {
    const before = fp();
    write('src/a.js', 'export const a = 2;\n');
    const edited = fp();
    assert.notEqual(edited, before);
    git(repo, 'commit', '-q', '-am', 'edit');
    assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), edited);
    assert.equal(fp(), edited);
  });

  test('a new untracked file changes it; a gitignored one does not', () => {
    const before = fp();
    write('debug.log', 'noise\n');
    write('logs/more.log', 'noise\n');
    assert.equal(fp(), before, 'ignored files are left out');
    write('src/new.js', 'export const n = 1;\n');
    const withNew = fp();
    assert.notEqual(withNew, before);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'new file');
    assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), withNew);
  });

  test('the real index is never touched (byte-equal before and after), with unstaged, staged and untracked changes', () => {
    write('src/a.js', 'export const a = 3;\n');
    write('src/staged.js', 'export const s = 1;\n');
    git(repo, 'add', 'src/staged.js');
    write('src/untracked.js', 'export const u = 1;\n');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all'); // lets git refresh its index first
    const bytes = readFileSync(indexFile());
    const id = fp();
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.ok(readFileSync(indexFile()).equals(bytes), 'the index file is byte-identical');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), status);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'src/staged.js', 'only what the developer staged is staged');
    assert.deepEqual(readdirSync(tmp), []);
  });

  test('null outside a git repository', () => {
    const plain = tmpDir('shipline-fp-plain-');
    try {
      writeFileSync(path.join(plain, 'a.txt'), 'x\n');
      // GIT_CEILING_DIRECTORIES stops git from finding a repository above the temp folder.
      const saved = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
      try {
        assert.equal(fp(plain), null);
      } finally {
        if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = saved;
      }
      assert.deepEqual(readdirSync(tmp), []);
    } finally {
      removeDir(plain);
    }
  });
});
