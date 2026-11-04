// Plan item 16: the guard's lost-task warning and visible warn reminders (Goals 2 and 3), on a real temp repo.
// Phase 1: tasks and state live in the store ($SHIPLINE_HOME/projects/<encoded>/), task paths are absolute,
// and {artifact_root} allow_paths entries never match (the guard filters them out).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, hook, makeRepo, removeDir, stage, storeOf } from './helpers.mjs';

const WARN_WORKFLOW = `id: spike
name: Spike
stages:
  - id: explore
    name: Explore
    artifact: notes.md
    enforcement: warn
    blocks:
      - tools: 'Edit|Write'
        allow_paths: ["{artifact_root}/**"]
      - bash: '\\bgit\\s+commit\\b'
  - id: build
    name: Build
    enforcement: guide
`;

let dir;
let task; // { dir, branch } of the feature task started by session s1 (dir is the absolute store path)
const marker = (name) => path.join(storeOf(dir), 'state', `${name}.lost-warned`);

const edit = (session, file = 'src/a.js') => ({
  session_id: session,
  cwd: dir,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: path.isAbsolute(file) ? file : path.join(dir, file), old_string: 'a', new_string: 'b' },
});

const lostMessage = (branch, taskDir) =>
  `Shipline: branch ${branch} belongs to unfinished task ${taskDir}, but this session isn't tracking it, ` +
  `so its stage rules are not enforced. Run: node .shipline/bin/stage.mjs resume ${taskDir}`;

before(() => {
  dir = makeRepo({ commitInit: true });
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'spike.yml'), WARN_WORKFLOW);
  const r = stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 's1');
  assert.equal(r.code, 0, r.stderr);
  const taskDir = path.join(storeOf(dir), 'tasks', 'add-export');
  assert.ok(r.stdout.includes(`Started Feature task in ${taskDir}`), r.stdout);
  const manifest = JSON.parse(readFileSync(path.join(taskDir, 'manifest.json'), 'utf8'));
  task = { dir: taskDir, branch: manifest.task.branch };
  assert.ok(!existsSync(path.join(dir, 'docs')), 'nothing is written to the repo');
  assert.equal(task.branch, 'feature/add-export');
  // stage.mjs only suggests the branch; it doesn't create it.
  git(dir, 'switch', '-q', '-c', task.branch);
});

after(() => removeDir(dir));

describe('lost-task warning', () => {
  test('a session with no state file on a task branch is warned once', () => {
    const first = hook(dir, 'guard.mjs', edit('s2'));
    assert.equal(first.code, 0);
    assert.deepEqual(first.json, { systemMessage: lostMessage(task.branch, task.dir) });
    assert.ok(existsSync(marker('s2')));

    const second = hook(dir, 'guard.mjs', edit('s2'));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '');
  });

  test('the marker file name uses safeId for unusual session ids', () => {
    const r = hook(dir, 'guard.mjs', edit('a/b:c'));
    assert.equal(r.json.systemMessage, lostMessage(task.branch, task.dir));
    assert.ok(existsSync(marker('a_b_c')));
  });

  test('a Bash call is warned too, and never denied', () => {
    const r = hook(dir, 'guard.mjs', { session_id: 's-bash', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json), ['systemMessage']);
  });

  test('on a branch that no task uses, nothing is printed and no marker is written', () => {
    git(dir, 'switch', '-q', '-c', 'unrelated');
    try {
      const r = hook(dir, 'guard.mjs', edit('s3'));
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.ok(!existsSync(marker('s3')));
    } finally {
      git(dir, 'switch', '-q', task.branch);
    }
  });

  test('a finished task on the branch is not "lost"', () => {
    const file = path.join(task.dir, 'manifest.json');
    const original = readFileSync(file, 'utf8');
    const m = JSON.parse(original);
    for (const s of m.stages) s.status = 'done';
    writeFileSync(file, JSON.stringify(m));
    try {
      const r = hook(dir, 'guard.mjs', edit('s4'));
      assert.equal(r.stdout, '');
    } finally {
      writeFileSync(file, original);
    }
  });

  test('an error on this path (broken config.yml) still exits 0 without denying', () => {
    const file = path.join(dir, '.shipline', 'config.yml');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, 'branch_pattern: [unclosed\n  bad: indent\n');
    try {
      const r = hook(dir, 'guard.mjs', edit('s5'));
      assert.equal(r.code, 0);
      assert.ok(!r.stdout.includes('"deny"'));
    } finally {
      writeFileSync(file, original);
    }
  });

  test('the session that owns the task gets no lost-task warning', () => {
    const r = hook(dir, 'guard.mjs', edit('s1'));
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('belongs to unfinished task'), r.stdout);
  });
});

describe('enforcement output', () => {
  test('a block stage denies with the unchanged output and the "Shipline (" prefix', () => {
    // Feature: the plan stage (block) isn't done, so a source edit is held back.
    const r = hook(dir, 'guard.mjs', edit('s1'));
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
    const h = r.json.hookSpecificOutput;
    assert.equal(h.hookEventName, 'PreToolUse');
    assert.equal(h.permissionDecision, 'deny');
    assert.ok(h.permissionDecisionReason.startsWith('Shipline ('), h.permissionDecisionReason);
    assert.equal(
      h.permissionDecisionReason,
      'Shipline (Feature workflow, task add-export): Edit on src/a.js needs the "Plan" stage to be done first. ' +
        'Finish it, then record it with: node .shipline/bin/stage.mjs advance Do not work around this; tell the developer what is missing.',
    );
  });

  test('an artifact write (in the store, outside the repo) is allowed in a block stage', () => {
    const r = hook(dir, 'guard.mjs', edit('s1', `${task.dir}/plan.md`));
    assert.equal(r.stdout, '');
  });

  test('a warn stage outputs both systemMessage and additionalContext', () => {
    const r0 = stage(dir, ['start', '--workflow', 'spike', '--title', 'Try it'], 'w1');
    assert.equal(r0.code, 0, r0.stderr);
    const r = hook(dir, 'guard.mjs', edit('w1'));
    assert.equal(r.code, 0);
    const msg =
      'Shipline (Spike workflow, task try-it): Edit on src/a.js needs the "Explore" stage to be done first. ' +
      'Finish it, then record it with: node .shipline/bin/stage.mjs advance';
    assert.deepEqual(r.json, {
      systemMessage: `Shipline reminder: ${msg}`,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Reminder: ${msg}` },
    });

    const bash = hook(dir, 'guard.mjs', { session_id: 'w1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git commit -m wip' } });
    assert.ok(bash.json.systemMessage.startsWith('Shipline reminder: Shipline (Spike workflow'));
    assert.ok(bash.json.hookSpecificOutput.additionalContext.startsWith('Reminder: '));
    assert.equal(bash.json.hookSpecificOutput.permissionDecision, undefined);
  });

  test('an old {artifact_root} allow_paths entry never matches: an in-repo docs/shipline write is still held back', () => {
    // spike.yml's explore stage allows only "{artifact_root}/**"; the guard drops that entry.
    const r = hook(dir, 'guard.mjs', edit('w1', 'docs/shipline/try-it/notes.md'));
    assert.equal(r.code, 0);
    assert.ok(r.json.systemMessage.startsWith('Shipline reminder: Shipline (Spike workflow'), r.stdout);
    assert.match(r.json.systemMessage, /Edit on docs\/shipline\/try-it\/notes\.md/);
  });

  test('a call the warn rule does not match prints nothing', () => {
    const r = hook(dir, 'guard.mjs', { session_id: 'w1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.stdout, '');
  });
});
