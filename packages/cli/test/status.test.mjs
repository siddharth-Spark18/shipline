// Shipline 1.0 (docs/plans/shipline-1.0.md), item 20: `stage.mjs status` for humans. Without a session it lists the
// unfinished tasks of the current branch (all of them outside git) instead of failing; with one it prints a short
// status by default, and --verbose adds the rules text and the full store paths. "UI work: unknown | yes | no".
// Runs the vendored stage.mjs of real temp repos. Node 18+ (test:hooks).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, makeRepo, removeDir, runInit, stage, storeOf, tmpDir } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeDir));

describe('status without a session', () => {
  let dir;
  before(() => {
    dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    // Two unfinished tasks on feature/add-export's branch and one on another branch; one finished task.
    assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 'st1').code, 0);
    assert.equal(stage(dir, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 'st2').code, 0);
    assert.equal(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Done already'], 'st3').code, 0);
    const done = path.join(storeOf(dir), 'tasks', 'done-already', 'manifest.json');
    const m = JSON.parse(readFileSync(done, 'utf8'));
    for (const s of m.stages) s.status = 'done';
    writeFileSync(done, JSON.stringify(m));
    // The bugfix task claims the same branch as the feature task, so two tasks show there.
    const bug = path.join(storeOf(dir), 'tasks', 'fix-crash', 'manifest.json');
    const b = JSON.parse(readFileSync(bug, 'utf8'));
    b.task.branch = 'feature/add-export';
    writeFileSync(bug, JSON.stringify(b));
  });

  test('on a branch no task uses: "No unfinished tasks on <branch>." and exit 0', () => {
    const r = stage(dir, ['status']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'No unfinished tasks on main.\n');
  });

  test('on a task\'s branch: its unfinished tasks with workflow and current stage, and how to resume', () => {
    git(dir, 'checkout', '-q', '-b', 'feature/add-export');
    try {
      const r = stage(dir, ['status']);
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.split('\n');
      assert.equal(lines[0], 'Unfinished tasks on feature/add-export:');
      assert.deepEqual(lines.slice(1, 3).sort(), ['  add-export (feature) - current stage: feasibility', '  fix-crash (bugfix) - current stage: reproduce'].sort());
      assert.ok(!r.stdout.includes('done-already'));
      assert.match(r.stdout, /\nTo continue one, start Claude Code in this repo and run: node \.shipline\/bin\/stage\.mjs resume <slug>\n$/);
      const j = stage(dir, ['status', '--json']);
      assert.equal(j.code, 0, j.stderr);
      const data = JSON.parse(j.stdout);
      assert.equal(data.branch, 'feature/add-export');
      assert.deepEqual(data.tasks.map((t) => t.slug).sort(), ['add-export', 'fix-crash']);
      const fe = data.tasks.find((t) => t.slug === 'add-export');
      assert.deepEqual(fe, { slug: 'add-export', workflow: 'feature', stage: 'feasibility', task_dir: path.join(storeOf(dir), 'tasks', 'add-export') });
    } finally {
      git(dir, 'checkout', '-q', 'main');
    }
  });

  test('outside a git repo: the branch is unknown, so every unfinished task is listed', () => {
    const plain = tmpDir('shipline-status-nogit-');
    dirs.push(plain);
    assert.equal(runInit(plain).code, 0);
    const none = stage(plain, ['status']);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, 'No unfinished tasks.\n');
    assert.equal(stage(plain, ['start', '--workflow', 'small', '--title', 'One', '--ui', 'false'], 'p1').code, 0);
    assert.equal(stage(plain, ['start', '--workflow', 'hotfix', '--title', 'Two'], 'p2').code, 0);
    const r = stage(plain, ['status']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Unfinished tasks:\n/);
    assert.match(r.stdout, /^ {2}one \(small\) - current stage: /m);
    assert.match(r.stdout, /^ {2}two \(hotfix\) - current stage: /m);
    assert.equal(JSON.parse(stage(plain, ['status', '--json']).stdout).branch, null);
  });

  test('--task still works without a session (it is not the branch listing)', () => {
    const r = stage(dir, ['status', '--task', 'add-export']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Task add-export \(feature\) UI work: unknown$/m);
  });
});

describe('status with a session: short by default, --verbose for the rules and paths', () => {
  let dir;
  let taskDir;
  before(() => {
    dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 'v1').code, 0);
    taskDir = path.join(storeOf(dir), 'tasks', 'add-export');
  });

  test('short: the stage list, the current stage, its artifact and the next step; no rules text or store path', () => {
    const r = stage(dir, ['status'], 'v1');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        'Task add-export (feature) UI work: unknown',
        '[-] ticket (No tracker)',
        '[>] feasibility',
        '[ ] questions',
        '[ ] plan',
        '[ ] wireframes',
        '[ ] implement',
        '[ ] verify',
        '[ ] pr',
        '',
        'Current stage: Feasibility [feasibility]',
        'Artifact: feasibility.md (not written yet)',
        'Next: write feasibility.md, then node .shipline/bin/stage.mjs advance',
        '(--verbose adds the stage rules and full paths)',
        '',
      ].join('\n'),
    );
    assert.ok(!r.stdout.includes(taskDir));
    assert.ok(!/ui=/.test(r.stdout), 'ui=null is gone');
  });

  test('--verbose: the full store path and the stage rules', () => {
    const r = stage(dir, ['status', '--verbose'], 'v1');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith(`Task ${taskDir} (feature) UI work: unknown\n`), r.stdout);
    assert.match(r.stdout, /Enforcement: guide\./);
    assert.match(r.stdout, /Artifact to produce: .*feasibility\.md/);
    assert.ok(r.stdout.includes(taskDir));
  });

  test('UI work: yes and no after `flag ui`; the artifact line drops "(not written yet)" once it exists', () => {
    assert.equal(stage(dir, ['flag', 'ui', 'true'], 'v1').code, 0);
    assert.match(stage(dir, ['status'], 'v1').stdout, /^Task add-export \(feature\) UI work: yes$/m);
    assert.equal(stage(dir, ['flag', 'ui', 'false'], 'v1').code, 0);
    assert.match(stage(dir, ['status'], 'v1').stdout, /^Task add-export \(feature\) UI work: no$/m);
    writeFileSync(path.join(taskDir, 'feasibility.md'), '## Risks\nNone: a contained, additive change.\n');
    const r = stage(dir, ['status'], 'v1');
    assert.match(r.stdout, /^Artifact: feasibility\.md$/m);
    assert.match(r.stdout, /^Next: node \.shipline\/bin\/stage\.mjs advance$/m);
  });

  test('a stage that asks to advance says so; a checks stage says "Checks: not run" and to run check', () => {
    assert.equal(stage(dir, ['advance'], 'v1').code, 0); // feasibility -> questions (asks to advance in standard)
    writeFileSync(path.join(taskDir, 'questions.md'), '# Questions\n\nNone left open after the review.\n');
    assert.match(stage(dir, ['status'], 'v1').stdout, /^Next: node \.shipline\/bin\/stage\.mjs advance \(it asks the developer to confirm\)$/m);
    // Jump the manifest to verify (a checks stage) to see its lines.
    const mf = path.join(taskDir, 'manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    for (const s of m.stages) s.status = s.id === 'verify' ? 'in_progress' : s.id === 'pr' ? 'pending' : s.status === 'skipped' ? 'skipped' : 'done';
    writeFileSync(mf, JSON.stringify(m, null, 2));
    const r = stage(dir, ['status'], 'v1');
    assert.match(r.stdout, /^Current stage: Verify \[verify\]$/m);
    assert.match(r.stdout, /^Checks: not run$/m);
    assert.match(r.stdout, /^Next: node \.shipline\/bin\/stage\.mjs check$/m);
  });
});
