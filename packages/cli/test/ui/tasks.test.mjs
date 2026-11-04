// Plan item 45, Tasks (Goals 6 and 7): GET /api/tasks, SSE `tasks` updates from the watcher, and /api/file.
// Phase 1: tasks live in the store ($SHIPLINE_HOME/projects/<encoded>/tasks/), Task.dir is the absolute store
// path, /api/file accepts absolute paths inside the store's tasks/ (anything absolute outside the repo and the
// store is 400 bad-path), and an interface-2 repo is read from its old artifact_root, read-only.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, makeRepo, removeDir, runInit, stage, storeOf, tmpDir } from '../helpers.mjs';
import { api, openEvents, sleep, startUi } from './helpers.mjs';
import { changeStatus, parseNumstatZ, parseStatusZ } from '../../src/ui/tasks.mjs';

let TASK; // the absolute store path of the feature task
let dir;
let outside;
let ui;
let ev;

// rel is repo-relative, or absolute (a store path).
const write = (rel, text) => {
  const abs = path.resolve(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const file = (p, mode = 'content') => api(ui, 'GET', `/api/file?path=${encodeURIComponent(p)}&mode=${mode}`);

// Resolves once no event has arrived for `ms`.
async function quiet(ms = 600, limit = 5000) {
  const start = Date.now();
  for (;;) {
    const n = ev.events.length;
    await sleep(ms);
    if (ev.events.length === n || Date.now() - start > limit) return;
  }
}

before(async () => {
  dir = makeRepo({ commitInit: true });
  outside = tmpDir();
  writeFileSync(path.join(outside, 'secret.txt'), 'outside the repo\n');
  TASK = path.join(storeOf(dir), 'tasks', 'add-export');
  ui = await startUi(dir);
  ev = await openEvents(ui);
  const r = stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 's1');
  assert.equal(r.code, 0, r.stderr);
});

after(async () => {
  if (ev) ev.close();
  if (ui) await ui.close();
  removeDir(dir);
  removeDir(outside);
});

describe('GET /api/tasks', () => {
  test('lists the open task with stage names from the workflow, its files, and the changes', async () => {
    const r = await api(ui, 'GET', '/api/tasks');
    assert.equal(r.status, 200);
    assert.equal(r.json.configError, undefined);
    assert.equal(r.json.tasks.length, 1);
    const t = r.json.tasks[0];
    assert.equal(t.dir, TASK);
    assert.equal(t.slug, 'add-export');
    assert.equal(t.title, 'Add export');
    assert.equal(t.workflow, 'feature');
    assert.equal(t.branch, 'feature/add-export');
    assert.deepEqual(t.stages[0], { id: 'jira', name: 'Jira ticket', status: 'in_progress', artifact: 'ticket.md' });
    assert.deepEqual(t.stages.map((s) => s.id), ['jira', 'feasibility', 'questions', 'plan', 'wireframes', 'implement', 'verify', 'pr']);
    assert.equal(t.stages[3].name, 'Plan');
    assert.deepEqual(t.files.map((f) => f.name), ['manifest.json']);
    assert.equal(typeof t.files[0].size, 'number');
    assert.equal(typeof t.files[0].mtime, 'number');
    // The task lives in the store, so starting it changes nothing in the repo (success criterion 2).
    assert.deepEqual(r.json.changes, []);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  });

  test('a skipped stage carries its reason; finished tasks are not listed', async () => {
    assert.equal(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Quick'], 's2').code, 0);
    assert.equal(stage(dir, ['skip', '--reason', 'no ticket'], 's2').code, 0);
    let r = await api(ui, 'GET', '/api/tasks');
    const quick = r.json.tasks.find((t) => t.slug === 'quick');
    assert.deepEqual(quick.stages[0], { id: 'jira', name: 'Jira ticket', status: 'skipped', reason: 'no ticket', artifact: 'ticket.md' });
    rmSync(path.join(storeOf(dir), 'tasks', 'quick'), { recursive: true });
    r = await api(ui, 'GET', '/api/tasks');
    assert.deepEqual(r.json.tasks.map((t) => t.slug), ['add-export']);
  });
});

describe('SSE updates', () => {
  test('after `stage.mjs advance`, a tasks event arrives within 1 s', async () => {
    write(`${TASK}/ticket.md`, '# LL-12\n');
    await quiet();
    const since = ev.mark();
    const r = stage(dir, ['advance'], 's1');
    assert.equal(r.code, 0, r.stderr);
    const done = Date.now();
    const hit = await ev.waitFor(
      (e) => e.type === 'tasks' && e.data.tasks.some((t) => t.dir === TASK && t.stages[0].status === 'done' && t.stages[1].status === 'in_progress'),
      1000,
      since,
    );
    assert.ok(hit.at - done <= 1000, `${hit.at - done} ms`);
  });

  test('editing a source file sends a tasks event with the change', async () => {
    await quiet();
    const since = ev.mark();
    write('src/a.js', 'export const a = 2;\n');
    const hit = await ev.waitFor((e) => e.type === 'tasks' && e.data.changes.some((c) => c.path === 'src/a.js'), 3000, since);
    assert.deepEqual(
      hit.data.changes.find((c) => c.path === 'src/a.js'),
      { path: 'src/a.js', status: 'modified', additions: 1, deletions: 1 },
    );
  });

  test('a new task folder in the store (outside the repo) sends a tasks event', async () => {
    await quiet();
    const since = ev.mark();
    assert.equal(stage(dir, ['start', '--workflow', 'bugfix', '--title', 'Watch me'], 's-watch').code, 0);
    const watched = path.join(storeOf(dir), 'tasks', 'watch-me');
    try {
      await ev.waitFor((e) => e.type === 'tasks' && e.data.tasks.some((t) => t.dir === watched), 3000, since);
    } finally {
      rmSync(watched, { recursive: true });
    }
    await ev.waitFor((e) => e.type === 'tasks' && !e.data.tasks.some((t) => t.dir === watched), 3000, since);
  });

  test('an artifact_root hand-added to config.yml of an interface-3 repo is ignored: tasks still come from the store', async () => {
    const cfgPath = path.join(dir, '.shipline/config.yml');
    const original = readFileSync(cfgPath, 'utf8');
    write('elsewhere/moved-task/manifest.json', readFileSync(path.join(TASK, 'manifest.json'), 'utf8'));
    await quiet();
    const since = ev.mark();
    writeFileSync(cfgPath, `artifact_root: elsewhere\n${original}`);
    try {
      const hit = await ev.waitFor((e) => e.type === 'tasks', 3000, since);
      assert.deepEqual(hit.data.tasks.map((t) => t.dir), [TASK]);
      assert.deepEqual((await api(ui, 'GET', '/api/tasks')).json.tasks.map((t) => t.dir), [TASK]);
    } finally {
      writeFileSync(cfgPath, original);
      rmSync(path.join(dir, 'elsewhere'), { recursive: true });
    }
  });

  test('staging a file (a change only the git directory sees) sends a tasks event', async () => {
    await quiet();
    const since = ev.mark();
    git(dir, 'add', 'src/a.js');
    try {
      // changes[] no longer tells staged from unstaged (plan: out of scope), so any tasks event after the mark counts.
      const hit = await ev.waitFor((e) => e.type === 'tasks' && e.data.changes.some((c) => c.path === 'src/a.js'), 3000, since);
      assert.deepEqual(hit.data.changes.find((c) => c.path === 'src/a.js'), { path: 'src/a.js', status: 'modified', additions: 1, deletions: 1 });
    } finally {
      git(dir, 'reset', '-q', '--', 'src/a.js');
    }
  });

  test('writing to .shipline/.state/ sends no event', async () => {
    // A longer quiet window: the previous test's `git reset` refresh (git status plus the numstat runs for the
    // line counts) can take over 600 ms under a loaded full-suite run, and its late event must not land here.
    await quiet(1500);
    const since = ev.mark();
    write('.shipline/.state/other-session.json', '{"session_id":"x"}\n');
    write('.shipline/.state/ui/scratch.txt', 'x\n');
    await sleep(1500);
    assert.deepEqual(ev.events.slice(since).filter((e) => e.type === 'tasks'), []);
  });
});

describe('GET /api/file', () => {
  test('reads a task artifact by its absolute store path', async () => {
    const r = await file(`${TASK}/ticket.md`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { path: `${TASK}/ticket.md`, content: '# LL-12\n' });
  });

  test('a missing file inside the store tasks/ folder is 404', async () => {
    const r = await file(`${TASK}/nope.md`);
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.error.code, 'not-found');
  });

  test('an absolute path inside the repo is accepted like a relative one', async () => {
    const r = await file(path.join(dir, 'src/a.js'), 'diff');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.path, 'src/a.js');
  });

  test('diffs a changed tracked file', async () => {
    const r = await file('src/a.js', 'diff');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.path, 'src/a.js');
    const lines = r.json.hunks.flatMap((h) => h.lines);
    assert.ok(lines.some((l) => l.type === 'del' && l.text === 'export const a = 1;'));
    assert.ok(lines.some((l) => l.type === 'add' && l.text === 'export const a = 2;'));
  });

  test('diffs an untracked file against /dev/null', async () => {
    write('src/new.js', 'one\ntwo\n');
    const r = await file('src/new.js', 'diff');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.hunks[0].lines.map((l) => [l.type, l.text]), [['add', 'one'], ['add', 'two']]);
  });

  test('a deleted tracked file still has a diff, but no content', async () => {
    unlinkSync(path.join(dir, 'README.md'));
    try {
      const d = await file('README.md', 'diff');
      assert.equal(d.status, 200, d.text);
      assert.ok(d.json.hunks[0].lines.every((l) => l.type === 'del'));
      assert.equal((await file('README.md')).status, 404);
    } finally {
      git(dir, 'checkout', '--', 'README.md');
    }
  });

  test('binary files are reported as binary', async () => {
    writeFileSync(path.join(dir, 'src/blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
    assert.deepEqual((await file('src/blob.bin')).json, { path: 'src/blob.bin', binary: true });
    assert.deepEqual((await file('src/blob.bin', 'diff')).json, { path: 'src/blob.bin', binary: true });
  });

  test('content over 1 MB gives 413', async () => {
    write('src/big.txt', 'x'.repeat(1024 * 1024 + 1));
    const r = await file('src/big.txt');
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'too-large');
  });

  test('rejects relative ../ paths with 404', async () => {
    for (const p of ['../secret.txt', '../../etc/passwd', 'src/../../README.md', '..']) {
      const r = await file(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.json.error.code, 'not-found');
    }
  });

  test('an absolute path outside both the repo and the store tasks/ folder gives 400 bad-path', async () => {
    const store = storeOf(dir);
    for (const p of [
      '/etc/passwd',
      path.join(outside, 'secret.txt'),
      `${TASK}/../../../README.md`, // normalizes to <home>/projects/README.md
      `${TASK}/../../../../${path.basename(outside)}/secret.txt`,
      path.join(store, 'repo.json'), // in the store, but not in tasks/
      path.join(store, 'state', 's1.json'),
      path.join(store, 'ui', 'ui.log'),
    ]) {
      const r = await file(p);
      assert.equal(r.status, 400, `${p}: ${r.text}`);
      assert.equal(r.json.error.code, 'bad-path', p);
      assert.ok(!r.text.includes('outside the repo\n'));
    }
  });

  test('rejects a symlink pointing outside: in a store task folder (400) or in the changes (404)', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(TASK, 'leak.md'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'src', 'leak.txt'));
    for (const [p, status] of [[`${TASK}/leak.md`, 400], ['src/leak.txt', 404]]) {
      for (const mode of ['content', 'diff']) {
        const r = await file(p, mode);
        assert.equal(r.status, status, `${p} ${mode}: ${r.text}`);
        assert.ok(!r.text.includes('outside the repo'));
      }
    }
  });

  test('the relative docs/shipline path of a store task is not readable (the repo has no task folders)', async () => {
    const r = await file('docs/shipline/add-export/ticket.md');
    assert.equal(r.status, 404);
  });

  test('rejects a path that is neither in a task folder nor changed', async () => {
    for (const p of ['.shipline/config.yml', '.shipline/bin/guard.mjs', 'src/does-not-exist.js']) {
      const r = await file(p);
      assert.equal(r.status, 404, p);
    }
    // README.md is committed and unchanged.
    assert.equal((await file('README.md')).status, 404);
  });

  test('needs the cookie', async () => {
    const r = await api(ui, 'GET', `/api/file?path=${encodeURIComponent(`${TASK}/ticket.md`)}`, { cookie: null });
    assert.equal(r.status, 401);
  });
});

describe('parseStatusZ', () => {
  test('splits on NUL and reads the old path after R and C', () => {
    const out = ' M src/a.js\0R  src/b.js\0src/old.js\0?? docs/x y.md\0C  c2.js\0c1.js\0';
    assert.deepEqual(parseStatusZ(out), [
      { path: 'src/a.js', index: ' ', worktree: 'M' },
      { path: 'src/b.js', oldPath: 'src/old.js', index: 'R', worktree: ' ' },
      { path: 'docs/x y.md', index: '?', worktree: '?' },
      { path: 'c2.js', oldPath: 'c1.js', index: 'C', worktree: ' ' },
    ]);
  });

  test('a staged rename shows up in /api/tasks with oldPath', async () => {
    git(dir, 'mv', 'README.md', 'READ.md');
    try {
      const r = await api(ui, 'GET', '/api/tasks');
      assert.deepEqual(r.json.changes.find((c) => c.path === 'READ.md'), { path: 'READ.md', oldPath: 'README.md', status: 'renamed', additions: 0, deletions: 0 });
      const d = await file('READ.md', 'diff');
      assert.equal(d.status, 200, d.text);
    } finally {
      git(dir, 'mv', 'READ.md', 'README.md');
    }
  });
});

describe('changes[]: status and line counts (prepublish plan, F)', () => {
  test('changeStatus maps the raw codes; untracked counts as added', () => {
    const cases = [
      [' M', 'modified'], ['M ', 'modified'], ['MM', 'modified'], ['T ', 'modified'],
      ['A ', 'added'], ['AM', 'added'], ['??', 'added'],
      [' D', 'deleted'], ['D ', 'deleted'], ['AD', 'deleted'],
      ['R ', 'renamed'], ['RM', 'renamed'], ['C ', 'renamed'],
    ];
    for (const [code, status] of cases) assert.equal(changeStatus({ index: code[0], worktree: code[1] }), status, JSON.stringify(code));
  });

  test('parseNumstatZ reads plain, renamed and binary records, keyed by the new path', () => {
    const out = '3\t1\tsrc/a.js\0' + '0\t0\t\0old name.md\0new name.md\0' + '-\t-\tlogo.png\0' + '5\t0\tdir/with\ttab.txt\0';
    const m = parseNumstatZ(out);
    assert.deepEqual(Object.fromEntries(m), {
      'src/a.js': { additions: 3, deletions: 1 },
      'new name.md': { additions: 0, deletions: 0 },
      'logo.png': { additions: null, deletions: null },
      'dir/with\ttab.txt': { additions: 5, deletions: 0 },
    });
    assert.equal(parseNumstatZ('').size, 0);
  });

  test('GET /api/tasks: added (untracked, nested), modified, deleted, renamed with edits, and binary files', async () => {
    const d = makeRepo({ commitInit: true });
    let u;
    try {
      writeFileSync(path.join(d, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
      writeFileSync(path.join(d, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\n');
      git(d, 'add', '-A');
      git(d, 'commit', '-q', '-m', 'more files');
      // modified: 2 lines added, 1 removed
      writeFileSync(path.join(d, 'src', 'a.js'), 'export const a = 2;\nexport const b = 3;\nexport const c = 4;\n');
      // deleted (not staged)
      rmSync(path.join(d, 'README.md'));
      // renamed (staged) with one line changed
      git(d, 'mv', 'notes.txt', 'notes.md');
      writeFileSync(path.join(d, 'notes.md'), 'one\ntwo\nTHREE\nfour\nfive\n');
      // untracked text, in a new folder (listed file by file)
      mkdirSync(path.join(d, 'docs', 'deep'), { recursive: true });
      writeFileSync(path.join(d, 'docs', 'deep', 'new.md'), 'a\nb\nc\n');
      writeFileSync(path.join(d, 'docs', 'empty.txt'), '');
      // binary: a modified tracked one and an untracked one
      writeFileSync(path.join(d, 'logo.bin'), Buffer.from([0, 9, 9, 9, 0, 255, 1]));
      writeFileSync(path.join(d, 'pic.bin'), Buffer.from([0, 0, 1, 2, 3]));
      u = await startUi(d);
      const t = await api(u, 'GET', '/api/tasks');
      assert.equal(t.status, 200, t.text);
      const by = Object.fromEntries(t.json.changes.map((c) => [c.path, c]));
      assert.deepEqual(by['src/a.js'], { path: 'src/a.js', status: 'modified', additions: 3, deletions: 1 });
      assert.deepEqual(by['README.md'], { path: 'README.md', status: 'deleted', additions: 0, deletions: 1 });
      assert.deepEqual(by['notes.md'], { path: 'notes.md', oldPath: 'notes.txt', status: 'renamed', additions: 1, deletions: 1 });
      assert.deepEqual(by['docs/deep/new.md'], { path: 'docs/deep/new.md', status: 'added', additions: 3, deletions: 0 });
      assert.deepEqual(by['docs/empty.txt'], { path: 'docs/empty.txt', status: 'added', additions: 0, deletions: 0 });
      assert.deepEqual(by['logo.bin'], { path: 'logo.bin', status: 'modified', additions: null, deletions: null });
      assert.deepEqual(by['pic.bin'], { path: 'pic.bin', status: 'added', additions: null, deletions: null });
      assert.ok(!('notes.txt' in by), 'a rename is one entry, under its new path');
      for (const c of t.json.changes) {
        assert.ok(!('index' in c) && !('worktree' in c), `${c.path} still has raw codes`);
        assert.ok(['added', 'modified', 'deleted', 'renamed'].includes(c.status), c.path);
      }
      // The diff of an untracked file still works (the view calls it on expand).
      const diff = await api(u, 'GET', `/api/file?path=${encodeURIComponent('docs/deep/new.md')}&mode=diff`);
      assert.equal(diff.status, 200, diff.text);
    } finally {
      if (u) await u.close();
      removeDir(d);
    }
  });

  test('a clean tree gives changes: []', async () => {
    const d = makeRepo({ commitInit: true });
    let u;
    try {
      u = await startUi(d);
      const t = await api(u, 'GET', '/api/tasks');
      assert.deepEqual(t.json.changes, []);
    } finally {
      if (u) await u.close();
      removeDir(d);
    }
  });
});

describe('a repo with no commits yet', () => {
  test('a staged file diffs against the index (git diff --cached)', async () => {
    const d = tmpDir();
    let u;
    try {
      git(d, 'init', '-q');
      writeFileSync(path.join(d, 'first.txt'), 'hello\n');
      assert.equal(runInit(d).code, 0);
      git(d, 'add', 'first.txt');
      u = await startUi(d);
      const t = await api(u, 'GET', '/api/tasks');
      assert.deepEqual(t.json.changes.find((c) => c.path === 'first.txt'), { path: 'first.txt', status: 'added', additions: 1, deletions: 0 });
      const r = await api(u, 'GET', '/api/file?path=first.txt&mode=diff');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.hunks[0].lines.map((l) => [l.type, l.text]), [['add', 'hello']]);
    } finally {
      if (u) await u.close();
      removeDir(d);
    }
  });
});

describe('an interface-2 repo (not upgraded yet)', () => {
  test('tasks are read from the old artifact_root, read-only: absolute dirs, and /api/file reads its files', async () => {
    const d = makeRepo({ commitInit: true });
    let u;
    try {
      // Build an in-repo task the way 0.6.0 left it: a task folder under a custom artifact_root, committed.
      assert.equal(stage(d, ['start', '--workflow', 'feature', '--title', 'Old task'], 'o1').code, 0);
      const legacyTask = path.join(d, 'work', 'tasks', 'old-task');
      mkdirSync(path.dirname(legacyTask), { recursive: true });
      cpSync(path.join(storeOf(d), 'tasks', 'old-task'), legacyTask, { recursive: true });
      rmSync(path.join(storeOf(d), 'tasks', 'old-task'), { recursive: true });
      writeFileSync(path.join(legacyTask, 'ticket.md'), '# old\n');
      const cfg = readFileSync(path.join(d, '.shipline/config.yml'), 'utf8');
      writeFileSync(path.join(d, '.shipline/config.yml'), `artifact_root: work/tasks\n${cfg}`);
      writeFileSync(path.join(d, '.shipline/bin/VERSION'), '{"package":"0.6.0","interface":2}\n');
      git(d, 'add', '-A');
      git(d, 'commit', '-q', '-m', 'legacy layout');

      u = await startUi(d);
      const status = await api(u, 'GET', '/api/status');
      assert.equal(status.json.needsUpgrade, true);
      const t = await api(u, 'GET', '/api/tasks');
      assert.equal(t.status, 200);
      assert.deepEqual(t.json.tasks.map((k) => k.dir), [legacyTask]);
      assert.deepEqual(t.json.tasks[0].files.map((f) => f.name).sort(), ['manifest.json', 'ticket.md']);
      // Committed and unchanged, but inside an open legacy task folder: readable by its repo-relative path.
      const r = await api(u, 'GET', `/api/file?path=${encodeURIComponent('work/tasks/old-task/ticket.md')}&mode=content`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.content, '# old\n');
      // Reading never moves or writes anything in the repo.
      assert.equal(git(d, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.ok(existsSync(path.join(legacyTask, 'manifest.json')));
    } finally {
      if (u) await u.close();
      removeDir(d);
    }
  });
});
