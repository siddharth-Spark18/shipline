// Plan E, E3: `shipline prune` removes the stores of repos that are gone (and old migration backups), keeps a store a
// registered worktree still uses, and never touches a store whose repo folder still exists (with or without Shipline).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectId } from '../src/registry.mjs';
import { BIN, git, homeFor, makeRepo, removeDir, run, storeOf, tmpDir } from './helpers.mjs';

const dirs = [];
const keep = (d) => (dirs.push(d), d);
after(() => dirs.forEach(removeDir));

const prune = (home, ...args) => run(process.execPath, [BIN, 'prune', ...args], { cwd: home, env: { SHIPLINE_HOME: home } });

// A store folder in `home` for a repo at `root` (which may not exist), with n task folders.
function plant(home, name, root, tasks = 1) {
  const dir = path.join(home, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'repo.json'), JSON.stringify({ root }));
  for (let i = 0; i < tasks; i++) mkdirSync(path.join(dir, 'tasks', `t${i}`), { recursive: true });
  return dir;
}

describe('shipline prune', () => {
  test('nothing to prune: says so, exit 0', () => {
    const home = keep(tmpDir());
    const r = prune(homeFor(home));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nothing to prune\./);
  });

  test('a repo that still exists but no longer has Shipline (after uninstall) keeps its store', () => {
    const home = homeFor(keep(tmpDir()));
    const repo = keep(tmpDir()); // exists, no .shipline/config.yml
    const kept = plant(home, 'uninstalled-store', repo, 3);
    const r = prune(home, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nothing to prune\./);
    assert.ok(existsSync(kept));
  });

  test('--dry-run lists a gone repo\'s store with its task count and removes nothing', () => {
    const home = homeFor(keep(tmpDir()));
    const gone = plant(home, 'gone-store', '/no/such/repo', 2);
    const r = prune(home, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /gone-store/);
    assert.match(r.stdout, /repo folder is gone: \/no\/such\/repo; 2 tasks/);
    assert.ok(existsSync(gone));
  });

  test('without a terminal and without --yes it behaves as a dry run and says so', () => {
    const home = homeFor(keep(tmpDir()));
    const gone = plant(home, 'gone-store', '/no/such/repo');
    const r = prune(home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Not a terminal and no --yes, so this was a dry run/);
    assert.ok(existsSync(gone));
  });

  test('--yes removes the gone store and its registry entry, and keeps the store of a repo that exists', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const home = homeFor(repo);
    const live = storeOf(repo);
    const ghost = keep(tmpDir());
    const gone = plant(home, 'ghost-store', path.join(ghost, 'missing'));
    writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: projectId(path.join(ghost, 'missing')), root: path.join(ghost, 'missing'), group: null, addedAt: '2026-01-01T00:00:00.000Z' }] }));
    mkdirSync(live, { recursive: true });
    const r = prune(home, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(gone));
    assert.ok(existsSync(live), 'a store whose repo still has Shipline is never touched');
    const reg = JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8'));
    assert.ok(!reg.projects.some((p) => p.root.endsWith('missing')));
  });

  test('a shared store whose main checkout is gone is kept while a registered worktree still exists', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const home = homeFor(repo);
    const wt = path.join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    // Register the worktree, then pretend the main checkout's store names a root that is gone.
    assert.equal(run(process.execPath, [BIN, 'upgrade', '--dir', wt, '--dry-run'], { cwd: wt }).code, 0);
    const reg = JSON.parse(readFileSync(path.join(home, 'projects.json'), 'utf8'));
    reg.projects.push({ id: 'aaaaaaaaaaaa', root: wt, group: null, addedAt: '2026-01-01T00:00:00.000Z' });
    writeFileSync(path.join(home, 'projects.json'), JSON.stringify(reg));
    const store = storeOf(repo);
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, 'repo.json'), JSON.stringify({ root: '/old/main/checkout', key_version: 2 }));
    const r = prune(home, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Kept: .*still uses this store/);
    assert.ok(existsSync(store));
  });

  test('migration backups: removed when the date in the name is over 30 days old, kept otherwise', () => {
    const home = homeFor(keep(tmpDir()));
    const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const oldBackup = plant(home, `-x-y.migrated-${day(45)}`, '/x/y');
    const newBackup = plant(home, `-x-z.migrated-${day(3)}`, '/x/z');
    const r = prune(home, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(oldBackup));
    assert.ok(existsSync(newBackup));
  });

  test('refuses (exit 1) when a live UI process holds a chat lock on a store it would remove', () => {
    const home = homeFor(keep(tmpDir()));
    const gone = plant(home, 'busy-store', '/no/such/busy');
    mkdirSync(path.join(gone, 'ui'));
    writeFileSync(path.join(gone, 'ui', 'lock.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), port: 1234 }));
    const r = prune(home, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /chat active/);
    assert.ok(existsSync(gone));
  });

  test('unknown flags are rejected', () => {
    const r = prune(homeFor(keep(tmpDir())), '--dir', '/x');
    assert.equal(r.code, 2);
  });
});
