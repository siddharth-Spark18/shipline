// Teams Phase 2 (docs/plans/shipline-teams-phase2.md), B, C, D and Tests: the gate on a `checks: true` stage
// (a recorded run, on the current code, passed or accepted through the `accept` confirmation), the required
// sections check on `advance`, and the Checks line, collapsed blocks and v2 JSON of `stage.mjs pr-summary`.
// Runs the vendored scripts of a real temp repo. Commands are `"<node>" "<script>"` with absolute paths, so they
// run the same under sh and cmd.exe. Node 18+, so it stays in test:hooks.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hook, makeRepo, removeDir, stage, storeOf, tmpDir } from './helpers.mjs';
import { fingerprint } from '../templates/shipline/bin/lib.mjs';

// plan (sections) -> verify (checks + sections) -> pr. GATE_CONFIRM's verify also asks to advance.
const workflow = (id, confirm) => `id: ${id}
name: ${id}
stages:
  - id: plan
    name: Plan
    artifact: plan.md
    sections: [Scope, Files to touch, Verification]
    enforcement: guide
  - id: verify
    name: Verify
    artifact: verification.md
    checks: true
    sections: [Checklist]
    enforcement: guide
    confirm_to_advance: ${confirm}
  - id: pr
    name: PR
    enforcement: guide
`;

const TEXT = 'Enough real text to pass the twenty character minimum.';
const PLAN = `# Plan\n\n## Scope\n\nThe CSV export, nothing else.\n\n## Files to touch\n\n- src/a.js (modify): add the export\n\n## Verification\n\n${TEXT}\n`;
const VERIFICATION = `# Verification\n\n## Checklist\n\n- [x] export works\n- [x] empty state\n`;

let dir;
let scripts;
let configText;
let srcA;
let n = 0;

const NODE = `"${process.execPath}"`;
const script = (name) => `${NODE} "${path.join(scripts, name)}"`;
const taskDir = (slug) => path.join(storeOf(dir), 'tasks', slug);
const manifest = (slug) => JSON.parse(readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8'));
const stageOf = (slug, id) => manifest(slug).stages.find((s) => s.id === id);
const sessionState = (session) => JSON.parse(readFileSync(path.join(storeOf(dir), 'state', `${session}.json`), 'utf8'));
const write = (slug, name, text) => writeFileSync(path.join(taskDir(slug), name), text);
const acceptQ = (slug, run) => `Finish "verify" in task ${slug} with failed checks: lint (run ${run})?`;
const advanceQ = (slug) => `Advance past "verify" in task ${slug}?`;

function setCommands(cmds) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const block = ['test', 'lint', 'build'].map((k) => `  ${k}: ${cmds[k] === undefined ? '""' : q(cmds[k])}`).join('\n');
  const re = /\ncommands:\n(?: {2}[^\n]*\n)*/;
  assert.match(configText, re);
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), configText.replace(re, `\ncommands:\n${block}\n`));
}
const PASSING = () => ({ test: script('pass.js'), lint: script('pass.js') });
const LINT_FAILS = () => ({ test: script('pass.js'), lint: script('fail3.js') });

// A task in `wf`, moved on to its verify stage (plan.md and verification.md written). Returns { session, slug }.
function atVerify(wf = 'gate') {
  const i = ++n;
  const session = `gate-s${i}`;
  const slug = `gate-task-${i}`;
  const r = stage(dir, ['start', '--workflow', wf, '--title', slug], session);
  assert.equal(r.code, 0, r.stderr);
  write(slug, 'plan.md', PLAN);
  const a = stage(dir, ['advance'], session);
  assert.equal(a.code, 0, a.stderr);
  write(slug, 'verification.md', VERIFICATION);
  return { session, slug };
}

// The developer answers the pending question (the PostToolUse hook input for AskUserQuestion).
function answer(session, question, label) {
  const r = hook(dir, 'record-answer.mjs', {
    session_id: session,
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: `toolu_${session}`,
    tool_input: { questions: [{ question, header: 'Shipline', options: [{ label }], multiSelect: false }] },
    tool_response: { answers: { [question]: label } },
  });
  assert.equal(r.code, 0, r.stderr);
}

// advance refused with this question printed.
function asks(session, question, options) {
  const r = stage(dir, ['advance'], session);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.stderr.includes(`  question: ${question}\n`), r.stderr);
  assert.ok(r.stderr.includes(`  options: ${options}\n`), r.stderr);
  return r;
}
const ACCEPT_OPTIONS = '"Finish anyway" and "Not yet"';
const ADVANCE_OPTIONS = '"Advance" and "Not yet"';

const check = (session) => stage(dir, ['check'], session);
const runId = (slug) => manifest(slug).checks.fingerprint.slice(0, 8);

before(() => {
  dir = makeRepo({ commitInit: true });
  scripts = tmpDir('shipline-gate-scripts-');
  writeFileSync(path.join(scripts, 'pass.js'), "console.log('ok');\n");
  writeFileSync(path.join(scripts, 'fail3.js'), "console.log('lint error');\nprocess.exit(3);\n");
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'gate.yml'), workflow('gate', false));
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'gateconfirm.yml'), workflow('gateconfirm', true));
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
  srcA = readFileSync(path.join(dir, 'src', 'a.js'), 'utf8');
});
after(() => {
  removeDir(dir);
  removeDir(scripts);
});

// ---------- sections ----------

describe('required sections on advance', () => {
  test('the stage text names the required sections, and the checks step on a checks stage', () => {
    const r = stage(dir, ['start', '--workflow', 'gate', '--title', 'describe me'], 'gate-describe');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Required sections in the artifact \(each needs real text under its heading\): Scope, Files to touch, Verification$/m);
    write('describe-me', 'plan.md', PLAN);
    const a = stage(dir, ['advance'], 'gate-describe');
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /^Required sections in the artifact \(each needs real text under its heading\): Checklist$/m);
    assert.match(a.stdout, /^Checks: run `node \.shipline\/bin\/stage\.mjs check` \(Bash timeout 600000 ms/m);
  });

  test('missing and empty sections are all named in one message; once written, advance goes through', () => {
    const session = 'gate-sections';
    assert.equal(stage(dir, ['start', '--workflow', 'gate', '--title', 'sections task'], session).code, 0);
    write('sections-task', 'plan.md', `# Plan\n\n## scope:\n\n${TEXT}\n\n## Verification\n\nTBD\n`);
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'shipline: plan.md is missing: Files to touch (no heading), Verification (too short: write at least 20 characters under it).\n');
    assert.equal(stageOf('sections-task', 'plan').status, 'in_progress');
    write('sections-task', 'plan.md', PLAN);
    assert.equal(stage(dir, ['advance'], session).code, 0);
    assert.equal(stageOf('sections-task', 'plan').status, 'done');
  });
});

// ---------- the gate ----------

describe('the gate on a checks: true stage', () => {
  test('no recorded run: refused', () => {
    setCommands(PASSING());
    const { session, slug } = atVerify();
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Run `node \.shipline\/bin\/stage\.mjs check` first\./);
    assert.equal(stageOf(slug, 'verify').status, 'in_progress');
  });

  test('a run on different code: refused until the code matches the run again; a passing run then finishes', () => {
    setCommands(PASSING());
    const { session, slug } = atVerify();
    assert.equal(check(session).code, 0);
    writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 42;\n');
    try {
      const r = stage(dir, ['advance'], session);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /The code changed since the last check run\. Run `stage\.mjs check` again\./);
    } finally {
      writeFileSync(path.join(dir, 'src', 'a.js'), srcA);
    }
    const ok = stage(dir, ['advance'], session);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(stageOf(slug, 'verify').status, 'done');
    assert.equal(stageOf(slug, 'verify').accepted, undefined, 'nothing to accept');
  });

  test('a failing run: the accept question; "Not yet" keeps it open, "Finish anyway" finishes with the acceptance stored; reopen clears it', () => {
    setCommands(LINT_FAILS());
    const { session, slug } = atVerify();
    assert.equal(check(session).code, 1);
    const q = acceptQ(slug, runId(slug));
    asks(session, q, ACCEPT_OPTIONS);
    const pend = sessionState(session).pending_confirm;
    assert.equal(pend.kind, 'accept');
    assert.equal(pend.question, q);
    // status prints the open question again, and says to run `advance` after the answer.
    assert.match(stage(dir, ['status'], session).stdout, /run `advance` after the developer answers/);
    answer(session, q, 'Not yet');
    const no = asks(session, q, ACCEPT_OPTIONS);
    assert.match(no.stderr, /they answered "Not yet" last time/);
    answer(session, q, 'Finish anyway');
    const ok = stage(dir, ['advance'], session);
    assert.equal(ok.code, 0, ok.stderr);
    const { checks } = manifest(slug);
    const v = stageOf(slug, 'verify');
    assert.equal(v.status, 'done');
    assert.deepEqual(v.accepted, { names: ['lint'], fingerprint: checks.fingerprint, ran_at: checks.ran_at });
    assert.equal(sessionState(session).pending_confirm, undefined);
    // reopen clears the acceptance.
    const re = stage(dir, ['reopen', 'verify'], session);
    assert.equal(re.code, 0, re.stderr);
    assert.equal(stageOf(slug, 'verify').accepted, undefined);
    assert.equal(stageOf(slug, 'verify').status, 'in_progress');
    // ...so the same failing run asks again.
    asks(session, q, ACCEPT_OPTIONS);
  });

  test('with confirm_to_advance too: accept first, then the advance question, each with its own answer', () => {
    setCommands(LINT_FAILS());
    const { session, slug } = atVerify('gateconfirm');
    assert.equal(check(session).code, 1);
    const q = acceptQ(slug, runId(slug));
    asks(session, q, ACCEPT_OPTIONS);
    answer(session, q, 'Finish anyway');
    // The acceptance is stored, and the advance question follows.
    asks(session, advanceQ(slug), ADVANCE_OPTIONS);
    const { checks } = manifest(slug);
    assert.deepEqual(stageOf(slug, 'verify').accepted, { names: ['lint'], fingerprint: checks.fingerprint, ran_at: checks.ran_at });
    assert.equal(stageOf(slug, 'verify').status, 'in_progress');
    assert.equal(sessionState(session).pending_confirm.kind, 'advance');
    // Still accepted on the next try, so it goes straight to the advance question again.
    asks(session, advanceQ(slug), ADVANCE_OPTIONS);
    answer(session, advanceQ(slug), 'Advance');
    const ok = stage(dir, ['advance'], session);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(stageOf(slug, 'verify').status, 'done');
    assert.equal(stageOf(slug, 'verify').confirmed.via, 'answer');
  });

  test('a new run voids the acceptance: a failing rerun asks again, a passing one goes on without it', () => {
    setCommands(LINT_FAILS());
    const { session, slug } = atVerify('gateconfirm');
    assert.equal(check(session).code, 1);
    const q = acceptQ(slug, runId(slug));
    asks(session, q, ACCEPT_OPTIONS);
    answer(session, q, 'Finish anyway');
    asks(session, advanceQ(slug), ADVANCE_OPTIONS);
    const first = manifest(slug).checks;
    // Rerun, still failing: same code, so the same question text, but a new run (ran_at), so it is asked again.
    assert.equal(check(session).code, 1);
    assert.notEqual(manifest(slug).checks.ran_at, first.ran_at);
    asks(session, q, ACCEPT_OPTIONS);
    // Rerun, now passing: no accept question; the stale acceptance doesn't show in the summary.
    setCommands(PASSING());
    assert.equal(check(session).code, 0);
    asks(session, advanceQ(slug), ADVANCE_OPTIONS);
    answer(session, advanceQ(slug), 'Advance');
    assert.equal(stage(dir, ['advance'], session).code, 0);
    const summary = stage(dir, ['pr-summary'], session).stdout;
    assert.match(summary, /^\*\*Checks:\*\* test ✓ \d+\.\ds · lint ✓ \d+\.\ds$/m);
    assert.ok(!summary.includes('(accepted)'), summary);
    assert.ok(!summary.includes('"accepted":true'), summary);
  });

  test('no commands configured: finishes without a run', () => {
    setCommands({});
    const { session, slug } = atVerify();
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stageOf(slug, 'verify').status, 'done');
    assert.equal(manifest(slug).checks, undefined);
  });

  test('the sections check comes before the gate', () => {
    setCommands(PASSING());
    const { session, slug } = atVerify();
    write(slug, 'verification.md', '# Verification\n');
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'shipline: verification.md is missing: Checklist (no heading).\n');
  });
});

// ---------- pr-summary ----------

describe('stage.mjs pr-summary: Checks line, collapsed blocks, v2 JSON', () => {
  const summaryOf = (session) => {
    const r = stage(dir, ['pr-summary'], session);
    assert.equal(r.code, 0, r.stderr);
    const m = /<!-- shipline:summary (.*) -->\n$/.exec(r.stdout);
    assert.ok(m, r.stdout);
    return { text: r.stdout, json: JSON.parse(m[1]) };
  };
  const checksLine = (text) => text.split('\n').find((l) => l.startsWith('**Checks:**'));

  test('the whole output: table, Checks line, the two blocks, then the JSON (v 2, checks without tails or commands)', () => {
    setCommands(PASSING());
    const { session, slug } = atVerify();
    assert.equal(check(session).code, 0);
    const { text, json } = summaryOf(session);
    const { checks } = manifest(slug);
    const d = (i) => (checks.results[i].duration_ms / 1000).toFixed(1);
    const expected = {
      v: 2,
      workflow: 'gate',
      task: slug,
      stages: [
        { id: 'plan', status: 'done', enforcement: 'guide', confirmed: 'auto' },
        { id: 'verify', status: 'pending', enforcement: 'guide', confirmed: null },
        { id: 'pr', status: 'pending', enforcement: 'guide', confirmed: null },
      ],
      checks: {
        fingerprint: checks.fingerprint,
        results: checks.results.map((r) => ({ name: r.name, exit: r.exit, duration_ms: r.duration_ms, accepted: false })),
      },
      // Teams Phase 3, E: nothing sensitive and nothing outside the plan (the changes are .shipline/ files).
      scope: { sensitive: [], outside_plan: [], accepted: false },
    };
    assert.equal(
      text,
      [
        '### Shipline',
        '| Stage | Status | Confirmed |',
        '| --- | --- | --- |',
        '| plan | done | auto |',
        '| verify | pending | — |',
        '| pr | pending | — |',
        '',
        `**Checks:** test ✓ ${d(0)}s · lint ✓ ${d(1)}s`,
        '',
        '**Scope:** no test, lint or CI files touched, nothing outside the plan',
        '',
        '<details><summary>Plan scope</summary>',
        '',
        'The CSV export, nothing else.',
        '',
        '</details>',
        '',
        '<details><summary>Verification checklist</summary>',
        '',
        '- [x] export works\n- [x] empty state',
        '',
        '</details>',
        `<!-- shipline:summary ${JSON.stringify(expected)} -->`,
        '',
      ].join('\n'),
    );
    assert.deepEqual(json, expected);
    for (const r of json.checks.results) assert.deepEqual(Object.keys(r), ['name', 'exit', 'duration_ms', 'accepted']);
  });

  test('a failing command: "(exit n)"; accepted: "(accepted)" and accepted: true in the JSON', () => {
    setCommands(LINT_FAILS());
    const { session, slug } = atVerify();
    assert.equal(check(session).code, 1);
    let s = summaryOf(session);
    assert.match(checksLine(s.text), /^\*\*Checks:\*\* test ✓ \d+\.\ds · lint ✗ \(exit 3\)$/);
    assert.deepEqual(s.json.checks.results.map((r) => [r.name, r.exit, r.accepted]), [['test', 0, false], ['lint', 3, false]]);
    const q = acceptQ(slug, runId(slug));
    asks(session, q, ACCEPT_OPTIONS);
    answer(session, q, 'Finish anyway');
    assert.equal(stage(dir, ['advance'], session).code, 0);
    s = summaryOf(session);
    assert.match(checksLine(s.text), /^\*\*Checks:\*\* test ✓ \d+\.\ds · lint ✗ \(accepted\)$/);
    assert.deepEqual(s.json.checks.results.map((r) => [r.name, r.exit, r.accepted]), [['test', 0, false], ['lint', 3, true]]);
  });

  test('code changed since the run: "(out of date)"', () => {
    setCommands(PASSING());
    const { session } = atVerify();
    assert.equal(check(session).code, 0);
    writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 7;\n');
    try {
      assert.match(checksLine(summaryOf(session).text), / \(out of date\)$/);
    } finally {
      writeFileSync(path.join(dir, 'src', 'a.js'), srcA);
    }
    assert.ok(!checksLine(summaryOf(session).text).includes('out of date'));
  });

  test('not run yet: "not run" and no checks in the JSON; no commands: "no commands configured"', () => {
    setCommands(PASSING());
    const { session } = atVerify();
    let s = summaryOf(session);
    assert.equal(checksLine(s.text), '**Checks:** not run');
    assert.equal(s.json.checks, undefined);
    setCommands({});
    s = summaryOf(session);
    assert.equal(checksLine(s.text), '**Checks:** no commands configured');
    assert.deepEqual(s.json.checks, { fingerprint: null, results: [] });
  });

  test('a block is cut at 3000 characters with "…(truncated)"; a missing artifact or section leaves its block out', () => {
    setCommands({});
    const { session, slug } = atVerify();
    const long = 'a'.repeat(2990) + ' ' + 'b'.repeat(2000);
    write(slug, 'plan.md', `## Scope\n\n${long}\n\n## Files to touch\n\nx\n`);
    let { text } = summaryOf(session);
    assert.ok(text.includes(`<details><summary>Plan scope</summary>\n\n${long.slice(0, 3000)}\n\n…(truncated)\n\n</details>`), text);
    // No Checklist section: that block is left out.
    write(slug, 'verification.md', '# Verification\n\nAll good, trust me.\n');
    ({ text } = summaryOf(session));
    assert.ok(!text.includes('Verification checklist'), text);
    // No plan.md at all: that block is left out too.
    rmSync(path.join(taskDir(slug), 'plan.md'));
    ({ text } = summaryOf(session));
    assert.ok(!text.includes('<details>'), text);
  });

  test('fingerprint in the JSON is the recorded one, the current code\'s id', () => {
    setCommands(PASSING());
    const { session } = atVerify();
    assert.equal(check(session).code, 0);
    assert.equal(summaryOf(session).json.checks.fingerprint, fingerprint(dir));
  });
});

// Guardrails 2.1 (docs/plans/shipline-guardrails-2-1.md): fail_first on the Reproduce stage of the shipped bugfix workflow.
describe('fail_first', () => {
  const REPRO = '# Reproduction\n\nSteps to reproduce the bug, with enough text to count.\n';
  const WITH_SECTION = `${REPRO}\n## Failing test\n\ntest/export.test.js fails: expected 1 but got 2 in the output.\n`;
  const NOTE_START = 'Shipline (fail-first): before changing any code, write a test that reproduces this bug and fails on the current code.';

  // Rewrites config.yml: the commands (default: none) and the fail_first block.
  function configure({ level = 'off', workflows = ['bugfix'], commands = {} } = {}) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const block = ['test', 'lint', 'build'].map((k) => `  ${k}: ${commands[k] === undefined ? '""' : q(commands[k])}`).join('\n');
    let text = configText.replace(/\ncommands:\n(?: {2}[^\n]*\n)*/, `\ncommands:\n${block}\n`);
    const re = /\nfail_first:\n(?: {2}[^\n]*\n)*/;
    assert.match(text, re, 'the shipped config has a fail_first block');
    text = text.replace(re, `\nfail_first:\n  level: ${level}\n  workflows: [${workflows.join(', ')}]\n`);
    writeFileSync(path.join(dir, '.shipline', 'config.yml'), text);
  }
  // A bugfix task at Reproduce. Returns { session, slug, started } (the `start` output).
  function atReproduce(wf = 'bugfix') {
    const i = ++n;
    const session = `ff-s${i}`;
    const slug = `ff-task-${i}`;
    const r = stage(dir, ['start', '--workflow', wf, '--title', slug], session);
    assert.equal(r.code, 0, r.stderr);
    return { session, slug, started: r.stdout };
  }
  const expectFail = (session, ...extra) => stage(dir, ['check', '--expect-fail', ...extra], session);

  after(() => writeFileSync(path.join(dir, '.shipline', 'config.yml'), configText));

  test('off (the default): no note, no requirement, and --expect-fail is refused', () => {
    configure({ level: 'off', commands: { test: script('fail3.js') } });
    const { session, slug, started } = atReproduce();
    assert.ok(started.includes('Current stage: Reproduce [reproduce]'), started);
    assert.ok(!started.includes('fail-first'), started);
    write(slug, 'reproduction.md', REPRO);
    assert.equal(stage(dir, ['advance'], session).code, 0);
    const r = expectFail(atReproduce().session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only applies at the Reproduce stage/);
  });

  test('note: printed with Reproduce before the repo rules, on resume too; advancing needs nothing more', () => {
    configure({ level: 'note' });
    const { session, slug, started } = atReproduce();
    assert.ok(started.includes(NOTE_START), started);
    assert.ok(started.includes('Name it in reproduction.md.'), started);
    assert.ok(!started.includes('## Failing test'), started);
    assert.ok(started.indexOf(NOTE_START) < started.indexOf('Repo rules for this stage'), 'the note comes before the repo rules');
    const s = stage(dir, ['status', '--verbose'], session);
    assert.ok(s.stdout.includes(NOTE_START), s.stdout);
    write(slug, 'reproduction.md', REPRO);
    assert.equal(stage(dir, ['advance'], session).code, 0);
  });

  test('not active for a workflow that is not listed, or for another stage', () => {
    configure({ level: 'proof', workflows: ['feature'], commands: { test: script('fail3.js') } });
    const { session, slug, started } = atReproduce();
    assert.ok(!started.includes('fail-first'), started);
    write(slug, 'reproduction.md', REPRO);
    assert.equal(stage(dir, ['advance'], session).code, 0, 'bugfix is not listed: nothing is required');
    configure({ level: 'note', workflows: ['gate'] });
    const g = stage(dir, ['start', '--workflow', 'gate', '--title', 'ff-gate'], 'ff-gate-s');
    assert.ok(!g.stdout.includes('fail-first'), 'a workflow with no reproduce stage gets no note');
  });

  test('section: the note says so, and advance is refused until "## Failing test" has text under it', () => {
    configure({ level: 'section' });
    const { session, slug, started } = atReproduce();
    assert.ok(started.includes('reproduction.md must have a `## Failing test` section'), started);
    write(slug, 'reproduction.md', REPRO);
    let r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /reproduction\.md is missing: Failing test \(no heading\)/);
    write(slug, 'reproduction.md', `${REPRO}\n## Failing test\n\nx\n`);
    r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Failing test \(too short/);
    write(slug, 'reproduction.md', WITH_SECTION);
    assert.equal(stage(dir, ['advance'], session).code, 0);
  });

  test('proof: refused with no test command, never downgraded', () => {
    configure({ level: 'proof' });
    const { session, slug } = atReproduce();
    write(slug, 'reproduction.md', WITH_SECTION);
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /fail_first is set to proof but no test command is configured\. Set commands\.test in \.shipline\/config\.yml, or skip this stage with a reason/);
    assert.equal(expectFail(session).code, 1);
  });

  test('proof: advance is refused until --expect-fail records a failing run; a passing run records nothing', () => {
    configure({ level: 'proof', commands: { test: script('pass.js') } });
    const { session, slug, started } = atReproduce();
    assert.ok(started.includes('check --expect-fail [test file or name]'), started);
    write(slug, 'reproduction.md', REPRO);
    let r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Reproduce can't finish until a failing test run is recorded/);

    r = expectFail(session, 'test/export.test.js');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /The test passed, so it doesn't reproduce the bug: nothing recorded\./);
    assert.equal(manifest(slug).fail_first, undefined);
    assert.equal(stage(dir, ['advance'], session).code, 1);

    configure({ level: 'proof', commands: { test: script('fail3.js') } });
    r = expectFail(session, 'test/export.test.js', '--grep=export,x');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Failing as expected \(exit 3\): recorded\./);
    const rec = manifest(slug).fail_first;
    assert.equal(rec.exit, 3);
    assert.ok(rec.command.endsWith('fail3.js" test/export.test.js --grep=export,x'), rec.command);
    assert.equal(rec.fingerprint, fingerprint(dir));
    assert.match(rec.ran_at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(rec.tail.includes('lint error'));
    r = stage(dir, ['advance'], session);
    assert.equal(r.code, 0, r.stderr);
  });

  test('--expect-fail refuses unsafe arguments with exit 2 and runs nothing', () => {
    const marker = path.join(scripts, 'ran.txt');
    configure({ level: 'proof', commands: { test: script('fail3.js') } });
    const { session, slug } = atReproduce();
    for (const bad of ['a b', 'x;touch', '$(id)', 'a|b', 'a&b', '`id`', 'x>y', '"q"', "'q'", '../up', 'a/../b', 'a\\b']) {
      const r = expectFail(session, bad);
      assert.equal(r.code, 2, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /only accepts a test file or name/);
    }
    assert.equal(manifest(slug).fail_first, undefined);
    assert.ok(!existsSync(marker));
  });

  test('proof and section: skipping Reproduce with a reason still works (the developer answers the skip question)', () => {
    configure({ level: 'proof', commands: { test: script('fail3.js') } });
    const { session, slug } = atReproduce();
    const q = `Skip "reproduce" in task ${slug}?`;
    let r = stage(dir, ['skip', '--reason', 'cannot reproduce locally'], session);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`  question: ${q}\n`), r.stderr);
    answer(session, q, 'Skip');
    r = stage(dir, ['skip', '--reason', 'cannot reproduce locally'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stageOf(slug, 'reproduce').status, 'skipped');
  });

  test('Verify and pr-summary show failed before, passed after', () => {
    configure({ level: 'proof', commands: { test: script('fail3.js') } });
    const { session, slug } = atReproduce();
    write(slug, 'reproduction.md', REPRO);
    assert.equal(expectFail(session).code, 0);
    const before = fingerprint(dir);
    assert.equal(stage(dir, ['advance'], session).code, 0);
    // The fix: the same test now passes.
    configure({ level: 'proof', commands: { test: script('pass.js') } });
    const c = check(session);
    assert.equal(c.code, 0, c.stderr);
    assert.ok(c.stdout.includes(`Fail-first: failed before (exit 3 on ${before.slice(0, 12)}), passed after (on ${manifest(slug).checks.fingerprint.slice(0, 12)})`), c.stdout);
    const s = stage(dir, ['pr-summary'], session);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /\*\*Fail-first:\*\* failed before \(exit 3 on [0-9a-f]{12}\), passed after \(on [0-9a-f]{12}\)/);
    const json = JSON.parse(/<!-- shipline:summary (.*) -->/.exec(s.stdout)[1]);
    assert.deepEqual(json.fail_first.before, { exit: 3, fingerprint: before });
    assert.equal(json.fail_first.after.exit, 0);
  });
});
