// Plan item 17: `init` writes .shipline/bin/VERSION (Goal 1), and the version comparison (src/interface.mjs).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INTERFACE, MISSING_BEFORE, compareInterface, readRepoVersion } from '../src/interface.mjs';
import { BIN, CLI_ROOT, removeDir, run, runInit, tmpDir } from './helpers.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
const dirs = [];
const fresh = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
after(() => dirs.forEach(removeDir));

describe('init writes VERSION', () => {
  test('with the package version and INTERFACE, plus a newline', () => {
    const dir = fresh();
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8');
    assert.equal(text, JSON.stringify({ package: PACKAGE_VERSION, interface: INTERFACE }) + '\n');
    assert.deepEqual(readRepoVersion(dir), { package: PACKAGE_VERSION, interface: INTERFACE });
    assert.equal(INTERFACE, 2);
  });

  test('the success message points at `npx shipline ui`', () => {
    const r = runInit(fresh());
    assert.match(r.stdout, /Or set it up in the browser: `npx shipline ui`\./);
  });

  test('--dry-run lists VERSION and writes nothing', () => {
    const dir = fresh();
    const r = runInit(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}\+ \.shipline\/bin\/VERSION$/m);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('an existing VERSION file counts as a collision and nothing is written', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'mine\n');
    const r = runInit(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^ {2}- \.shipline\/bin\/VERSION$/m);
    assert.equal(readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8'), 'mine\n');
    assert.deepEqual(readdirSync(path.join(dir, '.shipline', 'bin')), ['VERSION']);
    assert.ok(!existsSync(path.join(dir, '.shipline', 'config.yml')));
    assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
  });

  test('a failed preflight (invalid settings.json) writes no VERSION', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ not json');
    const r = runInit(dir);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(path.join(dir, '.shipline')));
  });
});

describe('init write failures', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test('if an earlier write fails, VERSION is never written and init rolls back', { skip: isRoot || process.platform === 'win32' ? 'needs a non-root POSIX user' : false }, () => {
    const dir = fresh();
    const agents = path.join(dir, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    chmodSync(agents, 0o555); // the agent files can't be created
    try {
      const r = runInit(dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /rolled back/);
      assert.ok(!existsSync(path.join(dir, '.shipline', 'bin', 'VERSION')));
      assert.ok(!existsSync(path.join(dir, '.shipline', 'config.yml')));
      assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
      assert.ok(!existsSync(path.join(dir, '.claude', 'settings.json')));
    } finally {
      chmodSync(agents, 0o755);
    }
  });
});

describe('ui on old Node', () => {
  const major = Number(process.versions.node.split('.')[0]);
  test('`shipline ui` exits 1 with a message on Node < 20, without loading the UI code', { skip: major >= 20 ? 'runs on Node 18 (the CI test:hooks job)' : false }, () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    const r = run(process.execPath, [BIN, 'ui', dir, '--no-open'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /shipline ui requires Node 20 or newer/);
  });
});

describe('readRepoVersion', () => {
  test('reports legacy when VERSION is deleted', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    rmSync(path.join(dir, '.shipline', 'bin', 'VERSION'));
    assert.deepEqual(readRepoVersion(dir), { legacy: true, interface: 1 });
  });

  test('reports legacy when VERSION is unreadable or malformed', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    for (const text of ['not json', '{"package":"1.0.0"}', '{"interface":"2"}', 'null', '[]']) {
      writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), text);
      assert.deepEqual(readRepoVersion(dir), { legacy: true, interface: 1 }, text);
    }
  });

  test('a VERSION with no package string still reports its interface', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), '{"interface":3}');
    assert.deepEqual(readRepoVersion(dir), { package: null, interface: 3 });
  });
});

describe('compareInterface', () => {
  test('same', () => {
    assert.equal(compareInterface(2, 2), 'same');
    assert.equal(compareInterface({ package: '0.5.0', interface: 2 }, INTERFACE), 'same');
  });
  test('repo older, including a legacy repo', () => {
    assert.equal(compareInterface(1, 2), 'repo-older');
    assert.equal(compareInterface({ legacy: true, interface: 1 }, { interface: INTERFACE }), 'repo-older');
  });
  test('repo newer', () => {
    assert.equal(compareInterface(3, 2), 'repo-newer');
    assert.equal(compareInterface({ interface: 9 }, INTERFACE), 'repo-newer');
  });
  test('MISSING_BEFORE names what interface-1 repos lack', () => {
    assert.deepEqual(MISSING_BEFORE, ['the lost-task warning', 'visible warn reminders']);
  });
});
