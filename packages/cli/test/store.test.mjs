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
import { encodePath, shiplineHome, storeDir, tasksDir, stateDir, uiDir } from '../src/store.mjs';
import { BIN, CLI_ROOT, git, homeFor, hook, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';

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
      assert.equal(store, path.join(home, 'projects', encodePath(repo)));
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
      const r = run(process.execPath, [path.join(d, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'feature', '--title', 'Same name', '--session', 's1'], { cwd: d, env: { SHIPLINE_HOME: home } });
      assert.equal(r.code, 0, r.stderr);
      const want = path.join(home, 'projects', encodePath(d), 'tasks', 'same-name');
      assert.ok(r.stdout.includes(`Started Feature task in ${want}`), r.stdout);
      assert.ok(existsSync(path.join(want, 'manifest.json')));
    }
    assert.equal(readdirSync(path.join(home, 'projects')).length, 2);
  });
});

describe('repo.json collision guard', () => {
  // Another path that encodes the same way: /x/a-b and /x/a.b both give -x-a-b.
  const plantCollision = (repo) => {
    const store = storeOf(repo);
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
    plantCollision(fresh);
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
      const r = run(process.execPath, [path.join(repo, '.shipline', 'bin', script)], {
        cwd: repo,
        env: { SHIPLINE_HOME: home },
        input: JSON.stringify({ session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.js') }, prompt: 'hi' }),
      });
      assert.equal(r.code, 0, `${script}: ${r.stderr}`);
      const json = JSON.parse(r.stdout);
      assert.ok(json.systemMessage.includes(`Shipline can't write its task store at ${path.join(home, 'projects', encodePath(repo))}`), `${script}: ${r.stdout}`);
      assert.ok(!r.stdout.includes('"deny"'));
    }
    const s = run(process.execPath, [path.join(repo, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'feature', '--title', 'X', '--session', 's1'], { cwd: repo, env: { SHIPLINE_HOME: home } });
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
    assert.deepEqual(readdirSync(taskDir).sort(), ['feasibility.md', 'manifest.json']);
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
    assert.ok(byName.stdout.startsWith(`Resumed ${abs} (bugfix workflow).`), byName.stdout);
    const byPath = stage(repo, ['resume', `${abs}/`], 's3');
    assert.equal(byPath.code, 0, byPath.stderr);
    assert.ok(byPath.stdout.startsWith(`Resumed ${abs} (bugfix workflow).`), byPath.stdout);
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

  test('a ticketless task folder is {slug}; the store path is realpath-based', () => {
    const repo = keep(makeRepo({ commitInit: true }));
    assert.equal(stage(repo, ['start', '--workflow', 'hotfix', '--title', 'Quick One!'], 's1').code, 0);
    assert.ok(existsSync(path.join(storeOf(repo), 'tasks', 'quick-one', 'manifest.json')));
    assert.equal(storeOf(repo), path.join(homeFor(repo), 'projects', encodePath(realpathSync(repo))));
  });
});
