// Trust plan (docs/plans/shipline-trust.md), C and Tests: .shipline/bin/ci-check.mjs, the pull-request check.
// Runs the vendored script of a real temp repo the way the GitHub workflow does (cwd = the checkout, with
// GITHUB_EVENT_PATH and GITHUB_STEP_SUMMARY set). Node 18+, so it stays in test:hooks.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, git, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';

let dir;
let scratch;
let configText;
let n = 0;

before(() => {
  dir = makeRepo({ commitInit: true });
  scratch = tmpDir('shipline-ci-');
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
});
after(() => {
  removeDir(dir);
  removeDir(scratch);
});

// The shipped config.yml with its ci: block replaced (null = no ci: block at all).
function setCi(ci) {
  const base = configText.replace(/\n# Optional\. The pull-request check[\s\S]*$/, '\n');
  assert.notEqual(base, configText, 'the template ends with the ci block');
  const block = ci === null ? '' : `\nci:\n${Object.entries(ci).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), base + block);
}

// Runs ci-check.mjs for a PR with this body and these labels. Returns { code, stdout, stderr, summary }.
function check(body, labels = [], { event, cwd = dir, summary = true } = {}) {
  const i = ++n;
  const eventPath = path.join(scratch, `event-${i}.json`);
  const summaryPath = path.join(scratch, `summary-${i}.md`);
  writeFileSync(eventPath, event !== undefined ? event : JSON.stringify({ action: 'opened', pull_request: { number: 7, body, labels: labels.map((name) => ({ name })) } }));
  const env = { GITHUB_EVENT_PATH: eventPath, ...(summary ? { GITHUB_STEP_SUMMARY: summaryPath } : {}) };
  const r = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'ci-check.mjs')], { cwd, env });
  return { ...r, summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null };
}

// A PR body with a summary block for the feature workflow. Every stage is done (confirm stages by answer) unless
// overridden: overrides = { <id>: { status, confirmed } | null (left out) }.
const FEATURE = ['jira', 'feasibility', 'questions', 'plan', 'wireframes', 'implement', 'verify', 'pr'];
const CONFIRM = new Set(['questions', 'plan', 'wireframes', 'verify']);
function featureSummary(overrides = {}, extra = {}) {
  const stages = FEATURE.filter((id) => overrides[id] !== null).map((id) => ({
    id,
    status: 'done',
    enforcement: id === 'plan' || id === 'verify' ? 'block' : 'guide',
    confirmed: CONFIRM.has(id) ? 'answer' : 'auto',
    ...(overrides[id] || {}),
  }));
  return { v: 1, workflow: 'feature', task: 'add-export', stages, ...extra };
}
const block = (data) => `<!-- shipline:summary ${typeof data === 'string' ? data : JSON.stringify(data)} -->`;
const body = (data) => `Adds the CSV export.\n\n### Shipline\n| Stage | Status | Confirmed |\n| --- | --- | --- |\n${block(data)}\n`;

const errors = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::error title=Shipline::'));

describe('no summary block: ci.missing_block', () => {
  test('fail-unless-label (the default): fails without the label, passes with "shipline:skip"', () => {
    setCi({ missing_block: 'fail-unless-label', skip_label: 'shipline:skip' });
    const r = check('Just a description.');
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(errors(r), [
      '::error title=Shipline::This pull request has no Shipline summary. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output into the description, or add the "shipline:skip" label.',
    ]);
    const ok = check('Just a description.', ['bug', 'shipline:skip']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /^::notice title=Shipline::No Shipline summary, but the "shipline:skip" label is set\.$/m);
  });

  test('fail-unless-label with a custom skip_label: only that label counts', () => {
    setCi({ missing_block: 'fail-unless-label', skip_label: 'no-shipline' });
    assert.equal(check('x', ['shipline:skip']).code, 1);
    const r = check('x', ['no-shipline']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /"no-shipline" label is set/);
  });

  test('warn: passes with a ::warning:: annotation, with or without the label', () => {
    setCi({ missing_block: 'warn', skip_label: 'shipline:skip' });
    for (const labels of [[], ['shipline:skip']]) {
      const r = check('x', labels);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^::warning title=Shipline::This pull request has no Shipline summary\./m);
      assert.deepEqual(errors(r), []);
    }
  });

  test('fail: always fails, even with the label', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    for (const labels of [[], ['shipline:skip']]) {
      const r = check('x', labels);
      assert.equal(r.code, 1, r.stdout);
      assert.deepEqual(errors(r), ['::error title=Shipline::This pull request has no Shipline summary. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output into the description.']);
    }
  });

  test('no ci: section, or an unknown mode: the defaults apply (fail-unless-label, shipline:skip)', () => {
    for (const ci of [null, { missing_block: 'ignore', skip_label: '""' }]) {
      setCi(ci);
      assert.equal(check('x').code, 1, JSON.stringify(ci));
      assert.equal(check('x', ['shipline:skip']).code, 0, JSON.stringify(ci));
    }
  });

  test('a null body counts as no summary', () => {
    setCi({ missing_block: 'fail-unless-label', skip_label: 'shipline:skip' });
    const r = check(null, [], { event: JSON.stringify({ pull_request: { body: null, labels: [] } }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /has no Shipline summary/);
  });
});

describe('a summary block', () => {
  before(() => setCi({ missing_block: 'fail', skip_label: 'shipline:skip' }));

  test('a valid block passes and writes the table to the job summary', () => {
    const r = check(body(featureSummary()));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
    assert.match(r.stdout, /the feature workflow summary checks out \(8 stages\)/);
    assert.equal(
      r.summary,
      [
        '### Shipline: feature / add-export',
        '| Stage | Status | Confirmed |',
        '| --- | --- | --- |',
        '| jira | done | auto |',
        '| feasibility | done | auto |',
        '| questions | done | your answer |',
        '| plan | done | your answer |',
        '| wireframes | done | your answer |',
        '| implement | done | auto |',
        '| verify | done | your answer |',
        '| pr | done | auto |',
        '',
      ].join('\n'),
    );
  });

  test('skipped stages pass when they are not block stages, or when the skip was answered or automatic', () => {
    const r = check(
      body(featureSummary({ jira: { status: 'skipped', confirmed: 'auto' }, wireframes: { status: 'skipped', confirmed: 'auto' }, verify: { status: 'skipped', confirmed: 'answer' } })),
    );
    assert.equal(r.code, 0, r.stdout);
  });

  test('a block stage that is not done fails (pending, missing from the summary, or skipped with no recorded decision)', () => {
    const cases = [
      [{ plan: { status: 'pending', confirmed: null } }, 'Stage "plan" is a block stage and is not done (it is pending).'],
      [{ verify: null }, 'Stage "verify" is a block stage and is not done (it is missing from the summary).'],
      [{ verify: { status: 'skipped', confirmed: null } }, 'Stage "verify" is a block stage and is not done (it is skipped).'],
    ];
    for (const [over, message] of cases) {
      const r = check(body(featureSummary(over)));
      assert.equal(r.code, 1, r.stdout);
      assert.ok(errors(r).includes(`::error title=Shipline::${message}`), r.stdout);
      assert.ok(r.summary.includes(`- ${message}`), 'the problems are listed in the job summary too');
    }
  });

  test('enforcement comes from the repo\'s current workflow, not from the summary', () => {
    const r = check(body(featureSummary({ plan: { status: 'pending', enforcement: 'guide', confirmed: null } })));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Stage "plan" is a block stage and is not done/);
  });

  test('a confirm_to_advance stage marked done without confirmed: "answer" fails', () => {
    for (const confirmed of ['auto', null, undefined]) {
      const r = check(body(featureSummary({ questions: { confirmed } })));
      assert.equal(r.code, 1, `${confirmed}: ${r.stdout}`);
      assert.deepEqual(errors(r), ['::error title=Shipline::Stage "questions" needs the developer\'s confirmation, but the summary doesn\'t show their answer.']);
    }
  });

  test('JSON that doesn\'t parse fails', () => {
    const r = check(body('{"v":1,"workflow":"feature",'));
    assert.equal(r.code, 1);
    assert.match(errors(r)[0], /The Shipline summary in the description is not valid JSON \(.+\)\. Paste the output of `stage\.mjs pr-summary` again, unchanged\./);
    assert.equal(r.summary, null, 'nothing to summarize');
  });

  test('a block with no stage list fails', () => {
    const r = check(body({ v: 1, workflow: 'feature', task: 'x' }));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /has no stage list/);
  });

  test('an unknown workflow (or a bad workflow id) fails', () => {
    for (const workflow of ['research', '../config', '']) {
      const r = check(body(featureSummary({}, { workflow })));
      assert.equal(r.code, 1, workflow);
      assert.match(errors(r)[0], /The Shipline summary names a workflow this repo doesn't have/, workflow);
    }
  });

  test('the last block in the description wins', () => {
    const bad = block(featureSummary({ plan: { status: 'pending' } }));
    assert.equal(check(`${bad}\n\nUpdated:\n${body(featureSummary())}`).code, 0);
    assert.equal(check(`${body(featureSummary())}\n${bad}`).code, 1);
  });

  test('without GITHUB_STEP_SUMMARY it still checks, and writes no summary', () => {
    const r = check(body(featureSummary()), [], { summary: false });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.summary, null);
  });
});

describe('the event and the checkout', () => {
  test('an event with no pull_request fails', () => {
    const r = check('', [], { event: JSON.stringify({ push: {} }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /This check only runs on pull_request events\./);
  });

  test('an unreadable event file fails', () => {
    const r = check('', [], { event: 'not json' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Couldn't read the pull request event/);
  });

  test('a checkout without .shipline/config.yml fails', () => {
    const empty = tmpDir('shipline-ci-empty-');
    try {
      const r = check('x', [], { cwd: empty });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /No \.shipline\/config\.yml in this checkout/);
    } finally {
      removeDir(empty);
    }
  });
});

describe('end to end: stage.mjs pr-summary output pasted into a PR', () => {
  test('passes once every block stage is done with the developer\'s answers; fails while one is still open', () => {
    setCi({ missing_block: 'fail-unless-label', skip_label: 'shipline:skip' });
    const wf = `id: mini
name: Mini
stages:
  - id: plan
    enforcement: block
    confirm_to_advance: true
  - id: build
    enforcement: guide
  - id: verify
    enforcement: block
`;
    writeFileSync(path.join(dir, '.shipline', 'workflows', 'mini.yml'), wf);
    try {
      const s = 'ci-e2e';
      assert.equal(stage(dir, ['start', '--workflow', 'mini', '--title', 'E2E'], s).code, 0);
      const q = 'Advance past "plan" in task e2e?';
      assert.equal(stage(dir, ['advance'], s).code, 1);
      const rec = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'record-answer.mjs')], {
        cwd: dir,
        input: JSON.stringify({
          session_id: s,
          cwd: dir,
          hook_event_name: 'PostToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'toolu_e2e',
          tool_input: { questions: [{ question: q, header: 'Shipline', options: [{ label: 'Advance' }, { label: 'Not yet' }], multiSelect: false }] },
          tool_response: { answers: { [q]: 'Advance' } },
        }),
      });
      assert.equal(rec.code, 0, rec.stderr);
      assert.equal(stage(dir, ['advance'], s).code, 0, 'plan');
      assert.equal(stage(dir, ['advance'], s).code, 0, 'build');
      const open = check(`Change.\n\n${stage(dir, ['pr-summary'], s).stdout}`);
      assert.equal(open.code, 1, open.stdout);
      assert.match(open.stdout, /Stage "verify" is a block stage and is not done \(it is pending\)/);
      assert.equal(stage(dir, ['advance'], s).code, 0, 'verify');
      const done = check(`Change.\n\n${stage(dir, ['pr-summary'], s).stdout}`);
      assert.equal(done.code, 0, done.stdout);
      assert.match(done.summary, /\| plan \| done \| your answer \|/);
    } finally {
      rmSync(path.join(dir, '.shipline', 'workflows', 'mini.yml'), { force: true });
    }
  });
});

// Teams Phase 1, D: the stage was renamed `jira` -> `ticket`; a summary and a workflow may use either id.
describe('the jira/ticket alias and the Closes line', () => {
  const wfPath = () => path.join(dir, '.shipline', 'workflows', 'tix.yml');
  // A workflow whose ticket stage is a block stage, so a summary that fails to match it would fail the check.
  const tixWorkflow = (id) => `id: tix\nname: Tix\nstages:\n  - id: ${id}\n    artifact: ticket.md\n    enforcement: block\n  - id: build\n    enforcement: guide\n`;
  const tixSummary = (id, status) => ({
    v: 1,
    workflow: 'tix',
    task: 'issue-5-x',
    stages: [
      { id, status, enforcement: 'block', confirmed: status === 'done' ? 'auto' : null },
      { id: 'build', status: 'done', enforcement: 'guide', confirmed: 'auto' },
    ],
  });
  before(() => setCi({ missing_block: 'fail', skip_label: 'shipline:skip' }));
  after(() => rmSync(wfPath(), { force: true }));

  for (const [summaryId, workflowId] of [['jira', 'ticket'], ['ticket', 'jira'], ['ticket', 'ticket']]) {
    test(`a summary with \`${summaryId}\` against a workflow with \`${workflowId}\`: done passes, pending fails`, () => {
      writeFileSync(wfPath(), tixWorkflow(workflowId));
      const r = check(body(tixSummary(summaryId, 'done')));
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(errors(r), []);
      const p = check(body(tixSummary(summaryId, 'pending')));
      assert.equal(p.code, 1, p.stdout);
      assert.match(p.stdout, new RegExp(`Stage "${workflowId}" is a block stage and is not done \\(it is pending\\)`));
    });
  }

  test('a "Closes #123" line before the summary is ignored', () => {
    writeFileSync(wfPath(), tixWorkflow('ticket'));
    const r = check(`Closes #123\n${body(tixSummary('ticket', 'done'))}`);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
  });

  test('end to end with tracker: github: pr-summary (starting with Closes #5) pasted into a PR passes', () => {
    const cfg = path.join(dir, '.shipline', 'config.yml');
    const saved = readFileSync(cfg, 'utf8');
    writeFileSync(cfg, saved.replace('tracker: none', 'tracker: github'));
    writeFileSync(wfPath(), tixWorkflow('ticket'));
    try {
      const s = 'ci-github';
      assert.equal(stage(dir, ['start', '--workflow', 'tix', '--title', 'X', '--ticket', '#5'], s).code, 0);
      const task = path.join(storeOf(dir), 'tasks', 'issue-5-x');
      writeFileSync(path.join(task, 'ticket.md'), '# 5\n');
      assert.equal(stage(dir, ['advance'], s).code, 0);
      assert.equal(stage(dir, ['advance'], s).code, 0);
      const summary = stage(dir, ['pr-summary'], s).stdout;
      assert.ok(summary.startsWith('Closes #5\n### Shipline\n'), summary);
      const r = check(`Adds X.\n\n${summary}`);
      assert.equal(r.code, 0, r.stdout);
      rmSync(task, { recursive: true });
    } finally {
      writeFileSync(cfg, saved);
    }
  });
});

// ---------- Teams Phase 2, E: the checks in a v2 summary ----------

describe('v2 summaries: did the checks run on this code, and did they pass?', () => {
  const STALE =
    'The checks in the Shipline summary ran on different code than this PR (code changed after `stage.mjs check`, or the summary is from another task). Rerun `stage.mjs check` and paste `pr-summary` again.';
  const notices = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::notice title=Shipline::'));
  const warnings = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::warning title=Shipline::'));
  const esc = (m) => m.replace(/%/g, '%25');
  let head; // this checkout's HEAD^{tree}
  const result = (name, exit, accepted = false) => ({ name, exit, duration_ms: 1200, accepted });
  const v2 = (checks) => featureSummary({}, { v: 2, ...(checks === undefined ? {} : { checks }) });
  const noChecksWf = () => path.join(dir, '.shipline', 'workflows', 'nochecks.yml');

  before(() => {
    head = git(dir, 'rev-parse', 'HEAD^{tree}');
    writeFileSync(noChecksWf(), 'id: nochecks\nname: No checks\nstages:\n  - id: build\n    enforcement: block\n');
  });
  after(() => {
    rmSync(noChecksWf(), { force: true });
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
  });

  test('a v1 summary still passes, with a notice that freshness can\'t be checked (the workflow has a checks stage)', () => {
    for (const stale of ['warn', 'fail']) {
      setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: stale });
      const r = check(body(featureSummary()));
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(errors(r), []);
      assert.ok(notices(r).some((l) => /older Shipline \(v1\).*can't be checked/.test(l)), r.stdout);
    }
  });

  test('a fingerprint equal to HEAD^{tree}: "Checks ran on this exact code." and a Checks row in the job summary', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const r = check(body(v2({ fingerprint: head, results: [result('test', 0), result('lint', 0)] })));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(warnings(r), []);
    assert.ok(notices(r).includes('::notice title=Shipline::Checks ran on this exact code.'), r.stdout);
    assert.match(r.summary, /^\| pr \| done \| auto \|\n\| Checks \| test ✓ 1\.2s · lint ✓ 1\.2s \| — \|\n$/m);
  });

  test('a different fingerprint: a warning by default (passes), a failure with stale_checks: fail', () => {
    const data = v2({ fingerprint: 'f'.repeat(40), results: [result('test', 0)] });
    for (const ci of [{ missing_block: 'fail', skip_label: 'shipline:skip' }, { missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'warn' }]) {
      setCi(ci);
      const r = check(body(data));
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(errors(r), []);
      assert.deepEqual(warnings(r), [`::warning title=Shipline::${esc(STALE)}`]);
    }
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const r = check(body(data));
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(errors(r), [`::error title=Shipline::${esc(STALE)}`]);
    assert.ok(r.summary.includes(`- ${STALE}`));
  });

  test('a failed command the developer didn\'t accept fails, whatever stale_checks says; an accepted one passes', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'warn' });
    const failed = check(body(v2({ fingerprint: head, results: [result('test', 0), result('lint', 2)] })));
    assert.equal(failed.code, 1, failed.stdout);
    assert.deepEqual(errors(failed), ['::error title=Shipline::The lint command failed (exit 2) and the developer did not accept the failure.']);
    assert.match(failed.summary, /^\| Checks \| test ✓ 1\.2s · lint ✗ \(exit 2\) \| — \|$/m);
    const notRun = check(body(v2({ fingerprint: head, results: [result('build', null)] })));
    assert.equal(notRun.code, 1);
    assert.deepEqual(errors(notRun), ['::error title=Shipline::The build command failed (it did not run) and the developer did not accept the failure.']);
    const accepted = check(body(v2({ fingerprint: head, results: [result('test', 0), result('lint', 2, true)] })));
    assert.equal(accepted.code, 0, accepted.stdout);
    assert.deepEqual(errors(accepted), []);
    assert.match(accepted.summary, /^\| Checks \| test ✓ 1\.2s · lint ✗ \(accepted\) \| — \|$/m);
  });

  test('a null fingerprint: a notice, never a failure', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const r = check(body(v2({ fingerprint: null, results: [result('test', 0)] })));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(warnings(r), []);
    assert.ok(notices(r).some((l) => /no code fingerprint/.test(l)), r.stdout);
  });

  test('no commands configured (an empty run) passes, with "no commands configured" in the job summary', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const r = check(body(v2({ fingerprint: null, results: [] })));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.summary, /^\| Checks \| no commands configured \| — \|$/m);
  });

  test('a v2 summary without checks: stale behaviour when the workflow has a checks stage; fine when it has none', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const warn = check(body(v2()));
    assert.equal(warn.code, 0, warn.stdout);
    assert.deepEqual(warnings(warn), [`::warning title=Shipline::${esc(STALE)}`]);
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const fail = check(body(v2()));
    assert.equal(fail.code, 1, fail.stdout);
    assert.deepEqual(errors(fail), [`::error title=Shipline::${esc(STALE)}`]);
    const none = check(body({ v: 2, workflow: 'nochecks', task: 't', stages: [{ id: 'build', status: 'done', enforcement: 'block', confirmed: 'auto' }] }));
    assert.equal(none.code, 0, none.stdout);
    assert.deepEqual(errors(none), []);
    assert.deepEqual(warnings(none), []);
    assert.equal(none.summary.includes('| Checks |'), false);
  });

  test('an unknown summary version fails', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const r = check(body(featureSummary({}, { v: 3 })));
    assert.equal(r.code, 1);
    assert.match(errors(r)[0], /The Shipline summary is version 3, which this check doesn't know\./);
  });

  test('end to end: `check` on committed code, then pr-summary pasted into the PR: "Checks ran on this exact code."', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const wf = path.join(dir, '.shipline', 'workflows', 'ck.yml');
    const cfg = path.join(dir, '.shipline', 'config.yml');
    const savedCfg = readFileSync(cfg, 'utf8');
    writeFileSync(wf, 'id: ck\nname: Ck\nstages:\n  - id: verify\n    checks: true\n    enforcement: block\n');
    writeFileSync(cfg, savedCfg.replace(/\n {2}test: ""\n/, `\n  test: '"${process.execPath}" -e ""'\n`));
    try {
      // The PR's code is what is committed: the workflow and config edits are part of it.
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'ck');
      const s = 'ci-ck';
      assert.equal(stage(dir, ['start', '--workflow', 'ck', '--title', 'Ck'], s).code, 0);
      const c = stage(dir, ['check'], s);
      assert.equal(c.code, 0, c.stdout + c.stderr);
      assert.equal(stage(dir, ['advance'], s).code, 0);
      const r = check(`Change.\n\n${stage(dir, ['pr-summary'], s).stdout}`);
      assert.equal(r.code, 0, r.stdout);
      assert.ok(notices(r).includes('::notice title=Shipline::Checks ran on this exact code.'), r.stdout);
      // Another commit after the run: the PR's tree is no longer the one the checks saw.
      writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 99;\n');
      git(dir, 'commit', '-q', '-am', 'later');
      const stale = check(`Change.\n\n${stage(dir, ['pr-summary'], s).stdout}`);
      assert.equal(stale.code, 1, stale.stdout);
      assert.deepEqual(errors(stale), [`::error title=Shipline::${esc(STALE)}`]);
    } finally {
      rmSync(wf, { force: true });
      writeFileSync(cfg, savedCfg);
    }
  });
});

// ---------- Teams Phase 3, E: the scope in a v2 summary (information only) ----------

describe('v2 summaries: the scope is shown, never a failure', () => {
  const notices = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::notice title=Shipline::'));
  let head;
  const result = (name, exit) => ({ name, exit, duration_ms: 1200, accepted: false });
  const withScope = (scope) => featureSummary({}, { v: 2, checks: { fingerprint: head, results: [result('test', 0)] }, ...(scope === undefined ? {} : { scope }) });

  before(() => {
    head = git(dir, 'rev-parse', 'HEAD^{tree}');
  });
  after(() => setCi({ missing_block: 'fail', skip_label: 'shipline:skip' }));

  test('edits to test/CI files and files outside the plan: a notice, a Scope row and the two lists; the check passes', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const r = check(body(withScope({ sensitive: ['test/a.test.js', '.github/workflows/ci.yml'], outside_plan: ['src/x.js'], accepted: false })));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
    assert.ok(notices(r).includes('::notice title=Shipline::Scope: edits 2 test, lint or CI files, 1 file outside the plan.'), r.stdout);
    assert.match(r.summary, /^\| Scope \| edits 2 test, lint or CI files, 1 file outside the plan \| — \|$/m);
    assert.ok(r.summary.includes('<details><summary>Test, lint and CI files edited</summary>\n\n- `test/a.test.js`\n- `.github/workflows/ci.yml`\n\n</details>'), r.summary);
    assert.ok(r.summary.includes('<details><summary>Files outside the plan</summary>\n\n- `src/x.js`\n\n</details>'), r.summary);
  });

  test('accepted: "(accepted)"; nothing to report: a quiet row and no notice', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const a = check(body(withScope({ sensitive: ['test/a.test.js'], outside_plan: null, accepted: true })));
    assert.equal(a.code, 0, a.stdout);
    assert.match(a.summary, /^\| Scope \| edits 1 test, lint or CI file \(accepted\) \| — \|$/m);
    assert.ok(!a.summary.includes('Files outside the plan'));
    const q = check(body(withScope({ sensitive: [], outside_plan: [], accepted: false })));
    assert.equal(q.code, 0, q.stdout);
    assert.match(q.summary, /^\| Scope \| nothing sensitive, nothing outside the plan \| — \|$/m);
    assert.ok(!notices(q).some((l) => l.includes('Scope:')), q.stdout);
  });

  test('no scope in the summary: no Scope row; a malformed scope never fails the check', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const none = check(body(withScope(undefined)));
    assert.equal(none.code, 0, none.stdout);
    assert.ok(!none.summary.includes('| Scope |'));
    for (const scope of ['x', 42, { sensitive: 'a', outside_plan: 7 }, { sensitive: [1, null, 'ok.test.js'] }]) {
      const r = check(body(withScope(scope)));
      assert.equal(r.code, 0, `${JSON.stringify(scope)}\n${r.stdout}`);
      assert.deepEqual(errors(r), []);
    }
  });
});

// Teams Phase 4: ci-check uses needsAnswer with the PR tree's own config.yml, so `confirmations: light` only needs
// an answer on checkpoint stages (feature's plan). Standard, a missing key and an unknown value fail as before.
describe('confirmations: light (needsAnswer)', () => {
  const setConfirmations = (mode) => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const f = path.join(dir, '.shipline', 'config.yml');
    const text = readFileSync(f, 'utf8');
    assert.match(text, /^confirmations: standard$/m);
    writeFileSync(f, mode === undefined ? text.replace(/^confirmations: standard\n/m, '') : text.replace(/^confirmations: standard$/m, `confirmations: ${mode}`));
  };
  const AUTO = { questions: { confirmed: 'auto' }, wireframes: { confirmed: 'auto' }, verify: { confirmed: 'auto' } };
  const needs = (id) => `::error title=Shipline::Stage "${id}" needs the developer's confirmation, but the summary doesn't show their answer.`;
  after(() => setCi({ missing_block: 'fail', skip_label: 'shipline:skip' }));

  test('light: auto on questions, wireframes and verify (not checkpoints) passes', () => {
    setConfirmations('light');
    const r = check(body(featureSummary(AUTO)));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(errors(r), []);
    // An answer there is fine too.
    assert.equal(check(body(featureSummary())).code, 0);
  });

  test('light: plan (a checkpoint) done without an answer fails with the existing message', () => {
    setConfirmations('light');
    for (const confirmed of ['auto', null, undefined]) {
      const r = check(body(featureSummary({ ...AUTO, plan: { confirmed } })));
      assert.equal(r.code, 1, `${confirmed}: ${r.stdout}`);
      assert.deepEqual(errors(r), [needs('plan')]);
    }
  });

  test('light: a checkpoint without confirm_to_advance needs nothing', () => {
    setConfirmations('light');
    const wf = path.join(dir, '.shipline', 'workflows', 'cp.yml');
    writeFileSync(wf, 'id: cp\nname: CP\nstages:\n  - id: build\n    enforcement: guide\n    checkpoint: true\n');
    try {
      const r = check(body({ v: 1, workflow: 'cp', task: 'x', stages: [{ id: 'build', status: 'done', enforcement: 'guide', confirmed: 'auto' }] }));
      assert.equal(r.code, 0, r.stdout);
    } finally {
      rmSync(wf, { force: true });
    }
  });

  for (const mode of ['standard', undefined, 'lite']) {
    test(`${mode === undefined ? 'no confirmations key' : `confirmations: ${mode}`}: the same summaries fail as before`, () => {
      setConfirmations(mode);
      const r = check(body(featureSummary(AUTO)));
      assert.equal(r.code, 1, r.stdout);
      assert.deepEqual(errors(r), [needs('questions'), needs('wireframes'), needs('verify')]);
      const p = check(body(featureSummary({ plan: { confirmed: 'auto' } })));
      assert.equal(p.code, 1, p.stdout);
      assert.deepEqual(errors(p), [needs('plan')]);
      assert.equal(check(body(featureSummary())).code, 0, 'every confirm stage answered still passes');
    });
  }
});

// 1.0 plan, item 15: the workflow runs the base branch's checker with `--config-from <base checkout>`, so config.yml and
// the workflow files come from the base while the git tree (the fingerprint) is the PR head's.
describe('--config-from <dir>', () => {
  let base; // a copy of the repo's .shipline/ as the base branch has it (not a git checkout)
  const baseCfg = () => path.join(base, '.shipline', 'config.yml');
  // ci-check with these extra arguments, run from `cwd` (the PR head), with `script` (head's own by default).
  function checkWith(args, data, { script = path.join(dir, '.shipline', 'bin', 'ci-check.mjs'), cwd = dir } = {}) {
    const i = ++n;
    const eventPath = path.join(scratch, `event-cf-${i}.json`);
    writeFileSync(eventPath, JSON.stringify({ action: 'opened', pull_request: { number: 9, body: data, labels: [] } }));
    return run(process.execPath, [script, ...args], { cwd, env: { GITHUB_EVENT_PATH: eventPath } });
  }
  const writeBaseCi = (ci) => {
    const text = configText.replace(/\n# Optional\. The pull-request check[\s\S]*$/, '\n');
    writeFileSync(baseCfg(), `${text}\nci:\n${Object.entries(ci).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`);
  };

  before(() => {
    base = path.join(scratch, 'base');
    cpSync(path.join(dir, '.shipline'), path.join(base, '.shipline'), { recursive: true });
  });
  after(() => setCi({ missing_block: 'fail', skip_label: 'shipline:skip' }));

  test('the head relaxes ci.missing_block to warn; with --config-from the base\'s fail still applies', () => {
    setCi({ missing_block: 'warn', skip_label: 'shipline:skip' });
    writeBaseCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const own = checkWith([], 'No summary here.');
    assert.equal(own.code, 0, own.stdout);
    assert.match(own.stdout, /^::warning title=Shipline::This pull request has no Shipline summary\./m);
    for (const args of [['--config-from', base], [`--config-from=${base}`], ['--config-from', path.relative(dir, base)]]) {
      const r = checkWith(args, 'No summary here.');
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.stdout}`);
      assert.deepEqual(errors(r), ['::error title=Shipline::This pull request has no Shipline summary. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output into the description.']);
    }
  });

  test('the workflow files come from the base too: a head that turns a block stage into guide does not pass', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    writeBaseCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    const wf = 'id: gate\nname: Gate\nstages:\n  - id: review\n    enforcement: ENF\n  - id: build\n    enforcement: guide\n';
    writeFileSync(path.join(base, '.shipline', 'workflows', 'gate.yml'), wf.replace('ENF', 'block'));
    writeFileSync(path.join(dir, '.shipline', 'workflows', 'gate.yml'), wf.replace('ENF', 'guide'));
    try {
      const data = body({ v: 1, workflow: 'gate', task: 'x', stages: [{ id: 'review', status: 'pending', enforcement: 'guide', confirmed: null }, { id: 'build', status: 'done', enforcement: 'guide', confirmed: 'auto' }] });
      assert.equal(checkWith([], data).code, 0, 'the head\'s own workflow lets it through');
      const r = checkWith(['--config-from', base], data);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /Stage "review" is a block stage and is not done \(it is pending\)/);
    } finally {
      rmSync(path.join(dir, '.shipline', 'workflows', 'gate.yml'), { force: true });
      rmSync(path.join(base, '.shipline', 'workflows', 'gate.yml'), { force: true });
    }
  });

  test('the fingerprint still comes from the checkout it runs in (the head), not from the --config-from folder', () => {
    writeBaseCi({ missing_block: 'fail', skip_label: 'shipline:skip', stale_checks: 'fail' });
    const head = git(dir, 'rev-parse', 'HEAD^{tree}');
    const data = featureSummary({}, { v: 2, checks: { ran_at: new Date().toISOString(), fingerprint: head, results: [{ name: 'test', exit: 0, duration_ms: 5, accepted: false }] } });
    const r = checkWith(['--config-from', base], body(data));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Checks ran on this exact code\./);
    const stale = checkWith(['--config-from', base], body({ ...data, checks: { ...data.checks, fingerprint: 'f'.repeat(40) } }));
    assert.equal(stale.code, 1, 'stale_checks: fail is read from the base');
  });

  test('flag handling: an unknown option, a missing folder, or a folder with no config.yml fails with a message', () => {
    const summary = body(featureSummary());
    for (const [args, re] of [
      [['--bogus'], /Unknown option --bogus\. Usage: ci-check\.mjs \[--config-from <dir>\]/],
      [['--config-from'], /--config-from needs a folder\./],
      [['--config-from='], /--config-from needs a folder\./],
      [['--config-from', path.join(scratch, 'no-such-base')], /No \.shipline\/config\.yml in .*no-such-base; there is nothing to read the check's settings from\./],
    ]) {
      const r = checkWith(args, summary);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stdout, re, args.join(' '));
    }
  });

  // The `run:` step of templates/github/shipline.yml, run with sh from head/ as Actions does: base's checker with
  // --config-from ../base when base has one, else head's own (the PR that adds Shipline).
  test('the workflow template runs base\'s checker with --config-from ../base, or head\'s own when base has none', { skip: process.platform === 'win32' && 'runs the template\'s run: block with sh (the job runs on ubuntu-latest)' }, () => {
    const yml = readFileSync(path.join(CLI_ROOT, 'templates', 'github', 'shipline.yml'), 'utf8');
    assert.match(yml, /path: head\n/);
    assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+path: base\n\s+fetch-depth: 1/);
    assert.match(yml, /working-directory: head\n/);
    const m = /\n {8}run: \|\n((?: {10}[^\n]*\n?)+)/.exec(yml);
    assert.ok(m, yml);
    const script = m[1].replace(/^ {10}/gm, '');
    assert.match(script, /node \.\.\/base\/\.shipline\/bin\/ci-check\.mjs --config-from \.\.\/base/);

    const ws = path.join(scratch, 'actions');
    cpSync(dir, path.join(ws, 'head'), { recursive: true });
    cpSync(base, path.join(ws, 'base'), { recursive: true });
    setCi({ missing_block: 'warn', skip_label: 'shipline:skip' });
    cpSync(path.join(dir, '.shipline', 'config.yml'), path.join(ws, 'head', '.shipline', 'config.yml'));
    writeBaseCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    cpSync(baseCfg(), path.join(ws, 'base', '.shipline', 'config.yml'));
    // A base checker that says which one ran, then runs the real one.
    const marker = path.join(ws, 'base', '.shipline', 'bin', 'ci-check.mjs');
    const real = readFileSync(marker, 'utf8').replace(/^#![^\n]*\n/, '');
    writeFileSync(marker, `console.log('::notice title=Shipline::base checker ' + process.argv.slice(2).join(' '));\n${real}`);
    const eventPath = path.join(scratch, 'event-actions.json');
    writeFileSync(eventPath, JSON.stringify({ action: 'opened', pull_request: { number: 1, body: 'No summary.', labels: [] } }));
    const sh = (cwd) => run('sh', ['-c', script], { cwd, env: { GITHUB_EVENT_PATH: eventPath } });
    const withBase = sh(path.join(ws, 'head'));
    assert.equal(withBase.code, 1, withBase.stdout + withBase.stderr);
    assert.match(withBase.stdout, /base checker --config-from \.\.\/base/);
    assert.match(withBase.stdout, /^::error title=Shipline::This pull request has no Shipline summary\./m, 'the base config (fail) decides');

    rmSync(path.join(ws, 'base', '.shipline'), { recursive: true });
    const firstPr = sh(path.join(ws, 'head'));
    assert.equal(firstPr.code, 0, firstPr.stdout + firstPr.stderr);
    assert.ok(!firstPr.stdout.includes('base checker'));
    assert.match(firstPr.stdout, /^::warning title=Shipline::This pull request has no Shipline summary\./m, 'head\'s own checker and config');
  });
});

// 1.0 plan, item 19: with tracker: none the ticket stage is skipped on start, and the CI check accepts the summary.
describe('tracker: none and the CI check', () => {
  test('a real task whose block ticket stage was auto-skipped (No tracker) passes', () => {
    setCi({ missing_block: 'fail', skip_label: 'shipline:skip' });
    assert.match(readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8'), /^tracker: none$/m);
    const wf = path.join(dir, '.shipline', 'workflows', 'tixnone.yml');
    writeFileSync(wf, 'id: tixnone\nname: Tix none\nstages:\n  - id: ticket\n    artifact: ticket.md\n    enforcement: block\n  - id: build\n    enforcement: guide\n');
    try {
      const s = 'ci-none';
      assert.equal(stage(dir, ['start', '--workflow', 'tixnone', '--title', 'No tracker'], s).code, 0);
      assert.equal(stage(dir, ['advance'], s).code, 0);
      const summary = stage(dir, ['pr-summary'], s).stdout;
      const data = JSON.parse(/<!-- shipline:summary (.*) -->/.exec(summary)[1]);
      assert.deepEqual(data.stages[0], { id: 'ticket', status: 'skipped', enforcement: 'block', confirmed: 'auto' });
      const r = check(`Adds X.\n\n${summary}`);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(errors(r), []);
      rmSync(path.join(storeOf(dir), 'tasks', 'no-tracker'), { recursive: true });
    } finally {
      rmSync(wf, { force: true });
    }
  });
});
