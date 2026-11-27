// Phase 1 plan, "Store layout" and Tests: the task store outside the repo ($SHIPLINE_HOME/projects/<encoded>/).
// The encoding (same as Claude Code's), SHIPLINE_HOME and its ~/.shipline default, the repo.json collision guard,
// an unwritable store, and success criterion 2: a fresh init plus a Feature task leaves `git status` clean.
// Node 18+ (runs in test:hooks); the transcript.mjs comparison is skipped below Node 20.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePath, mainRoot, shiplineHome, storeDir, storeDirFor, storeKey, storeScheme, tasksDir, stateDir, uiDir } from '../src/store.mjs';
import { BIN, CLI_ROOT, git, homeFor, hook, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';
import { HOOK_NODE } from './helpers.mjs';

const dirs = [];
const keep = (d) => (dirs.push(d), d);
after(() => dirs.forEach(removeDir));
const major = Number(process.versions.node.split('.')[0]);

// Runs fn with process.env.SHIPLINE_HOME set to home, then restores it.
function withHome(home, fn) {
  const prev = process.env.SHIPLINE_HOME;
  process.env.SHIPLINE_HOME = home;
  try {
    return fn();
  } finally {
    process.env.SHIPLINE_HOME = prev;
  }
}

describe('encodePath', () => {
  test('every non-alphanumeric character becomes "-" (Claude Code\'s ~/.claude/projects scheme)', () => {
    assert.equal(encodePath('/Users/dev/My Repo/.x_y-z'), '-Users-dev-My-Repo--x-y-z');
    assert.equal(encodePath('/tmp/a.b'), '-tmp-a-b');
    assert.equal(encodePath('abcXYZ019'), 'abcXYZ019');
  });

  test('gives the same folder name transcript.mjs uses for Claude\'s history', { skip: major < 20 ? 'transcript.mjs is UI code (Node 20+)' : false }, async () => {
    const { findTranscript } = await import('../src/ui/transcript.mjs');
    const cfg = keep(tmpDir('shipline-claude-config-'));
    const root = '/Users/dev/some repo/x.y';
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    mkdirSync(path.join(cfg, 'projects', encodePath(root)), { recursive: true });
    const file = path.join(cfg, 'projects', encodePath(root), `${id}.jsonl`);
    writeFileSync(file, '\n');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      assert.equal(findTranscript(root, id), file);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('SHIPLINE_HOME', () => {
  test('is honoured: storeDir, tasksDir, stateDir and uiDir live under it, and repo.json is written', () => {
    const repo = keep(tmpDir());
    const home = homeFor(repo);
    withHome(home, () => {
      assert.equal(shiplineHome(), home);
      const store = storeDir(repo);
      assert.equal(store, path.join(home, 'projects', encodePath(repo))); // no .shipline/bin/VERSION: the 1.x key
      assert.equal(tasksDir(repo), path.join(store, 'tasks'));
      assert.equal(stateDir(repo), path.join(store, 'state'));
      assert.equal(uiDir(repo), path.join(store, 'ui'));
      const meta = JSON.parse(readFileSync(path.join(store, 'repo.json'), 'utf8'));
      assert.equal(meta.root, repo);
      assert.ok(!Number.isNaN(Date.parse(meta.created)));
      // A second call keeps the same repo.json.
      storeDir(repo);
      assert.deepEqual(JSON.parse(readFileSync(path.join(store, 'repo.json'), 'utf8')), meta);
    });
  });

  test('defaults to ~/.shipline (os.homedir()) when unset', () => {
    const fakeHome = keep(tmpDir('shipline-fake-home-'));
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    delete env.SHIPLINE_HOME;
    const lib = path.join(CLI_ROOT, 'templates', 'shipline', 'bin', 'lib.mjs');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(lib).href)}).then((l) => console.log(l.shiplineHome()))`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(fakeHome, '.shipline'));
  });

  test('the store key is the realpath of the repo root (a symlinked path shares the store)', { skip: process.platform === 'win32' && 'creating symlinks needs extra rights on Windows; the store key on a real Windows path is covered by windows.test.mjs "a repo on a drive-letter path: init, a stage, and the store folder name"' }, () => {
    const repo = keep(tmpDir());
    const link = path.join(keep(tmpDir()), 'link');
    spawnSync('ln', ['-s', repo, link]);
    withHome(homeFor(repo), () => assert.equal(storeDir(link), storeDir(repo)));
  });

  test('stage.mjs writes the task where SHIPLINE_HOME points, and two clones get two stores', () => {
    const a = keep(makeRepo({ commitInit: true }));
    const b = keep(makeRepo({ commitInit: true }));
    const home = keep(tmpDir('shipline-shared-home-'));
    for (const d of [a, b]) {
      const r = run(HOOK_NODE, [path.join(d, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'feature', '--title', 'Same name', '--session', 's1'], { cwd: d, env: { SHIPLINE_HOME: home } });
      assert.equal(r.code, 0, r.stderr);
      const want = path.join(home, 'projects', storeKey(realpathSync(d)), 'tasks', 'same-name');
      assert.ok(r.stdout.includes(`Started Feature task in ${want}`), r.stdout);
      assert.ok(existsSync(path.join(want, 'manifest.json')));
    }
    assert.equal(readdirSync(path.join(home, 'projects')).length, 2);
  });
});

describe('repo.json collision guard', () => {
  // Another path that encodes the same way: /x/a-b and /x/a.b both give -x-a-b.
  const plantCollision = (repo, store = storeOf(repo)) => {
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, 'repo.json'), JSON.stringify({ root: '/somewhere/else', created: '2026-01-01T00:00:00.000Z' }));
    return store;
  };

  test('storeDir throws naming both paths, and repo.json is left as it was', () => {
    const repo = keep(tmpDir());
    const store = plantCollision(repo);
    withHome(homeFor(repo), () => {
      assert.throws(() => storeDir(repo), (e) => e.code === 'STORE_COLLISION' && e.message.includes(store) && e.message.includes('/somewhere/else') && e.message.includes(repo));
    });
    assert.equal(JSON.parse(readFileSync(path.join(store, 'repo.json'), 'utf8')).root, '/somewhere/else');
    assert.ok(!existsSync(path.join(store, 'tasks')));
  });

  test('init and stage.mjs stop with the collision message; upgrade (which no longer touches the store) is unaffected', () => {
    const fresh = keep(tmpDir());
    plantCollision(fresh, path.join(homeFor(fresh), 'projects', storeKey(realpathSync(fresh)))); // init installs interface 2
    const r = run(process.execPath, [BIN, 'init', '--dir', fresh, '--yes'], { cwd: fresh });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Shipline store collision at .*belongs to \/somewhere\/else/);
    assert.ok(!existsSync(path.join(fresh, '.shipline')));

    const repo = keep(makeRepo({ commitInit: true }));
    plantCollision(repo);
    const s = stage(repo, ['start', '--workflow', 'feature', '--title', 'X'], 's1');
    assert.equal(s.code, 1);
    assert.match(s.stderr, /Shipline store collision/);
    // 1.0 removed the move of task data into the store, so upgrade never opens it.
    const u = run(process.execPath, [BIN, 'upgrade', '--dir', repo, '--yes'], { cwd: repo });
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.stdout, 'Already up to date.\n');
  });

  test('a hook fails open with a visible systemMessage', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    plantCollision(repo);
    const r = hook(repo, 'session-start.mjs', { session_id: 's1', cwd: repo });
    assert.equal(r.code, 0);
    assert.match(r.json.systemMessage, /^Shipline: ignoring a problem and continuing without enforcement\. Shipline store collision/);
  });
});

describe('an unwritable store', () => {
  test('hooks fail open with "Shipline can\'t write its task store at <path>"', { skip: process.platform === 'win32' && 'blocks the store with a file in the path (POSIX ENOTDIR); no Windows test covers an unwritable store yet' }, () => {
    const repo = keep(makeRepo({ commitInit: true }));
    const blocker = path.join(homeFor(repo), 'a-file');
    writeFileSync(blocker, 'x');
    const home = path.join(blocker, 'home');
    for (const script of ['session-start.mjs', 'guard.mjs', 'prompt-submit.mjs']) {
      const r = run(HOOK_NODE, [path.join(repo, '.shipline', 'bin', script)], {
        cwd: repo,
        env: { SHIPLINE_HOME: home },
        input: JSON.stringify({ session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.js') }, prompt: 'hi' }),
      });
      assert.equal(r.code, 0, `${script}: ${r.stderr}`);
      const json = JSON.parse(r.stdout);
      assert.ok(json.systemMessage.includes(`Shipline can't write its task store at ${path.join(home, 'projects', storeKey(realpathSync(repo)))}`), `${script}: ${r.stdout}`);
      assert.ok(!r.stdout.includes('"deny"'));
    }
    const s = run(HOOK_NODE, [path.join(repo, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'feature', '--title', 'X', '--session', 's1'], { cwd: repo, env: { SHIPLINE_HOME: home } });
    assert.equal(s.code, 1);
    assert.match(s.stderr, /Shipline can't write its task store at /);
  });
});

describe('success criterion 2: a fresh install leaves the repo clean', () => {
  test('init (committed), then a Feature task through two stages: git status is empty and the task is in the store', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored'), '');
    const tasks = path.join(storeOf(repo), 'tasks');
    const start = stage(repo, ['start', '--workflow', 'feature', '--title', 'Add export', '--ticket', 'll-12'], 's1');
    assert.equal(start.code, 0, start.stderr);
    const taskDir = path.join(tasks, 'LL-12-add-export');
    assert.ok(start.stdout.includes(`Started Feature task in ${taskDir}`), start.stdout);
    // Stage 1 (ticket) is skipped on start with tracker: none (the default); stage 2 (feasibility): write the artifact
    // where stage.mjs says, then advance.
    assert.ok(start.stdout.includes(`Artifact to produce: ${taskDir}/feasibility.md`), start.stdout);
    writeFileSync(path.join(taskDir, 'feasibility.md'), '## Risks\nNone: a contained, additive change behind a flag.\n');
    const adv = stage(repo, ['advance'], 's1');
    assert.equal(adv.code, 0, adv.stderr);
    const m = JSON.parse(readFileSync(path.join(taskDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(m.stages.slice(0, 2).map((s) => s.status), ['skipped', 'done']);
    assert.deepEqual(readdirSync(taskDir).sort(), ['feasibility.md', 'manifest.json', 'owner.json']); // owner.json: who last worked on the task (D3)
    // Hooks ran too (state and a lost-task check) and wrote only to the store.
    hook(repo, 'session-start.mjs', { session_id: 's2', cwd: repo });
    hook(repo, 'guard.mjs', { session_id: 's2', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.js') } });
    assert.ok(existsSync(path.join(storeOf(repo), 'state', 's1.json')));
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored'), '');
    assert.ok(!existsSync(path.join(repo, 'docs')));
    assert.ok(!existsSync(path.join(repo, '.shipline', '.state')));
  });

  test('stage.mjs resume accepts a folder name or the absolute store path; status prints the absolute path', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    assert.equal(stage(repo, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 's1').code, 0);
    const abs = path.join(storeOf(repo), 'tasks', 'fix-crash');
    const byName = stage(repo, ['resume', 'fix-crash'], 's2');
    assert.equal(byName.code, 0, byName.stderr);
    // s1 worked on the task a moment ago, so resume warns first (D3), then reports.
    assert.ok(byName.stdout.startsWith('Another Claude session (s1)'), byName.stdout);
    assert.ok(byName.stdout.includes(`Resumed ${abs} (bugfix workflow).`), byName.stdout);
    const byPath = stage(repo, ['resume', `${abs}/`], 's3');
    assert.equal(byPath.code, 0, byPath.stderr);
    assert.ok(byPath.stdout.includes(`Resumed ${abs} (bugfix workflow).`), byPath.stdout);
    assert.equal(JSON.parse(readFileSync(path.join(storeOf(repo), 'state', 's3.json'), 'utf8')).task_dir, abs);
    // The short status names the task; --verbose adds the full store path.
    const st = stage(repo, ['status', '--verbose'], 's3');
    assert.equal(st.code, 0, st.stderr);
    assert.ok(st.stdout.includes(abs), st.stdout);
    const short = stage(repo, ['status'], 's3');
    assert.equal(short.code, 0, short.stderr);
    assert.ok(!short.stdout.includes(abs), short.stdout);
    assert.match(short.stdout, /^Task fix-crash \(bugfix\) UI work: unknown$/m);
    assert.equal(stage(repo, ['resume', 'nope'], 's4').code, 1);
  });

  test('a ticketless task folder is {slug}; the store key is realpath-based', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    assert.equal(stage(repo, ['start', '--workflow', 'hotfix', '--title', 'Quick One!'], 's1').code, 0);
    assert.ok(existsSync(path.join(storeOf(repo), 'tasks', 'quick-one', 'manifest.json')));
    assert.equal(storeOf(repo), path.join(homeFor(repo), 'projects', storeKey(realpathSync(repo))));
  });
});

// ---------- store keys (interface 2) and the lazy migration from the 2.1 key ----------

// Marks a folder as installed at `iface` (all storeDir reads is .shipline/bin/VERSION).
function install(dir, iface = 2) {
  mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
  writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify({ package: '2.2.0', interface: iface, files: {}, excluded: [] }));
  return dir;
}

// A 2.1-style store for `dir`: <home>/projects/<encodePath(dir)>/ with repo.json and the given task folders.
function oldStore(dir, tasks = {}) {
  const store = path.join(homeFor(dir), 'projects', encodePath(realpathSync(dir)));
  mkdirSync(path.join(store, 'tasks'), { recursive: true });
  writeFileSync(path.join(store, 'repo.json'), JSON.stringify({ root: realpathSync(dir), created: '2026-01-01T00:00:00.000Z' }));
  for (const [name, text] of Object.entries(tasks)) {
    mkdirSync(path.join(store, 'tasks', name), { recursive: true });
    writeFileSync(path.join(store, 'tasks', name, 'manifest.json'), text);
  }
  return store;
}

const projectsOf = (dir) => path.join(homeFor(dir), 'projects');

describe('store keys', () => {
  test('<last 80 characters of the encoded path>-<10 hex of sha256>, at most 91 characters', () => {
    const key = storeKey('/Users/dev/my-app');
    assert.match(key, /^-Users-dev-my-app-[0-9a-f]{10}$/);
    const long = storeKey(`/${'x'.repeat(40)}/${'y'.repeat(200)}/tail`);
    assert.ok(long.length <= 91, long);
    assert.ok(long.startsWith('y') && long.includes('-tail-'), 'keeps the distinctive tail');
    assert.notEqual(storeKey('/a/my-app'), storeKey('/a/my/app'));
  });

  test('two repos whose paths encode alike both get a store (no STORE_COLLISION)', () => {
    const base = keep(tmpDir());
    const a = install(path.join(base, 'c', 'my-app'));
    const b = install(path.join(base, 'c', 'my', 'app'));
    withHome(homeFor(base), () => {
      const sa = storeDir(a);
      const sb = storeDir(b);
      assert.notEqual(sa, sb);
      assert.equal(JSON.parse(readFileSync(path.join(sa, 'repo.json'), 'utf8')).root, realpathSync(a));
      assert.equal(JSON.parse(readFileSync(path.join(sb, 'repo.json'), 'utf8')).root, realpathSync(b));
    });
  });

  test('a path of 300+ characters gets a short store folder', () => {
    const base = keep(tmpDir());
    const deep = install(path.join(base, ...Array.from({ length: 6 }, (_, i) => `${String(i).repeat(50)}`)));
    assert.ok(realpathSync(deep).length > 300);
    withHome(homeFor(base), () => {
      const store = storeDir(deep);
      assert.ok(path.basename(store).length <= 91);
      assert.ok(existsSync(path.join(store, 'repo.json')));
    });
  });

  test('repo.json of a new store: root, main_root, key_version 2, created', () => {
    const repo = install(keep(tmpDir()));
    withHome(homeFor(repo), () => {
      const meta = JSON.parse(readFileSync(path.join(storeDir(repo), 'repo.json'), 'utf8'));
      assert.equal(meta.root, repo);
      assert.equal(meta.main_root, repo);
      assert.equal(meta.key_version, 2);
      assert.ok(!Number.isNaN(Date.parse(meta.created)));
    });
  });
});

describe('interface guard', () => {
  test('interface 1 and a missing VERSION keep the old key and never migrate; interface 2 uses the new key', () => {
    const base = keep(tmpDir());
    const none = path.join(base, 'none');
    const v1 = install(path.join(base, 'v1'), 1);
    mkdirSync(none);
    withHome(homeFor(base), () => {
      assert.equal(storeScheme(none), 1);
      assert.equal(storeScheme(v1), 1);
      assert.equal(storeDir(none), path.join(projectsOf(base), encodePath(none)));
      const old = oldStore(v1, { t: '{}' });
      assert.equal(storeDir(v1), old);
      assert.ok(existsSync(path.join(old, 'tasks', 't')));
      assert.deepEqual(readdirSync(projectsOf(base)).filter((n) => n.includes('migrated')), []);
      install(v1, 2); // upgraded: now the new key (and the migration)
      assert.equal(storeScheme(v1), 2);
      assert.equal(storeDir(v1), path.join(projectsOf(base), storeKey(v1)));
    });
  });

  test('storeDirFor(root, 2) uses the new key before VERSION exists (init)', () => {
    const repo = keep(tmpDir());
    withHome(homeFor(repo), () => assert.equal(storeDirFor(repo, 2), path.join(projectsOf(repo), storeKey(repo))));
  });
});

describe('migration from the 2.1 key', () => {
  test('the old folder is renamed to the new key: tasks and repo.json come along, the old name is gone', () => {
    const repo = install(keep(tmpDir()));
    const old = oldStore(repo, { 'fix-1': '{"a":1}' });
    withHome(homeFor(repo), () => {
      const store = storeDir(repo);
      assert.equal(store, path.join(projectsOf(repo), storeKey(repo)));
      assert.ok(!existsSync(old));
      assert.equal(readFileSync(path.join(store, 'tasks', 'fix-1', 'manifest.json'), 'utf8'), '{"a":1}');
      const meta = JSON.parse(readFileSync(path.join(store, 'repo.json'), 'utf8'));
      assert.equal(meta.key_version, 2);
      assert.equal(meta.created, '2026-01-01T00:00:00.000Z');
    });
  });

  test('when the new store already exists the old one is merged (name clashes get -2) and kept as .migrated-<date>', () => {
    const repo = install(keep(tmpDir()));
    const old = oldStore(repo, { same: '{"from":"old"}', only: '{"from":"old"}' });
    mkdirSync(path.join(old, 'state'));
    writeFileSync(path.join(old, 'state', 's1.json'), '{"old":true}');
    withHome(homeFor(repo), () => {
      const fresh = path.join(projectsOf(repo), storeKey(repo));
      mkdirSync(path.join(fresh, 'tasks', 'same'), { recursive: true });
      writeFileSync(path.join(fresh, 'tasks', 'same', 'manifest.json'), '{"from":"new"}');
      mkdirSync(path.join(fresh, 'state'));
      writeFileSync(path.join(fresh, 'state', 's1.json'), '{"new":true}');
      writeFileSync(path.join(fresh, 'repo.json'), JSON.stringify({ root: realpathSync(repo), key_version: 2 }));
      assert.equal(storeDir(repo), fresh);
      assert.equal(readFileSync(path.join(fresh, 'tasks', 'same', 'manifest.json'), 'utf8'), '{"from":"new"}');
      assert.equal(readFileSync(path.join(fresh, 'tasks', 'same-2', 'manifest.json'), 'utf8'), '{"from":"old"}');
      assert.equal(readFileSync(path.join(fresh, 'tasks', 'only', 'manifest.json'), 'utf8'), '{"from":"old"}');
      assert.equal(readFileSync(path.join(fresh, 'state', 's1.json'), 'utf8'), '{"new":true}');
      assert.equal(readFileSync(path.join(fresh, 'state', 's1-2.json'), 'utf8'), '{"old":true}');
      assert.ok(!existsSync(old));
      const kept = readdirSync(projectsOf(repo)).filter((n) => n.startsWith(`${encodePath(realpathSync(repo))}.migrated-`));
      assert.equal(kept.length, 1);
      assert.match(kept[0], /\.migrated-\d{4}-\d{2}-\d{2}$/);
    });
  });

  test('an old folder whose repo.json names another checkout is left alone', () => {
    const repo = install(keep(tmpDir()));
    const old = oldStore(repo, { t: '{}' });
    writeFileSync(path.join(old, 'repo.json'), JSON.stringify({ root: '/elsewhere' }));
    withHome(homeFor(repo), () => {
      storeDir(repo);
      assert.ok(existsSync(path.join(old, 'tasks', 't')));
    });
  });

  test('two processes resolving at once lose nothing (rename, then merge)', async () => {
    const { spawn } = await import('node:child_process');
    const repo = install(keep(tmpDir()));
    const old = oldStore(repo, { a: '{"n":1}', b: '{"n":2}', c: '{"n":3}' });
    const lib = pathToFileURL(path.join(CLI_ROOT, 'templates', 'shipline', 'bin', 'lib.mjs')).href;
    const code = `import(${JSON.stringify(lib)}).then((l) => console.log(l.storeDir(${JSON.stringify(repo)})))`;
    const one = () =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SHIPLINE_HOME: homeFor(repo) } });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (status) => resolve({ status, out: out.trim(), err }));
      });
    const results = await Promise.all([one(), one(), one(), one()]);
    const fresh = path.join(projectsOf(repo), storeKey(repo));
    for (const r of results) {
      assert.equal(r.status, 0, r.err);
      assert.equal(r.out, fresh);
    }
    assert.deepEqual(readdirSync(path.join(fresh, 'tasks')).sort(), ['a', 'b', 'c']);
    assert.ok(!existsSync(old));
  });
});

describe('mainRoot', () => {
  const gitIn = (cwd, ...args) => spawnSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } });

  test('a normal repo is its own main root; a linked worktree resolves to the main checkout', () => {
    const repo = keep(makeRepo({ init: false }));
    const wt = path.join(keep(tmpDir()), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    assert.equal(mainRoot(repo), realpathSync(repo));
    assert.equal(mainRoot(wt), realpathSync(repo));
  });

  test('a subfolder of a repo keeps its own path (a monorepo package installed on its own)', () => {
    const repo = keep(makeRepo({ init: false }));
    assert.equal(mainRoot(path.join(repo, 'src')), realpathSync(path.join(repo, 'src')));
  });

  test('not a git repo: its own real path', () => {
    const dir = keep(tmpDir());
    assert.equal(mainRoot(dir), realpathSync(dir));
  });

  test('a submodule, a bare repo and --separate-git-dir fall back to the checkout\'s own path', () => {
    const sup = keep(makeRepo({ init: false }));
    const lib = keep(makeRepo({ init: false }));
    const add = gitIn(sup, 'submodule', 'add', lib, 'vendor/lib');
    assert.equal(add.status, 0, add.stderr);
    const sub = path.join(sup, 'vendor', 'lib');
    assert.equal(mainRoot(sub), realpathSync(sub), 'submodule');

    const bare = path.join(keep(tmpDir()), 'r.git');
    assert.equal(gitIn(path.dirname(bare), 'init', '-q', '--bare', bare).status, 0);
    assert.equal(mainRoot(bare), realpathSync(bare), 'bare repo');

    const work = keep(tmpDir());
    const gitdir = path.join(keep(tmpDir()), 'elsewhere');
    assert.equal(gitIn(work, 'init', '-q', '--separate-git-dir', gitdir).status, 0);
    assert.equal(mainRoot(work), realpathSync(work), 'separate git dir');
  });
});
