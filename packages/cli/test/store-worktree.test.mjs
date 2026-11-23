// Plan E, E2: every git worktree of a repo uses the main checkout's task store (tasks, sessions and state are shared),
// while config and workflows come from the worktree's own .shipline/. Also the two orders in which a main checkout and
// its worktrees migrate their 2.1 stores, and a worktree whose branch still has interface-1 hooks.
// Node 18+ (runs in test:hooks).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodePath, loadConfig, storeDir, tasksDir, storeKey } from '../templates/shipline/bin/lib.mjs';
import { git, homeFor, makeRepo, removeDir, stage, storeOf, tmpDir } from './helpers.mjs';

const dirs = [];
const keep = (d) => (dirs.push(d), d);
after(() => dirs.forEach(removeDir));

function withHome(home, fn) {
  const prev = process.env.SHIPLINE_HOME;
  process.env.SHIPLINE_HOME = home;
  try {
    return fn();
  } finally {
    process.env.SHIPLINE_HOME = prev;
  }
}

const writeVersion = (dir, iface) => {
  mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
  writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify({ package: '2.2.0', interface: iface, files: {}, excluded: [] }));
};

describe('worktrees of an installed repo', () => {
  test('a task started in the main checkout is listed in the worktree, and the other way round; one store folder', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const wt = path.join(repo, 'wt'); // under the repo's temp dir, so the test helpers give both the same SHIPLINE_HOME
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/side', wt);
    const main = stage(repo, ['start', '--workflow', 'bugfix', '--title', 'Main bug'], 'm2');
    assert.equal(main.code, 0, main.stderr);
    // The worktree's hooks resolve the same store (its home is the main checkout's temp home).
    const r = stage(wt, ['status', '--all'], 'w1');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /main-bug/);
    const w = stage(wt, ['start', '--workflow', 'hotfix', '--title', 'Side fix'], 'w2');
    assert.equal(w.code, 0, w.stderr);
    assert.ok(existsSync(path.join(storeOf(repo), 'tasks', 'side-fix', 'manifest.json')));
    assert.match(stage(repo, ['status', '--all'], 'm3').stdout, /side-fix/);
    const stores = readdirSync(path.join(homeFor(repo), 'projects')).filter((n) => !n.includes('.migrated-'));
    assert.deepEqual(stores, [path.basename(storeOf(repo))]);
  });

  test('config comes from the worktree\'s own .shipline/, the store from the main checkout', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const wt = path.join(keep(tmpDir()), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/cfg', wt);
    const cfg = path.join(wt, '.shipline', 'config.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^branch_pattern:.*$/m, 'branch_pattern: "wt/{slug}"'));
    withHome(homeFor(repo), () => {
      assert.equal(loadConfig(wt).branch_pattern, 'wt/{slug}');
      assert.notEqual(loadConfig(repo).branch_pattern, 'wt/{slug}');
      assert.equal(tasksDir(wt), tasksDir(repo));
    });
  });
});

describe('migrating a main checkout and its worktrees, in either order', () => {
  // A repo and a linked worktree, both with interface-1 hooks and their own 2.1 stores holding one task each.
  function setup() {
    const repo = keep(makeRepo({ init: false }));
    const wt = path.join(keep(tmpDir()), 'wt');
    writeVersion(repo, 1);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'shipline 2.1');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    const home = homeFor(repo);
    const mk = (dir, task) => {
      const store = path.join(home, 'projects', encodePath(realpathSync(dir)));
      mkdirSync(path.join(store, 'tasks', task), { recursive: true });
      writeFileSync(path.join(store, 'tasks', task, 'manifest.json'), '{}');
      writeFileSync(path.join(store, 'repo.json'), JSON.stringify({ root: realpathSync(dir) }));
      return store;
    };
    return { repo, wt, home, oldMain: mk(repo, 'main-task'), oldWt: mk(wt, 'wt-task') };
  }

  for (const order of [['main', 'wt'], ['wt', 'main']]) {
    test(`${order.join(' first, then ')}: every task ends up in the shared store, none stranded`, () => {
      const s = setup();
      withHome(s.home, () => {
        // Both checkouts keep their own stores while their hooks are interface 1.
        assert.equal(storeDir(s.repo), s.oldMain);
        assert.equal(storeDir(s.wt), s.oldWt);
        const dirsOf = { main: s.repo, wt: s.wt };
        writeVersion(s.repo, 2);
        writeVersion(s.wt, 2);
        const shared = path.join(s.home, 'projects', storeKey(realpathSync(s.repo)));
        for (const who of order) assert.equal(storeDir(dirsOf[who]), shared);
        assert.deepEqual(readdirSync(path.join(shared, 'tasks')).sort(), ['main-task', 'wt-task']);
        assert.ok(!existsSync(s.oldMain) && !existsSync(s.oldWt));
        assert.equal(JSON.parse(readFileSync(path.join(shared, 'repo.json'), 'utf8')).root, realpathSync(s.repo));
      });
    });
  }

  test('a worktree whose branch still has interface 1 keeps its own old store while the main checkout is on 2', () => {
    const s = setup();
    withHome(s.home, () => {
      writeVersion(s.repo, 2);
      assert.equal(storeDir(s.repo), path.join(s.home, 'projects', storeKey(realpathSync(s.repo))));
      assert.equal(storeDir(s.wt), s.oldWt);
      assert.ok(existsSync(path.join(s.oldWt, 'tasks', 'wt-task')));
    });
  });
});
