// Plan item 18: the SessionStart hook's additionalContext is byte-equal before and after item 4's refactor.
// "Before" is the interface-1 hook (test/fixtures/session-start/session-start.v1.mjs, the 0.3.0 file with its
// inline manifest loop and git call), run side by side with the current one on the same fixture repo.
// Phase 1: tasks live in the store. The v1 hook (unchanged, it scans cfg.artifact_root) is given an in-repo
// mirror of the store's tasks/ under docs/shipline (artifact_root kept as an unknown config key), so the
// output must still be byte-equal; task paths in it are now absolute store paths.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, git, hook, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';

let dir;
let tasks; // the store's tasks/ folder

function both(payload) {
  const now = hook(dir, 'session-start.mjs', payload);
  const v1 = hook(dir, 'session-start-v1.mjs', payload);
  assert.equal(now.code, 0, now.stderr);
  assert.equal(v1.code, 0, v1.stderr);
  return { now, v1 };
}

before(() => {
  dir = makeRepo({ commitInit: true });
  // The feature task below skips its ticket stage by hand, so this repo has a tracker (none would skip it on start).
  const cfgFile = path.join(dir, '.shipline', 'config.yml');
  writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace(/^tracker: none$/m, 'tracker: jira'));
  copyFileSync(path.join(FIXTURES, 'session-start', 'session-start.v1.mjs'), path.join(dir, '.shipline', 'bin', 'session-start-v1.mjs'));
  // Two open tasks: a feature task with one stage skipped and one done, and an untouched bugfix task.
  tasks = path.join(storeOf(dir), 'tasks');
  assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export', '--ticket', 'll-12'], 's1').code, 0);
  assert.equal(stage(dir, ['skip', '--reason', 'no ticket'], 's1').code, 0);
  writeFileSync(path.join(tasks, 'LL-12-add-export/feasibility.md'), '## Risks\nNone: a contained, additive change behind a flag.\n'); // feasibility requires a Risks section (Phase 2)
  const adv = stage(dir, ['advance'], 's1');
  assert.equal(adv.code, 0, adv.stderr);
  assert.equal(stage(dir, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 's2').code, 0);
  // A finished task is not listed.
  assert.equal(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Done already'], 's3').code, 0);
  const done = path.join(tasks, 'done-already/manifest.json');
  const m = JSON.parse(readFileSync(done, 'utf8'));
  for (const s of m.stages) s.status = 'done';
  writeFileSync(done, JSON.stringify(m));
  assert.ok(!existsSync(path.join(dir, 'docs')), 'stage.mjs wrote nothing into the repo');
  // The mirror for the v1 hook.
  cpSync(tasks, path.join(dir, 'docs', 'shipline'), { recursive: true });
  // `setup: done` keeps the 0.10.0 once-per-developer setup nudge (a systemMessage the v1 hook never printed) out
  // of the comparison; the nudge has its own tests in session-start-nudge.test.mjs.
  appendFileSync(path.join(dir, '.shipline', 'config.yml'), '\nartifact_root: docs/shipline\nsetup: done\n');
  git(dir, 'switch', '-q', '-c', 'feature/LL-12-add-export');
});

after(() => removeDir(dir));

test('a new session on the branch of exactly one open task is bound to it (D1) and told about the other session (D3)', () => {
  const now = hook(dir, 'session-start.mjs', { session_id: 'fresh', cwd: dir, hook_event_name: 'SessionStart', source: 'clear' });
  assert.equal(now.code, 0, now.stderr);
  const ctx = now.json.hookSpecificOutput.additionalContext;
  assert.equal(now.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const lines = ctx.split('\n');
  assert.equal(lines[0], 'Shipline is installed. Session id: fresh (stage commands read $SHIPLINE_SESSION, or pass --session fresh).');
  assert.equal(lines[1], 'Shipline: continuing task LL-12-add-export (feature workflow), current stage "questions". Run: node .shipline/bin/stage.mjs status');
  assert.match(lines[2], /^Another Claude session \(s1\) was working on this task \d+ min ago\. Both sessions now see it; avoid editing the same files\.$/);
  assert.equal(lines.length, 3);
  const state = JSON.parse(readFileSync(path.join(storeOf(dir), 'state', 'fresh.json'), 'utf8'));
  assert.equal(state.task_dir, path.join(tasks, 'LL-12-add-export'));
  assert.equal(state.workflow, 'feature');
  assert.equal(JSON.parse(readFileSync(path.join(tasks, 'LL-12-add-export', 'owner.json'), 'utf8')).session, 'fresh');
});

test('a session already bound to a task: byte-equal', () => {
  const { now, v1 } = both({ session_id: 's2', cwd: dir });
  assert.equal(now.stdout, v1.stdout);
  assert.ok(
    now.json.hookSpecificOutput.additionalContext.includes(`already working on task ${path.join(tasks, 'fix-crash')} (bugfix workflow)`),
    now.stdout,
  );
});

test('an odd session id and a branch no task uses: the v1 listing, plus each task\'s age (D4)', () => {
  git(dir, 'switch', '-q', '-c', 'other');
  try {
    const { now, v1 } = both({ session_id: 'x/y z', cwd: dir });
    assert.equal(now.stdout.replace(/ \(\d+d ago\)/g, ''), v1.stdout);
    assert.match(now.json.hookSpecificOutput.additionalContext, /- fix-crash \[bugfix\]: nothing done yet, next: ticket \(0d ago\)/);
    assert.ok(!now.stdout.includes('matches the current git branch'));
  } finally {
    git(dir, 'switch', '-q', 'feature/LL-12-add-export');
  }
});

test('the current hook reads the store, not artifact_root: with the mirror gone it still lists both tasks', () => {
  git(dir, 'switch', '-q', 'other');
  const saved = path.join(dir, 'docs');
  const tmp = path.join(dir, 'docs-moved');
  try {
    const r = hook(dir, 'session-start.mjs', { session_id: 'fresh2', cwd: dir });
    cpSync(saved, tmp, { recursive: true });
    run('rm', ['-rf', saved]);
    const again = hook(dir, 'session-start.mjs', { session_id: 'fresh2', cwd: dir });
    assert.equal(again.stdout, r.stdout);
    assert.match(again.json.hookSpecificOutput.additionalContext, /- fix-crash \[bugfix\]/);
    assert.match(again.json.hookSpecificOutput.additionalContext, /- LL-12-add-export \[feature\]/);
  } finally {
    if (existsSync(tmp)) {
      cpSync(tmp, saved, { recursive: true });
      run('rm', ['-rf', tmp]);
    }
    git(dir, 'switch', '-q', 'feature/LL-12-add-export');
  }
});

test('CLAUDE_ENV_FILE gets the SHIPLINE_SESSION export', () => {
  const envDir = tmpDir();
  try {
    const envFile = path.join(envDir, 'env');
    writeFileSync(envFile, '');
    const withEnv = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'session-start.mjs')], {
      cwd: dir,
      input: JSON.stringify({ session_id: 'abc', cwd: dir }),
      env: { CLAUDE_ENV_FILE: envFile },
    });
    assert.equal(withEnv.code, 0);
    assert.equal(readFileSync(envFile, 'utf8'), 'export SHIPLINE_SESSION=abc\n');
  } finally {
    removeDir(envDir);
  }
});
