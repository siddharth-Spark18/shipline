// Cleanup and rollout plan, section C: the Windows behaviour that needs a real Windows machine (cmd.exe, taskkill,
// tasklist, drive letters, NUL). Runs on win32 only (the windows-latest CI jobs) and is skipped elsewhere; the
// platform-neutral rules (isInside, sameRoot, detectEol, startSpec, encodePath) are in paths-eol.test.mjs.
// The hook-level tests run on Node 18 (test:hooks); the chat tests need the UI server (Node 20+).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAKE_CLAUDE_MJS, IS_WIN, cleanEnv, git, homeFor, livePids, makeRepo, removeDir, run, runInit, stage, storeOf, tmpDir,
  writeCmdShim,
} from './helpers.mjs';
import { encodePath } from '../templates/shipline/bin/lib.mjs';

const major = Number(process.versions.node.split('.')[0]);
const WIN_ONLY = !IS_WIN && 'Windows only (cmd.exe, taskkill, tasklist, drive letters, NUL); the platform-neutral rules are in paths-eol.test.mjs';
const UI_SKIP = WIN_ONLY || (major < 20 && 'the UI server needs Node 20 (runs in the cli + ui job)');

const dirs = [];
after(() => {
  for (const d of dirs) removeDir(d);
});

// A git repo with one commit and Shipline installed, at <tmp>/<name> (a name with a space by default).
function repoAt(name = 'my repo') {
  const base = tmpDir('shipline-win-');
  dirs.push(base);
  const dir = path.join(base, name);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Shipline Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  const r = runInit(dir);
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'shipline init');
  return { base, dir };
}

// Swaps the case of the drive letter: C:\x -> c:\x.
const otherDriveCase = (p) => p.replace(/^([A-Za-z]):/, (_, d) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()) + ':');

describe('a repo on a drive-letter path', { skip: WIN_ONLY }, () => {
  test('a repo on a drive-letter path: init, a stage, and the store folder name', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    assert.match(dir, /^[A-Za-z]:\\/, 'a real drive-letter path');
    const s = stage(dir, ['start', '--workflow', 'feature', '--title', 'Windows task'], 'w-1');
    assert.equal(s.code, 0, s.stderr);

    const projects = path.join(homeFor(dir), 'projects');
    const folder = encodePath(dir);
    assert.match(folder, /^[A-Za-z]--/, 'C:\\... becomes C--...');
    assert.equal(storeOf(dir), path.join(projects, folder));
    assert.deepEqual(readdirSync(projects), [folder]);
    assert.equal(JSON.parse(readFileSync(path.join(projects, folder, 'repo.json'), 'utf8')).root, dir);
    assert.ok(readdirSync(path.join(projects, folder, 'tasks')).length >= 1, 'the task folder is in the store');

    // The same repo reached with the other drive-letter case: same store (NTFS is case-insensitive, so
    // repo.json is compared with sameRoot), no collision, no second folder.
    const other = otherDriveCase(dir);
    const st = run(process.execPath, [path.join(other, '.shipline', 'bin', 'stage.mjs'), 'status', '--session', 'w-1'], { cwd: other, env: { SHIPLINE_HOME: homeFor(dir) } });
    assert.equal(st.code, 0, st.stderr);
    assert.ok(!/collision/i.test(st.stdout + st.stderr), st.stdout + st.stderr);
    assert.match(st.stdout, /windows-task/, 'the task started through the other spelling is found');
    assert.equal(readdirSync(projects).length, 1);
  });

  test('a repo path with a space: init and a stage', () => {
    const { dir } = repoAt('my repo');
    const s = stage(dir, ['start', '--workflow', 'small', '--title', 'Spaced'], 'w-2');
    assert.equal(s.code, 0, s.stderr);
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks')));
  });

  test('git diff --no-index accepts "/dev/null" (the name Shipline passes) and "nul"', () => {
    const dir = makeRepo();
    dirs.push(dir);
    writeFileSync(path.join(dir, 'new.txt'), 'one\ntwo\n');
    for (const nul of ['/dev/null', 'nul']) {
      const r = spawnSync('git', ['diff', '--no-color', '--no-index', '--', nul, 'new.txt'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
      assert.equal(r.status, 1, `${nul}: ${r.stderr}`); // 1 = differs
      assert.match(r.stdout, /^\+one$/m, nul);
    }
    const n = spawnSync('git', ['diff', '--numstat', '--no-index', '--', '/dev/null', 'new.txt'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(n.status, 1, n.stderr);
    assert.match(n.stdout, /^2\t0\t/);
  });

  test('the UI diffs an untracked file against the null device', { skip: UI_SKIP }, async () => {
    const { fileDiff } = await import('../src/ui/git.mjs');
    const dir = makeRepo();
    dirs.push(dir);
    writeFileSync(path.join(dir, 'new.txt'), 'one\ntwo\n');
    const d = await fileDiff(dir, { path: 'new.txt', index: '?', worktree: '?' }, path.join(dir, 'new.txt'));
    assert.deepEqual(d.hunks[0].lines.map((l) => [l.type, l.text]), [['add', 'one'], ['add', 'two']]);
  });
});

describe('the chat on Windows', { skip: UI_SKIP }, () => {
  let h; // ./ui/helpers.mjs
  let c; // ./ui/chat-helpers.mjs
  let fake;
  let repo;
  let ui;
  let ev;
  let claudeCmd;

  test('setup: a fake claude .cmd in a folder with a space, a repo in a folder with a space', async () => {
    h = await import('./ui/helpers.mjs');
    c = await import('./ui/chat-helpers.mjs');
    fake = c.useFakeClaude(); // writes test/fixtures/fake-claude.cmd and points SHIPLINE_CLAUDE_BIN at it
    assert.match(process.env.SHIPLINE_CLAUDE_BIN, /fake-claude\.cmd$/);
    repo = repoAt('my repo');
    const binDir = path.join(repo.base, 'fake claude');
    mkdirSync(binDir);
    claudeCmd = writeCmdShim(path.join(binDir, 'claude.cmd'), FAKE_CLAUDE_MJS);
    process.env.SHIPLINE_CLAUDE_BIN = claudeCmd;
    ui = await h.startUi(repo.dir);
    ev = await h.openEvents(ui);
  });

  test('starting the fake-claude .cmd shim through the chat: shell start, a repo path with spaces', async () => {
    fake.script('normal-turn');
    const id = await c.startChat(ui, ev, 'Add "quoted" text & more');
    const runs = fake.runs();
    assert.equal(runs.length, 1);
    const r = runs[0];
    assert.equal(r.cwd.toLowerCase(), repo.dir.toLowerCase(), 'started in the repo root (with its space)');
    assert.equal(r.argv[r.argv.indexOf('--session-id') + 1], id);
    const mcp = r.argv[r.argv.indexOf('--mcp-config') + 1];
    assert.ok(existsSync(mcp), `the --mcp-config path arrived intact: ${mcp}`);
    assert.equal(r.shiplineEnv.SHIPLINE_SESSION, id, 'SHIPLINE_SESSION reached claude through the shell');
    await c.stopChat(ui, ev, id);
  });

  test('Stop leaves no fake-claude or child process in tasklist', async () => {
    fake.script('hang'); // starts a grandchild, then never exits on its own
    const id = await c.startChat(ui, ev, 'hang around');
    const recs = await c.waitUntil(() => {
      const all = fake.records();
      return all.find((x) => x.argv) && all.find((x) => x.child) ? all : null;
    }, 10_000);
    const pids = [recs.find((x) => x.argv).pid, recs.find((x) => x.child).child];
    assert.deepEqual(livePids(pids), pids, 'claude and its child are running');
    const end = await c.stopChat(ui, ev, id);
    assert.ok(end, 'the chat ended');
    await c.waitUntil(() => livePids(pids).length === 0, 5000).catch(() => {});
    assert.deepEqual(livePids(pids), [], 'taskkill /T took down claude and its child');
    assert.equal(existsSync(c.lockPath(repo.dir)), false, 'the lock is released');
    assert.equal(c.readSessions(repo.dir).find((x) => x.id === id).status, 'ended');
  });

  test('a .cmd claude whose script is gone after the health checks ends the chat with a fatal exit event', async () => {
    const copy = path.join(fake.scratch, 'claude-vanishing.mjs');
    copyFileSync(FAKE_CLAUDE_MJS, copy);
    const shim = writeCmdShim(path.join(fake.scratch, 'claude-vanishing.cmd'), copy);
    const saved = process.env.SHIPLINE_CLAUDE_BIN;
    try {
      // The copy answers --version and auth status, then deletes itself, so the start that follows fails.
      fake.script('normal-turn', { SHIPLINE_CLAUDE_BIN: shim, FAKE_CLAUDE_DELETE_SELF: '1' });
      const since = ev.mark();
      const r = await c.postChat(ui);
      assert.equal(existsSync(copy), false);
      assert.equal(r.status, 200, r.text);
      const fatal = await ev.waitFor(c.isEnd(r.json.id), 10_000, since);
      assert.equal(fatal.data.kind, 'fatal');
      assert.equal(fatal.data.reason, 'exit');
      assert.match(fatal.data.stderrTail, /Cannot find module|MODULE_NOT_FOUND/);
      assert.equal(existsSync(c.lockPath(repo.dir)), false);
    } finally {
      process.env.SHIPLINE_CLAUDE_BIN = saved;
    }
  });

  test('close() stops the chat\'s process tree and releases the lock', async () => {
    fake.script('hang');
    const id = await c.startChat(ui, ev, 'hang around');
    const recs = await c.waitUntil(() => (fake.records().find((x) => x.child) ? fake.records() : null), 10_000);
    const pids = [recs.find((x) => x.argv).pid, recs.find((x) => x.child).child];
    ev.close();
    ev = null;
    assert.equal(await ui.close(), 0);
    await c.waitUntil(() => livePids(pids).length === 0, 5000).catch(() => {});
    assert.deepEqual(livePids(pids), []);
    assert.equal(existsSync(c.lockPath(repo.dir)), false);
    assert.equal(c.readSessions(repo.dir).find((x) => x.id === id).status, 'ended');
  });

  test('teardown', async () => {
    if (ev) ev.close();
    if (ui) await ui.close();
    if (fake) fake.cleanup();
  });
});
