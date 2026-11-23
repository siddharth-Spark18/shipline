// Plan E, E4: `shipline relink --from <old path>` gives a moved repo the store of its old path.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodePath } from '../src/store.mjs';
import { BIN, homeFor, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';

const dirs = [];
const keep = (d) => (dirs.push(d), d);
after(() => dirs.forEach(removeDir));

const relink = (dir, ...args) => run(process.execPath, [BIN, 'relink', '--dir', dir, ...args], { cwd: dir });
const registry = (home) => JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8')).projects;

// An installed repo with one task, then moved to a new folder inside the same temp dir (so both share a SHIPLINE_HOME).
function movedRepo() {
  const repo = keep(makeRepo({ commitInit: true }));
  assert.equal(stage(repo, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 's1').code, 0);
  const oldStore = storeOf(repo);
  const home = homeFor(repo);
  const parent = keep(tmpDir());
  const moved = path.join(parent, 'moved');
  renameSync(repo, moved);
  // Both folders must share one SHIPLINE_HOME: a temp dir has its own, so point the commands at the old one explicitly.
  return { oldPath: repo, moved, oldStore, home };
}

const rl = (moved, home, ...args) => run(process.execPath, [BIN, 'relink', '--dir', moved, ...args], { cwd: moved, env: { SHIPLINE_HOME: home } });

describe('shipline relink', () => {
  test('moves the old store to the new path\'s key, updates repo.json and the registry, keeps the tasks', () => {
    const { oldPath, moved, oldStore, home } = movedRepo();
    assert.ok(existsSync(path.join(oldStore, 'tasks', 'fix-crash')));
    const r = rl(moved, home, '--from', oldPath);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(oldStore));
    const projects = path.join(home, 'projects');
    const stores = readdirSync(projects);
    assert.equal(stores.length, 1, stores.join(', '));
    const meta = JSON.parse(readFileSync(path.join(projects, stores[0], 'repo.json'), 'utf8'));
    assert.equal(meta.root, moved);
    assert.equal(meta.key_version, 2);
    assert.ok(existsSync(path.join(projects, stores[0], 'tasks', 'fix-crash', 'manifest.json')));
    const status = run(process.execPath, [path.join(moved, '.shipline', 'bin', 'stage.mjs'), 'status', '--all'], { cwd: moved, env: { SHIPLINE_HOME: home } });
    assert.match(status.stdout, /fix-crash/);
    assert.ok(registry(home).some((p) => p.root === meta.root));
  });

  test('--dry-run says what it would move and changes nothing', () => {
    const { oldPath, moved, oldStore, home } = movedRepo();
    const r = rl(moved, home, '--from', oldPath, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Would move the task store of/);
    assert.ok(existsSync(oldStore));
  });

  test('refuses when the old folder still exists', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const other = keep(makeRepo({ commitInit: true }));
    const r = relink(other, '--from', repo);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /still exists/);
  });

  test('refuses when no store belongs to the old path', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const r = relink(repo, '--from', path.join(keep(tmpDir()), 'never-was'));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no task store belongs to/);
  });

  test('refuses when this repo\'s store already has tasks', () => {
    const { oldPath, moved, oldStore, home } = movedRepo();
    assert.equal(run(process.execPath, [path.join(moved, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'bugfix', '--title', 'Newer', '--session', 's9'], { cwd: moved, env: { SHIPLINE_HOME: home } }).code, 0);
    const r = rl(moved, home, '--from', oldPath);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already has 1 task/);
    assert.ok(existsSync(oldStore));
  });

  test('an empty store that init-style access created at the new key is replaced', () => {
    const { oldPath, moved, home } = movedRepo();
    // Opening the new location first (as any hook would) leaves an empty store there.
    run(process.execPath, [path.join(moved, '.shipline', 'bin', 'stage.mjs'), 'status'], { cwd: moved, env: { SHIPLINE_HOME: home } });
    assert.equal(readdirSync(path.join(home, 'projects')).length, 2);
    const r = rl(moved, home, '--from', oldPath);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readdirSync(path.join(home, 'projects')).length, 1);
  });

  test('a moved repo still on interface 1 gets its store at the old-style key', () => {
    const repo = keep(tmpDir());
    const home = homeFor(repo);
    const v = (dir) => {
      mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
      writeFileSync(path.join(dir, '.shipline', 'config.yml'), '');
      writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify({ package: '2.1.0', interface: 1, files: {}, excluded: [] }));
    };
    const old = path.join(repo, 'old-place');
    const store = path.join(home, 'projects', encodePath(old));
    mkdirSync(path.join(store, 'tasks', 't'), { recursive: true });
    writeFileSync(path.join(store, 'repo.json'), JSON.stringify({ root: old }));
    const moved = path.join(repo, 'new-place');
    v(moved);
    const r = rl(moved, home, '--from', old);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(path.join(home, 'projects', encodePath(moved), 'tasks', 't')));
    const meta = JSON.parse(readFileSync(path.join(home, 'projects', encodePath(moved), 'repo.json'), 'utf8'));
    assert.equal(meta.root, moved);
    assert.equal(meta.key_version, undefined);
  });

  test('needs --from', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    assert.equal(relink(repo).code, 2);
  });
});
