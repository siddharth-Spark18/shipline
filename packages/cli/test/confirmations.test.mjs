// Teams Phase 4 (docs/plans/shipline-teams-phase4.md): lighter confirmations. The shared rule `needsAnswer` in
// lib.mjs, and stage.mjs using it: `confirmations: light` asks to advance only at `checkpoint: true` stages, while
// skip, accept and scope still ask; standard, a missing key and an unknown value behave as 0.13.0; switching the
// mode mid-task takes effect on the next `advance`. Runs the vendored scripts of a real temp repo with the shipped
// feature workflow. Commands are `"<node>" "<script>"` with absolute paths (sh and cmd.exe alike). Node 18+.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, hook, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';
import { needsAnswer } from '../templates/shipline/bin/lib.mjs';

// ---------- the rule ----------

// Every combination of confirm_to_advance, checkpoint and confirmations, with the expected answer.
// The UI copy (packages/ui/src/lib/confirmations.ts) is held to the same table in test/ui/confirmations.test.mjs.
const CONFIRM_VALUES = [true, false, undefined, null, 'true'];
const CHECKPOINT_VALUES = [true, false, undefined, null, 'true'];
const MODES = ['standard', 'light', undefined, null, '', 'Light', 'lite'];
function expected(confirm, checkpoint, mode) {
  if (confirm !== true) return false;
  return mode !== 'light' || checkpoint === true;
}

describe('needsAnswer (lib.mjs)', () => {
  test('truth table: confirm_to_advance && (confirmations !== light || checkpoint)', () => {
    for (const confirm of CONFIRM_VALUES) {
      for (const checkpoint of CHECKPOINT_VALUES) {
        for (const mode of MODES) {
          const sc = { id: 's', confirm_to_advance: confirm, checkpoint };
          assert.equal(needsAnswer(sc, { confirmations: mode }), expected(confirm, checkpoint, mode), JSON.stringify({ confirm, checkpoint, mode }));
        }
      }
    }
  });

  test('the main cases spelled out', () => {
    assert.equal(needsAnswer({ confirm_to_advance: true }, { confirmations: 'standard' }), true);
    assert.equal(needsAnswer({ confirm_to_advance: true }, { confirmations: 'light' }), false);
    assert.equal(needsAnswer({ confirm_to_advance: true, checkpoint: true }, { confirmations: 'light' }), true);
    assert.equal(needsAnswer({ confirm_to_advance: false, checkpoint: true }, { confirmations: 'light' }), false, 'checkpoint alone has no effect');
    assert.equal(needsAnswer({ confirm_to_advance: false, checkpoint: true }, { confirmations: 'standard' }), false);
  });

  test('a missing config, stage or key is standard; never throws', () => {
    assert.equal(needsAnswer({ confirm_to_advance: true }, {}), true);
    assert.equal(needsAnswer({ confirm_to_advance: true }, null), true);
    assert.equal(needsAnswer({ confirm_to_advance: true }, undefined), true);
    assert.equal(needsAnswer(null, { confirmations: 'standard' }), false);
    assert.equal(needsAnswer(undefined, undefined), false);
  });
});

// ---------- stage.mjs ----------

const TEXT = 'Enough real text to pass the twenty character minimum.';
const PLAN = `# Plan\n\n## Scope\n\nThe CSV export, nothing else.\n\n## Files to touch\n\n- src/a.js (modify): add the export\n\n## Verification\n\n${TEXT}\n`;
const ARTIFACTS = {
  ticket: ['ticket.md', `# Ticket\n\n${TEXT}\n`],
  feasibility: ['feasibility.md', `# Feasibility\n\n## Risks\n\n${TEXT}\n`],
  questions: ['questions.md', `# Questions\n\n${TEXT}\n`],
  plan: ['plan.md', PLAN],
  wireframes: ['wireframes.html', '<p>wireframes</p>\n'],
  implement: ['implementation.md', `# Implementation\n\n${TEXT}\n`],
  verify: ['verification.md', '# Verification\n\n## Checklist\n\n- [x] export works\n- [x] empty state\n'],
  pr: ['pr.md', `# PR\n\n${TEXT}\n`],
};
const ADVANCE_OPTIONS = '"Advance" and "Not yet"';
const SKIP_OPTIONS = '"Skip" and "Don\'t skip"';
const FINISH_OPTIONS = '"Finish anyway" and "Not yet"';

let dir;
let scripts;
let configText;
let n = 0;
const NODE = `"${process.execPath}"`;
const script = (name) => `${NODE} "${path.join(scripts, name)}"`;
const taskDir = (slug) => path.join(storeOf(dir), 'tasks', slug);
const manifest = (slug) => JSON.parse(readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8'));
const stageOf = (slug, id) => manifest(slug).stages.find((s) => s.id === id);
const statePath = (session) => path.join(storeOf(dir), 'state', `${session}.json`);
const state = (session) => (existsSync(statePath(session)) ? JSON.parse(readFileSync(statePath(session), 'utf8')) : {});
const approvals = (session) => {
  const f = path.join(storeOf(dir), 'approvals', `${session}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const advanceQ = (id, slug) => `Advance past "${id}" in task ${slug}?`;
const write = (slug, id) => writeFileSync(path.join(taskDir(slug), ARTIFACTS[id][0]), ARTIFACTS[id][1]);

// config.yml as installed, with `confirmations` set to `mode` (undefined: the key removed) and these commands.
function setConfig(mode, cmds = {}) {
  let text = configText;
  assert.match(text, /^confirmations: standard$/m);
  text = mode === undefined ? text.replace(/^confirmations: standard\n/m, '') : text.replace(/^confirmations: standard$/m, `confirmations: ${mode}`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const block = ['test', 'lint', 'build'].map((k) => `  ${k}: ${cmds[k] === undefined ? '""' : q(cmds[k])}`).join('\n');
  const re = /\ncommands:\n(?: {2}[^\n]*\n)*/;
  assert.match(text, re);
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), text.replace(re, `\ncommands:\n${block}\n`));
}

// The developer's answer to a question (the PostToolUse hook input for AskUserQuestion).
function answer(session, question, label) {
  const r = hook(dir, 'record-answer.mjs', {
    session_id: session,
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: `toolu_${session}_${Date.now()}`,
    tool_input: { questions: [{ question, header: 'Shipline', options: [{ label }], multiSelect: false }] },
    tool_response: { answers: { [question]: label } },
  });
  assert.equal(r.code, 0, r.stderr);
}

// `cmd` refused with a question whose text starts with `prefix`; returns the full question.
function asks(session, prefix, options, cmd = 'advance') {
  const r = stage(dir, [cmd], session);
  assert.equal(r.code, 1, r.stdout);
  const m = /^ {2}question: (.*)$/m.exec(r.stderr);
  assert.ok(m, r.stderr);
  assert.ok(m[1].startsWith(prefix), `${m[1]} / ${prefix}`);
  assert.ok(r.stderr.includes(`  options: ${options}\n`), r.stderr);
  return m[1];
}

// advance goes through with no question; returns stdout.
function advances(session, label) {
  const r = stage(dir, ['advance'], session);
  assert.equal(r.code, 0, `${label}: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// A new feature task (UI work, so wireframes applies). Returns { session, slug }.
function startFeature() {
  const i = ++n;
  const session = `conf-s${i}`;
  const slug = `conf-task-${i}`;
  const r = stage(dir, ['start', '--workflow', 'feature', '--title', slug, '--ui', 'true'], session);
  assert.equal(r.code, 0, r.stderr);
  return { session, slug, stdout: r.stdout };
}

// Advances (with no question) through ticket and feasibility, leaving the task at questions with its artifact.
function toQuestions({ session, slug }) {
  for (const id of ['ticket', 'feasibility']) {
    write(slug, id);
    advances(session, id);
  }
  write(slug, 'questions');
  assert.equal(manifest(slug).stages.find((s) => s.status === 'in_progress').id, 'questions');
}

const summaryOf = (session) => {
  const r = stage(dir, ['pr-summary'], session);
  assert.equal(r.code, 0, r.stderr);
  return { text: r.stdout, data: JSON.parse(/<!-- shipline:summary (.*) -->/.exec(r.stdout)[1]) };
};
const confirmedOf = (data) => Object.fromEntries(data.stages.map((s) => [s.id, s.confirmed]));

before(() => {
  dir = makeRepo({ commitInit: true });
  scripts = tmpDir('shipline-conf-scripts-');
  writeFileSync(path.join(scripts, 'pass.js'), "console.log('ok');\n");
  writeFileSync(path.join(scripts, 'fail3.js'), "console.log('lint error');\nprocess.exit(3);\n");
  // These runs walk through the ticket stage, so they use a tracker (with the default `none` it is skipped on start).
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8').replace(/^tracker: none$/m, 'tracker: jira');
  assert.match(configText, /^tracker: jira$/m);
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), configText);
});
after(() => {
  setConfig('standard');
  removeDir(dir);
  removeDir(scripts);
});

describe('the shipped templates', () => {
  test('config.yml ships confirmations: standard; feature plan and bugfix root_cause are the checkpoints', () => {
    assert.match(configText, /^confirmations: standard$/m);
    const wf = (f) => readFileSync(path.join(dir, '.shipline', 'workflows', f), 'utf8');
    assert.match(wf('feature.yml'), /- id: plan\n(?: {4}[^\n]*\n)*? {4}checkpoint: true\n/);
    assert.match(wf('bugfix.yml'), /- id: root_cause\n(?: {4}[^\n]*\n)*? {4}checkpoint: true\n/);
    assert.equal((wf('feature.yml').match(/^ {4}checkpoint: true$/gm) || []).length, 1);
    assert.equal((wf('bugfix.yml').match(/^ {4}checkpoint: true$/gm) || []).length, 1);
    for (const f of ['hotfix.yml', 'small.yml']) assert.ok(!/^ {4}checkpoint:/m.test(wf(f)), f);
  });
});

describe('light: a feature run asks to advance only at Plan', () => {
  test('questions, wireframes and verify advance on their own (auto); plan asks; accept and scope still ask; CI agrees', () => {
    setConfig('light', { test: script('pass.js'), lint: script('fail3.js') });
    const t = startFeature();
    const { session, slug } = t;
    toQuestions(t);
    // The stage text says it won't ask, and why.
    const desc = stage(dir, ['status', '--verbose'], session).stdout;
    assert.match(desc, /Confirm with the developer before advancing: no \(light confirmations: auto-advance\)/);

    const afterQuestions = advances(session, 'questions');
    assert.equal(stageOf(slug, 'questions').status, 'done');
    assert.equal(stageOf(slug, 'questions').confirmed, undefined);
    assert.ok(!('pending_confirm' in state(session)));
    // Now at plan, a checkpoint: the description says YES.
    assert.match(afterQuestions, /Confirm with the developer before advancing: YES/);

    write(slug, 'plan');
    const q = asks(session, advanceQ('plan', slug), ADVANCE_OPTIONS);
    assert.equal(q, advanceQ('plan', slug));
    answer(session, q, 'Advance');
    advances(session, 'plan');
    assert.equal(stageOf(slug, 'plan').confirmed.via, 'answer');

    write(slug, 'wireframes');
    advances(session, 'wireframes');
    write(slug, 'implement');
    advances(session, 'implement');

    // Verify: a failed lint run and a file outside the plan. accept asks, then scope asks; no advance question.
    write(slug, 'verify');
    writeFileSync(path.join(dir, 'src', 'extra.js'), 'export const extra = 1;\n');
    try {
      const c = stage(dir, ['check'], session);
      assert.match(c.stdout, /lint ✗ \(exit 3\)/, `${c.stdout}\n${c.stderr}`); // check exits non-zero on a failed command
      const acceptQ = asks(session, `Finish "verify" in task ${slug} with failed checks: lint`, FINISH_OPTIONS);
      answer(session, acceptQ, 'Finish anyway');
      const scopeQ = asks(session, `Finish "verify" in task ${slug}? This change edits 0 test/lint/CI files and 1 files outside the plan`, FINISH_OPTIONS);
      answer(session, scopeQ, 'Finish anyway');
      advances(session, 'verify');
      assert.equal(stageOf(slug, 'verify').status, 'done');
      assert.equal(stageOf(slug, 'verify').confirmed, undefined);
      assert.ok(stageOf(slug, 'verify').accepted);
      assert.ok(stageOf(slug, 'verify').scope_accepted);

      write(slug, 'pr');
      advances(session, 'pr');
      const { data } = summaryOf(session);
      assert.deepEqual(confirmedOf(data), {
        ticket: 'auto',
        feasibility: 'auto',
        questions: 'auto',
        plan: 'answer',
        wireframes: 'auto',
        implement: 'auto',
        verify: 'auto',
        pr: 'auto',
      });
      // Every question asked in this run: plan's advance, accept and scope. Nothing else.
      assert.deepEqual(
        approvals(session).map((a) => a.kind),
        ['advance', 'accept', 'scope'],
      );
    } finally {
      git(dir, 'clean', '-fdq', '--', 'src');
    }
  });

  test('skipping a required stage still asks; an optional one does not', () => {
    setConfig('light');
    const { session, slug } = startFeature();
    // ticket is optional: skipped with no question.
    assert.equal(stage(dir, ['skip'], session).code, 0);
    assert.equal(stageOf(slug, 'ticket').status, 'skipped');
    // feasibility is required: Skip asks.
    const q = asks(session, `Skip "feasibility" in task ${slug}?`, SKIP_OPTIONS, 'skip');
    answer(session, q, 'Skip');
    assert.equal(stage(dir, ['skip'], session).code, 0);
    assert.equal(stageOf(slug, 'feasibility').skipped.via, 'answer');
  });

  test('a checkpoint stage done without an answer is not auto in the PR summary (a hand-edited manifest)', () => {
    setConfig('light');
    const t = startFeature();
    toQuestions(t);
    advances(t.session, 'questions');
    const m = manifest(t.slug);
    const plan = m.stages.find((s) => s.id === 'plan');
    plan.status = 'done';
    m.stages.find((s) => s.id === 'wireframes').status = 'in_progress';
    writeFileSync(path.join(taskDir(t.slug), 'manifest.json'), JSON.stringify(m, null, 2));
    const { text, data } = summaryOf(t.session);
    assert.equal(confirmedOf(data).plan, null);
    assert.equal(confirmedOf(data).questions, 'auto');
    assert.ok(text.includes('| plan | done | — |'), text);
  });

  test('with no commands configured, verify finishes on its own', () => {
    setConfig('light');
    const t = startFeature();
    const { session, slug } = t;
    toQuestions(t);
    advances(session, 'questions');
    write(slug, 'plan');
    answer(session, asks(session, advanceQ('plan', slug), ADVANCE_OPTIONS), 'Advance');
    advances(session, 'plan');
    for (const id of ['wireframes', 'implement', 'verify']) {
      write(slug, id);
      advances(session, id);
    }
    assert.equal(stageOf(slug, 'verify').status, 'done');
    assert.equal(confirmedOf(summaryOf(session).data).verify, 'auto');
  });
});

describe('standard, a missing key and an unknown value: as 0.13.0', () => {
  for (const mode of ['standard', undefined, 'lite', '""']) {
    test(`confirmations: ${mode === undefined ? '(missing)' : mode}: questions asks to advance; the stage text says YES`, () => {
      setConfig(mode);
      const t = startFeature();
      toQuestions(t);
      assert.match(stage(dir, ['status', '--verbose'], t.session).stdout, /Confirm with the developer before advancing: YES/);
      const q = asks(t.session, advanceQ('questions', t.slug), ADVANCE_OPTIONS);
      assert.equal(state(t.session).pending_confirm.kind, 'advance');
      answer(t.session, q, 'Advance');
      advances(t.session, 'questions');
      assert.equal(stageOf(t.slug, 'questions').confirmed.via, 'answer');
      // Non-confirm stages still say plain auto-advance.
      const s = startFeature();
      assert.match(s.stdout, /Confirm with the developer before advancing: no \(auto-advance\)/);
    });
  }
});

describe('switching the mode mid-task: the next advance uses the current config', () => {
  test('standard -> light: a pending advance question is cleared and the stage finishes as auto', () => {
    setConfig('standard');
    const t = startFeature();
    toQuestions(t);
    asks(t.session, advanceQ('questions', t.slug), ADVANCE_OPTIONS);
    assert.equal(state(t.session).pending_confirm.kind, 'advance');
    setConfig('light');
    advances(t.session, 'questions');
    assert.ok(!('pending_confirm' in state(t.session)));
    assert.equal(stageOf(t.slug, 'questions').status, 'done');
    assert.equal(stageOf(t.slug, 'questions').confirmed, undefined);
    assert.equal(confirmedOf(summaryOf(t.session).data).questions, 'auto');
  });

  test('standard -> light: an "Advance" the developer already gave is used (provenance answer)', () => {
    setConfig('standard');
    const t = startFeature();
    toQuestions(t);
    const q = asks(t.session, advanceQ('questions', t.slug), ADVANCE_OPTIONS);
    answer(t.session, q, 'Advance');
    setConfig('light');
    advances(t.session, 'questions');
    const [a] = approvals(t.session);
    assert.ok(a.used_at, 'the approval is consumed');
    assert.deepEqual(stageOf(t.slug, 'questions').confirmed, { via: 'answer', at: a.at });
    assert.ok(!('pending_confirm' in state(t.session)));
    assert.equal(confirmedOf(summaryOf(t.session).data).questions, 'answer');
  });

  test('standard -> light: a "Not yet" answer does not count; the stage finishes as auto', () => {
    setConfig('standard');
    const t = startFeature();
    toQuestions(t);
    const q = asks(t.session, advanceQ('questions', t.slug), ADVANCE_OPTIONS);
    answer(t.session, q, 'Not yet');
    setConfig('light');
    advances(t.session, 'questions');
    assert.equal(stageOf(t.slug, 'questions').confirmed, undefined);
  });

  test('light -> standard: the next advance on a confirm stage asks again', () => {
    setConfig('light');
    const t = startFeature();
    toQuestions(t);
    setConfig('standard');
    asks(t.session, advanceQ('questions', t.slug), ADVANCE_OPTIONS);
    assert.equal(stageOf(t.slug, 'questions').status, 'in_progress');
  });
});

// The light run end to end through ci-check: pr-summary pasted into a PR passes under light, fails under standard.
describe('ci-check agrees with the hooks', () => {
  test('a light run\'s summary passes ci-check under light and fails under standard', () => {
    setConfig('light');
    const t = startFeature();
    const { session, slug } = t;
    toQuestions(t);
    advances(session, 'questions');
    write(slug, 'plan');
    answer(session, asks(session, advanceQ('plan', slug), ADVANCE_OPTIONS), 'Advance');
    advances(session, 'plan');
    for (const id of ['wireframes', 'implement', 'verify', 'pr']) {
      write(slug, id);
      advances(session, id);
    }
    const prBody = `Change.\n\n${summaryOf(session).text}`;
    const scratch = tmpDir('shipline-conf-ci-');
    try {
      const ci = () => {
        const ev = path.join(scratch, `event-${++n}.json`);
        writeFileSync(ev, JSON.stringify({ action: 'opened', pull_request: { number: 1, body: prBody, labels: [] } }));
        return run(process.execPath, [path.join(dir, '.shipline', 'bin', 'ci-check.mjs')], { cwd: dir, env: { GITHUB_EVENT_PATH: ev } });
      };
      const ok = ci();
      assert.equal(ok.code, 0, ok.stdout);
      setConfig('standard');
      const bad = ci();
      assert.equal(bad.code, 1, bad.stdout);
      for (const id of ['questions', 'wireframes', 'verify']) {
        assert.ok(bad.stdout.includes(`Stage "${id}" needs the developer's confirmation, but the summary doesn't show their answer.`), bad.stdout);
      }
      assert.ok(!bad.stdout.includes('Stage "plan" needs'), bad.stdout);
    } finally {
      removeDir(scratch);
    }
  });
});
