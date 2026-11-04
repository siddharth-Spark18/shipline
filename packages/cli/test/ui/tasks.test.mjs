// Plan item 45, Tasks (Goals 6 and 7): GET /api/tasks, SSE `tasks` updates from the watcher, and /api/file.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, makeRepo, removeDir, runInit, stage, tmpDir } from '../helpers.mjs';
import { api, openEvents, sleep, startUi } from './helpers.mjs';
import { parseStatusZ } from '../../src/ui/tasks.mjs';

const TASK = 'docs/shipline/add-export';
let dir;
let outside;
let ui;
let ev;

const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
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
    assert.deepEqual(r.json.changes, [{ path: `${TASK}/manifest.json`, index: '?', worktree: '?' }]);
  });

  test('a skipped stage carries its reason; finished tasks are not listed', async () => {
    assert.equal(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Quick'], 's2').code, 0);
    assert.equal(stage(dir, ['skip', '--reason', 'no ticket'], 's2').code, 0);
    let r = await api(ui, 'GET', '/api/tasks');
    const quick = r.json.tasks.find((t) => t.slug === 'quick');
    assert.deepEqual(quick.stages[0], { id: 'jira', name: 'Jira ticket', status: 'skipped', reason: 'no ticket', artifact: 'ticket.md' });
    rmSync(path.join(dir, 'docs/shipline/quick'), { recursive: true });
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
      { path: 'src/a.js', index: ' ', worktree: 'M' },
    );
  });

  test('a hand edit of config.yml reloads the config, so a new artifact_root reaches the task scan', async () => {
    const cfgPath = path.join(dir, '.shipline/config.yml');
    const original = readFileSync(cfgPath, 'utf8');
    write('elsewhere/moved-task/manifest.json', readFileSync(path.join(dir, TASK, 'manifest.json'), 'utf8'));
    await quiet();
    const since = ev.mark();
    writeFileSync(cfgPath, original.replace('artifact_root: docs/shipline', 'artifact_root: elsewhere'));
    try {
      const hit = await ev.waitFor((e) => e.type === 'tasks' && e.data.tasks.some((t) => t.dir === 'elsewhere/moved-task'), 3000, since);
      assert.deepEqual(hit.data.tasks.map((t) => t.dir), ['elsewhere/moved-task']);
      assert.deepEqual((await api(ui, 'GET', '/api/tasks')).json.tasks.map((t) => t.dir), ['elsewhere/moved-task']);
    } finally {
      writeFileSync(cfgPath, original);
      rmSync(path.join(dir, 'elsewhere'), { recursive: true });
    }
    await ev.waitFor((e) => e.type === 'tasks' && e.data.tasks.some((t) => t.dir === TASK), 3000, since);
  });

  test('staging a file (a change only the git directory sees) sends a tasks event', async () => {
    await quiet();
    const since = ev.mark();
    git(dir, 'add', 'src/a.js');
    try {
      const hit = await ev.waitFor((e) => e.type === 'tasks' && e.data.changes.some((c) => c.path === 'src/a.js' && c.index === 'M'), 3000, since);
      assert.deepEqual(hit.data.changes.find((c) => c.path === 'src/a.js'), { path: 'src/a.js', index: 'M', worktree: ' ' });
    } finally {
      git(dir, 'reset', '-q', '--', 'src/a.js');
    }
  });

  test('writing to .shipline/.state/ sends no event', async () => {
    await quiet();
    const since = ev.mark();
    write('.shipline/.state/other-session.json', '{"session_id":"x"}\n');
    write('.shipline/.state/ui/scratch.txt', 'x\n');
    await sleep(1500);
    assert.deepEqual(ev.events.slice(since).filter((e) => e.type === 'tasks'), []);
  });
});

describe('GET /api/file', () => {
  test('reads a task artifact', async () => {
    const r = await file(`${TASK}/ticket.md`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { path: `${TASK}/ticket.md`, content: '# LL-12\n' });
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

  test('rejects ../ paths', async () => {
    for (const p of ['../secret.txt', '../../etc/passwd', `${TASK}/../../../README.md`, `${TASK}/../../../../${path.basename(outside)}/secret.txt`, '..', '/etc/passwd', path.join(outside, 'secret.txt')]) {
      const r = await file(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.json.error.code, 'not-found');
    }
  });

  test('rejects a symlink pointing outside the repo, in a task folder or in the changes', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, TASK, 'leak.md'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'src', 'leak.txt'));
    for (const p of [`${TASK}/leak.md`, 'src/leak.txt']) {
      for (const mode of ['content', 'diff']) {
        const r = await file(p, mode);
        assert.equal(r.status, 404, `${p} ${mode}: ${r.text}`);
        assert.ok(!r.text.includes('outside the repo'));
      }
    }
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
      assert.deepEqual(r.json.changes.find((c) => c.path === 'READ.md'), { path: 'READ.md', oldPath: 'README.md', index: 'R', worktree: ' ' });
      const d = await file('READ.md', 'diff');
      assert.equal(d.status, 200, d.text);
    } finally {
      git(dir, 'mv', 'READ.md', 'README.md');
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
      assert.ok(t.json.changes.some((c) => c.path === 'first.txt' && c.index === 'A'));
      const r = await api(u, 'GET', '/api/file?path=first.txt&mode=diff');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.hunks[0].lines.map((l) => [l.type, l.text]), [['add', 'hello']]);
    } finally {
      if (u) await u.close();
      removeDir(d);
    }
  });
});
