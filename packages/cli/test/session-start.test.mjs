// Plan item 18: the SessionStart hook's additionalContext is byte-equal before and after item 4's refactor.
// "Before" is the interface-1 hook (test/fixtures/session-start/session-start.v1.mjs, the 0.3.0 file with its
// inline manifest loop and git call), run side by side with the current one on the same fixture repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, git, hook, makeRepo, removeDir, run, stage, tmpDir } from './helpers.mjs';

let dir;

function both(payload) {
  const now = hook(dir, 'session-start.mjs', payload);
  const v1 = hook(dir, 'session-start-v1.mjs', payload);
  assert.equal(now.code, 0, now.stderr);
  assert.equal(v1.code, 0, v1.stderr);
  return { now, v1 };
}

before(() => {
  dir = makeRepo({ commitInit: true });
  copyFileSync(path.join(FIXTURES, 'session-start', 'session-start.v1.mjs'), path.join(dir, '.shipline', 'bin', 'session-start-v1.mjs'));
  // Two open tasks: a feature task with one stage skipped and one done, and an untouched bugfix task.
  assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export', '--ticket', 'll-12'], 's1').code, 0);
  assert.equal(stage(dir, ['skip', '--reason', 'no ticket'], 's1').code, 0);
  writeFileSync(path.join(dir, 'docs/shipline/LL-12-add-export/feasibility.md'), 'ok\n');
  const adv = stage(dir, ['advance'], 's1');
  assert.equal(adv.code, 0, adv.stderr);
  assert.equal(stage(dir, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 's2').code, 0);
  // A finished task is not listed.
  assert.equal(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Done already'], 's3').code, 0);
  const done = path.join(dir, 'docs/shipline/done-already/manifest.json');
  const m = JSON.parse(readFileSync(done, 'utf8'));
  for (const s of m.stages) s.status = 'done';
  writeFileSync(done, JSON.stringify(m));
  git(dir, 'switch', '-q', '-c', 'feature/LL-12-add-export');
});

after(() => removeDir(dir));

test('a new session with two open tasks: output is byte-equal to the interface-1 hook', () => {
  const { now, v1 } = both({ session_id: 'fresh', cwd: dir, hook_event_name: 'SessionStart' });
  assert.equal(now.stdout, v1.stdout);
  const ctx = now.json.hookSpecificOutput.additionalContext;
  assert.equal(now.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const lines = ctx.split('\n');
  assert.equal(lines[0], 'Shipline is installed. Session id: fresh (stage commands read $SHIPLINE_SESSION, or pass --session fresh).');
  assert.equal(lines[1], 'Unfinished Shipline tasks (offer to resume; if several, list them and ask which):');
  assert.deepEqual(lines.slice(2, 4).sort(), [
    '- LL-12-add-export [feature]: feasibility done, next: questions (matches the current git branch, likely this one)',
    '- fix-crash [bugfix]: nothing done yet, next: jira',
  ]);
  assert.equal(lines[4], 'To resume: node .shipline/bin/stage.mjs resume <task folder>');
  assert.equal(lines.length, 5);
});

test('a session already bound to a task: byte-equal', () => {
  const { now, v1 } = both({ session_id: 's2', cwd: dir });
  assert.equal(now.stdout, v1.stdout);
  assert.match(now.json.hookSpecificOutput.additionalContext, /already working on task docs\/shipline\/fix-crash \(bugfix workflow\)/);
});

test('an odd session id and a branch no task uses: byte-equal', () => {
  git(dir, 'switch', '-q', '-c', 'other');
  try {
    const { now, v1 } = both({ session_id: 'x/y z', cwd: dir });
    assert.equal(now.stdout, v1.stdout);
    assert.ok(!now.stdout.includes('matches the current git branch'));
  } finally {
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
