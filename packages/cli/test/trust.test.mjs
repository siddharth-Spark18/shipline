// Trust plan (docs/plans/shipline-trust.md), Tests: the PostToolUse recorder (record-answer.mjs), answer-based
// confirmations in stage.mjs (advance / skip, no --confirmed / --force, required artifacts), the guard's store
// protection, and `stage.mjs pr-summary`. Runs the vendored scripts of a real temp repo, each repo with its own
// SHIPLINE_HOME (helpers.mjs). Node 18+, so it stays in test:hooks.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hook, homeFor, makeRepo, removeDir, run, stage, storeOf } from './helpers.mjs';

// A small workflow with one stage of each kind the confirmations care about.
const TRUST_WORKFLOW = `id: trust
name: Trust
stages:
  - id: draft
    name: Draft
    artifact: draft.md
    enforcement: block
    confirm_to_advance: true
  - id: review
    name: Review
    enforcement: warn
    confirm_to_advance: false
  - id: extra
    name: Extra
    optional: true
    enforcement: guide
  - id: docs
    name: Docs
    enforcement: guide
  - id: ui
    name: UI
    condition: ui_only
    enforcement: guide
    confirm_to_advance: true
  - id: ship
    name: Ship
    enforcement: block
`;

const STORE_DENY = 'Shipline: progress and approvals can only change through `stage.mjs` and your answers to its questions.';
const ADVANCE_OPTIONS = [{ label: 'Advance', description: '' }, { label: 'Not yet', description: '' }];
const SKIP_OPTIONS = [{ label: 'Skip', description: '' }, { label: "Don't skip", description: '' }];

let dir;
let store;
let n = 0;

before(() => {
  dir = makeRepo({ commitInit: true });
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'trust.yml'), TRUST_WORKFLOW);
  store = storeOf(dir);
});
after(() => removeDir(dir));

// ---------- helpers ----------

const taskDir = (slug) => path.join(store, 'tasks', slug);
const manifest = (slug) => JSON.parse(readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8'));
const stageOf = (slug, id) => manifest(slug).stages.find((s) => s.id === id);
const statePath = (session) => path.join(store, 'state', `${session}.json`);
const state = (session) => JSON.parse(readFileSync(statePath(session), 'utf8'));
const approvalsFile = (session) => path.join(store, 'approvals', `${session}.jsonl`);
const approvals = (session) =>
  existsSync(approvalsFile(session))
    ? readFileSync(approvalsFile(session), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const advanceQ = (stageId, slug) => `Advance past "${stageId}" in task ${slug}?`;
const skipQ = (stageId, slug) => `Skip "${stageId}" in task ${slug}?`;
const artifact = (slug, name) => writeFileSync(path.join(taskDir(slug), name), `# ${name}\n`);

// A fresh task (and session) in the trust workflow. Returns { session, slug }.
function startTask({ workflow = 'trust', ui = 'false' } = {}) {
  const i = ++n;
  const session = `trust-s${i}`;
  const slug = `trust-task-${i}`;
  const r = stage(dir, ['start', '--workflow', workflow, '--title', slug, '--ui', ui], session);
  assert.equal(r.code, 0, r.stderr);
  return { session, slug };
}

// The PostToolUse hook input Claude Code sends for an answered AskUserQuestion (confirmed on 2026-11-04):
// the answers in tool_response.answers. via: 'input' puts them in tool_input.answers instead (the fallback),
// 'none' leaves them out.
function answered(session, asked, answers, { via = 'response', toolUseId = 'toolu_01', tool = 'AskUserQuestion' } = {}) {
  const questions = asked.map((q) => ({ question: q, header: 'Shipline', options: ADVANCE_OPTIONS, multiSelect: false }));
  return {
    session_id: session,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_use_id: toolUseId,
    tool_input: via === 'input' ? { questions, answers } : { questions },
    tool_response: via === 'response' ? { questions, answers } : {},
  };
}

function answer(session, question, label, opts) {
  const r = hook(dir, 'record-answer.mjs', answered(session, [question], { [question]: label }, opts));
  assert.equal(r.code, 0, r.stderr);
  return r;
}

// advance/skip that must be refused with the question printed.
function refused(session, cmd, question, options) {
  const r = stage(dir, [cmd], session);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.stderr.includes('Ask the developer this with the AskUserQuestion tool, exactly as written'), r.stderr);
  assert.ok(r.stderr.includes('  header: Shipline\n'), r.stderr);
  assert.ok(r.stderr.includes(`  question: ${question}\n`), r.stderr);
  assert.ok(r.stderr.includes(`  options: ${options}\n`), r.stderr);
  return r;
}

// ---------- the recorder ----------

describe('record-answer.mjs (the PostToolUse recorder)', () => {
  test('records the developer\'s answer to the exact pending question, with task, stage, kind and tool_use_id', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    const r = answer(session, q, 'Advance', { toolUseId: 'toolu_abc' });
    assert.equal(r.stdout, '', 'nothing printed on success');
    const [a, ...rest] = approvals(session);
    assert.deepEqual(rest, []);
    assert.deepEqual(Object.keys(a).sort(), ['answer', 'at', 'kind', 'question', 'stage', 'task_dir', 'tool_use_id']);
    assert.equal(a.task_dir, taskDir(slug));
    assert.equal(a.stage, 'draft');
    assert.equal(a.kind, 'advance');
    assert.equal(a.question, q);
    assert.equal(a.answer, 'Advance');
    assert.equal(a.tool_use_id, 'toolu_abc');
    assert.ok(Date.parse(a.at) > Date.parse(state(session).pending_confirm.issued_at));
  });

  test('only the exact question counts: other questions, near-misses and free text are ignored', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    // A different question (Claude's own), a near-miss in the wording, a near-miss in the slug.
    for (const other of ['Proceed to implementation?', `${q} `, `Advance past "draft" in task ${slug}x?`, `advance past "draft" in task ${slug}?`]) {
      answer(session, other, 'Advance');
    }
    // Our question with an answer that isn't one of its options (the "Other" free-text choice).
    answer(session, q, 'Yes, go ahead');
    assert.deepEqual(approvals(session), []);
    // Several questions in one call: only ours is stored, and nothing of the other answer's text.
    const r = hook(
      dir,
      'record-answer.mjs',
      answered(session, ['Which database?', q], { 'Which database?': 'Postgres secret-ish text', [q]: 'Advance' }),
    );
    assert.equal(r.code, 0);
    const recorded = approvals(session);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].answer, 'Advance');
    assert.ok(!readFileSync(approvalsFile(session), 'utf8').includes('Postgres'), 'other answers are never written');
  });

  test('a question asked in another session, with no pending question there, is not recorded anywhere', () => {
    const a = startTask();
    artifact(a.slug, 'draft.md');
    const q = advanceQ('draft', a.slug);
    refused(a.session, 'advance', q, '"Advance" and "Not yet"');
    answer('some-other-session', q, 'Advance');
    assert.deepEqual(approvals('some-other-session'), []);
    assert.deepEqual(approvals(a.session), []);
  });

  test('with no pending question, nothing is recorded', () => {
    const { session, slug } = startTask();
    answer(session, advanceQ('draft', slug), 'Advance');
    assert.deepEqual(approvals(session), []);
  });

  test('another tool name is ignored', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    answer(session, q, 'Advance', { tool: 'Bash' });
    assert.deepEqual(approvals(session), []);
  });

  test('falls back to tool_input.answers when tool_response has none', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    answer(session, q, 'Advance', { via: 'input' });
    assert.deepEqual(approvals(session).map((a) => [a.question, a.answer]), [[q, 'Advance']]);
    assert.equal(stage(dir, ['advance'], session).code, 0);
  });

  test('no answers field at all: nothing recorded and a visible systemMessage', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    const r = hook(dir, 'record-answer.mjs', answered(session, [q], {}, { via: 'none' }));
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { systemMessage: "Shipline couldn't read your answer; the stage can't be confirmed in this session." });
    assert.deepEqual(approvals(session), []);
  });

  test('fails open: bad input exits 0 silently, a store write error exits 0 with a visible message', () => {
    for (const input of ['not json', '', '{"tool_name":"AskUserQuestion"}']) {
      const r = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'record-answer.mjs')], { cwd: dir, input });
      assert.equal(r.code, 0, input);
      assert.equal(r.stdout, '', input);
    }
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    mkdirSync(approvalsFile(session), { recursive: true }); // a folder where the file should be: the append fails
    const r = answer(session, q, 'Advance');
    assert.match(r.json.systemMessage, /^Shipline couldn't record your answer \(.+\); the stage can't be confirmed in this session\.$/);
  });
});

// ---------- stage.mjs confirmations ----------

describe('stage.mjs advance on a confirm_to_advance stage', () => {
  test('refuses without an approval, prints the question and records pending_confirm', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const r = refused(session, 'advance', advanceQ('draft', slug), '"Advance" and "Not yet"');
    assert.match(r.stderr, /stage "draft" needs the developer to confirm advancing/);
    assert.match(r.stderr, /Then run `advance` again\. Do not pass any flag or edit any progress file/);
    const p = state(session).pending_confirm;
    assert.deepEqual({ ...p, issued_at: 'x' }, { stage: 'draft', kind: 'advance', question: advanceQ('draft', slug), issued_at: 'x', task_dir: taskDir(slug) });
    assert.ok(!Number.isNaN(Date.parse(p.issued_at)));
    assert.equal(stageOf(slug, 'draft').status, 'in_progress');
    // status (same session) prints the open question again.
    const st = stage(dir, ['status'], session);
    assert.match(st.stdout, /A confirmation is still open \(run `advance` after the developer answers\)/);
    assert.ok(st.stdout.includes(`  question: ${advanceQ('draft', slug)}`));
  });

  test('accepts after a recorded "Advance", uses it once, records confirmed and clears pending_confirm', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    answer(session, q, 'Advance');
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Done: draft\n/);
    const [a] = approvals(session);
    assert.ok(a.used_at, 'the approval is marked used');
    const d = stageOf(slug, 'draft');
    assert.equal(d.status, 'done');
    assert.deepEqual(d.confirmed, { via: 'answer', at: a.at });
    assert.ok(!('pending_confirm' in state(session)));
    assert.equal(stageOf(slug, 'review').status, 'in_progress');
  });

  test('re-running keeps the original issued_at and the same question, so an answer given in between stays valid', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    const first = state(session).pending_confirm;
    answer(session, q, 'Not yet');
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    assert.deepEqual(state(session).pending_confirm, first);
    answer(session, q, 'Advance');
    assert.equal(stage(dir, ['advance'], session).code, 0);
  });

  test('"Not yet" is recorded but never counts; pending_confirm stays and the refusal says what they answered', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    answer(session, q, 'Not yet');
    assert.deepEqual(approvals(session).map((a) => a.answer), ['Not yet']);
    const r = refused(session, 'advance', q, '"Advance" and "Not yet"');
    assert.match(r.stderr, /\(they answered "Not yet" last time\)/);
    assert.ok(state(session).pending_confirm);
    assert.equal(stageOf(slug, 'draft').status, 'in_progress');
    assert.ok(!approvals(session)[0].used_at, 'a "Not yet" is never used up');
  });

  test('two answers: each is used once; after reopen the leftover (older than the new question) is ignored', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    answer(session, q, 'Advance', { toolUseId: 'toolu_1' });
    answer(session, q, 'Advance', { toolUseId: 'toolu_2' });
    assert.equal(stage(dir, ['advance'], session).code, 0);
    assert.deepEqual(approvals(session).map((a) => [a.tool_use_id, Boolean(a.used_at)]), [['toolu_1', true], ['toolu_2', false]]);

    const re = stage(dir, ['reopen', 'draft'], session);
    assert.equal(re.code, 0, re.stderr);
    assert.ok(!('confirmed' in stageOf(slug, 'draft')), 'reopen clears the old confirmation');
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    const issued = Date.parse(state(session).pending_confirm.issued_at);
    assert.ok(Date.parse(approvals(session)[1].at) < issued);
    // The unused toolu_2 approval has the same question text, but it predates this question: still refused.
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    assert.ok(!approvals(session)[1].used_at);
    answer(session, q, 'Advance', { toolUseId: 'toolu_3' });
    assert.equal(stage(dir, ['advance'], session).code, 0);
    assert.deepEqual(approvals(session).map((a) => [a.tool_use_id, Boolean(a.used_at)]), [['toolu_1', true], ['toolu_2', false], ['toolu_3', true]]);
  });

  test('an approval older than pending_confirm.issued_at is ignored (written before the question was issued)', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const q = advanceQ('draft', slug);
    mkdirSync(path.dirname(approvalsFile(session)), { recursive: true });
    writeFileSync(
      approvalsFile(session),
      JSON.stringify({ task_dir: taskDir(slug), stage: 'draft', kind: 'advance', question: q, answer: 'Advance', at: new Date(Date.now() - 60_000).toISOString(), tool_use_id: 'old' }) + '\n',
    );
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    refused(session, 'advance', q, '"Advance" and "Not yet"');
    assert.ok(!approvals(session)[0].used_at);
  });

  test('reopen clears pending_confirm', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    refused(session, 'advance', advanceQ('draft', slug), '"Advance" and "Not yet"');
    assert.ok(state(session).pending_confirm);
    assert.equal(stage(dir, ['reopen', 'draft'], session).code, 0);
    assert.ok(!('pending_confirm' in state(session)));
  });

  test('no session id: refused with the plan\'s message, nothing issued', () => {
    const { slug } = startTask();
    artifact(slug, 'draft.md');
    const r = stage(dir, ['advance', '--task', slug]); // no --session and no SHIPLINE_SESSION
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no session id; confirmations need the session that asked the question/);
    assert.equal(stageOf(slug, 'draft').status, 'in_progress');
  });

  test('$SHIPLINE_SESSION works like --session', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const viaEnv = (...args) =>
      run(process.execPath, [path.join(dir, '.shipline', 'bin', 'stage.mjs'), ...args], { cwd: dir, env: { SHIPLINE_HOME: homeFor(dir), SHIPLINE_SESSION: session } });
    const q = advanceQ('draft', slug);
    assert.equal(viaEnv('advance').code, 1);
    answer(session, q, 'Advance');
    const r = viaEnv('advance');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stageOf(slug, 'draft').status, 'done');
  });

  test('--confirmed and --force give an error explaining the new flow, and change nothing', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    const before = readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8');
    for (const args of [['advance', '--confirmed'], ['skip', '--force'], ['advance', '--force', 'true'], ['skip', '--confirmed', '--reason', 'x']]) {
      const r = stage(dir, args, session);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, /--confirmed and --force no longer exist\. Run `advance` \(or `skip`\) without them/, args.join(' '));
      assert.match(r.stderr, /AskUserQuestion/);
    }
    assert.equal(readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8'), before);
    assert.ok(!('pending_confirm' in state(session)));
  });

  test('a missing artifact blocks the advance (no override), before any question is issued', () => {
    const { session, slug } = startTask();
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`stage "draft" is not finished: ${taskDir(slug)}/draft.md does not exist yet.`), r.stderr);
    assert.ok(!r.stderr.includes('AskUserQuestion'));
    assert.ok(!('pending_confirm' in state(session)));
  });

  test('an auto stage (no confirm_to_advance) advances with no question', () => {
    const { session, slug } = startTask();
    artifact(slug, 'draft.md');
    answerAndAdvance(session, slug, 'draft');
    const r = stage(dir, ['advance'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stageOf(slug, 'review').status, 'done');
    assert.ok(!('confirmed' in stageOf(slug, 'review')));
  });
});

// Issues the advance question for the current stage, answers "Advance" and advances.
function answerAndAdvance(session, slug, stageId) {
  const q = advanceQ(stageId, slug);
  refused(session, 'advance', q, '"Advance" and "Not yet"');
  answer(session, q, 'Advance');
  const r = stage(dir, ['advance'], session);
  assert.equal(r.code, 0, r.stderr);
}

// Moves a fresh trust task to the given stage (draft confirmed, review advanced, extra skipped).
function taskAt(stageId, opts) {
  const t = startTask(opts);
  artifact(t.slug, 'draft.md');
  if (stageId === 'draft') return t;
  answerAndAdvance(t.session, t.slug, 'draft');
  assert.equal(stage(dir, ['advance'], t.session).code, 0); // review
  if (stageId === 'extra') return t;
  assert.equal(stage(dir, ['skip'], t.session).code, 0); // extra (optional)
  return t;
}

describe('stage.mjs skip', () => {
  test('a non-optional stage needs the developer\'s "Skip": question, "Don\'t skip" never counts, then skipped via answer', () => {
    const { session, slug } = taskAt('docs');
    const q = skipQ('docs', slug);
    const r = refused(session, 'skip', q, '"Skip" and "Don\'t skip"');
    assert.match(r.stderr, /stage "docs" needs the developer to confirm skipping/);
    assert.deepEqual({ ...state(session).pending_confirm, issued_at: 'x' }, { stage: 'docs', kind: 'skip', question: q, issued_at: 'x', task_dir: taskDir(slug) });
    answer(session, q, "Don't skip");
    const again = refused(session, 'skip', q, '"Skip" and "Don\'t skip"');
    assert.match(again.stderr, /\(they answered "Don't skip" last time\)/);
    answer(session, q, 'Skip');
    const ok = stage(dir, ['skip', '--reason', 'docs live in the wiki'], session);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^Skipped: docs\n/);
    const a = approvals(session).find((x) => x.answer === 'Skip');
    assert.equal(a.kind, 'skip');
    assert.ok(a.used_at);
    const d = stageOf(slug, 'docs');
    assert.equal(d.status, 'skipped');
    assert.equal(d.reason, 'docs live in the wiki');
    assert.deepEqual(d.skipped, { via: 'answer', at: a.at, reason: 'docs live in the wiki' });
    assert.ok(!('pending_confirm' in state(session)));
  });

  test('an "Advance" approval does not count for skipping, and a "Skip" approval does not count for advancing', () => {
    const { session, slug } = taskAt('draft');
    const aq = advanceQ('draft', slug);
    refused(session, 'advance', aq, '"Advance" and "Not yet"');
    answer(session, aq, 'Advance');
    // Switching to skip issues the skip question; the unused advance approval doesn't satisfy it.
    refused(session, 'skip', skipQ('draft', slug), '"Skip" and "Don\'t skip"');
    assert.equal(state(session).pending_confirm.kind, 'skip');
    assert.ok(!approvals(session)[0].used_at);
    // And the other way round: a "Skip" answer doesn't let `advance` through.
    answer(session, skipQ('draft', slug), 'Skip');
    refused(session, 'advance', aq, '"Advance" and "Not yet"');
    assert.equal(state(session).pending_confirm.kind, 'advance');
    assert.deepEqual(approvals(session).map((a) => [a.kind, a.answer, Boolean(a.used_at)]), [['advance', 'Advance', false], ['skip', 'Skip', false]]);
    assert.equal(stageOf(slug, 'draft').status, 'in_progress');
  });

  test('an optional stage skips with no question (skipped via optional)', () => {
    const { session, slug } = taskAt('extra');
    const r = stage(dir, ['skip', '--reason', 'not needed'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes('AskUserQuestion'));
    const e = stageOf(slug, 'extra');
    assert.equal(e.status, 'skipped');
    assert.equal(e.skipped.via, 'optional');
    assert.equal(e.skipped.reason, 'not needed');
    assert.deepEqual(approvals(session).filter((a) => a.kind === 'skip'), []);
  });

  test('a conditional stage skips with no question, and a ui_only stage on non-UI work is skipped automatically', () => {
    const t = taskAt('docs', { ui: 'true' });
    const q = skipQ('docs', t.slug);
    refused(t.session, 'skip', q, '"Skip" and "Don\'t skip"');
    answer(t.session, q, 'Skip');
    assert.equal(stage(dir, ['skip'], t.session).code, 0);
    assert.equal(stageOf(t.slug, 'ui').status, 'in_progress');
    const r = stage(dir, ['skip'], t.session);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stageOf(t.slug, 'ui').skipped.via, 'optional');

    const u = taskAt('docs', { ui: 'false' });
    refused(u.session, 'skip', skipQ('docs', u.slug), '"Skip" and "Don\'t skip"');
    answer(u.session, skipQ('docs', u.slug), 'Skip');
    assert.equal(stage(dir, ['skip'], u.session).code, 0);
    const ui = stageOf(u.slug, 'ui');
    assert.equal(ui.status, 'skipped');
    assert.equal(ui.reason, 'not UI work');
    assert.equal(ui.skipped.via, 'optional');
    assert.equal(stageOf(u.slug, 'ship').status, 'in_progress');
  });

  test('no session id: skipping a non-optional stage is refused', () => {
    const { slug } = taskAt('docs');
    const r = stage(dir, ['skip', '--task', slug]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no session id; confirmations need the session that asked the question/);
    assert.equal(stageOf(slug, 'docs').status, 'in_progress');
  });
});

// ---------- the guard ----------

describe('guard.mjs: progress files and approvals', () => {
  let withTask; // { session, slug }
  before(() => {
    withTask = startTask();
  });

  const file = (session, tool, filePath) => ({
    session_id: session,
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: filePath, new_source: 'x' } : { file_path: filePath, content: '{}', old_string: 'a', new_string: 'b' },
  });
  const bash = (session, command) => ({ session_id: session, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const isDeny = (r) =>
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny' && r.json.hookSpecificOutput.permissionDecisionReason === STORE_DENY;
  const sessions = () => [['with a task', withTask.session], ['without a task', 'no-task-session']];

  test('Edit, Write, MultiEdit and NotebookEdit on a manifest, a state file or an approvals file are denied', () => {
    const targets = [
      path.join(taskDir(withTask.slug), 'manifest.json'),
      path.join(store, 'tasks', 'any-task', 'manifest.json'),
      statePath(withTask.session),
      path.join(store, 'state', 'other.json'),
      approvalsFile(withTask.session),
      path.join(store, 'approvals', 'new.jsonl'),
    ];
    for (const [label, session] of sessions()) {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        for (const t of targets) {
          const r = hook(dir, 'guard.mjs', file(session, tool, t));
          assert.equal(r.code, 0);
          assert.ok(isDeny(r), `${label}: ${tool} ${t}: ${r.stdout}`);
        }
      }
    }
  });

  test('a path given relative to the repo, or through a different spelling, is still caught', () => {
    const rel = path.relative(dir, path.join(taskDir(withTask.slug), 'manifest.json'));
    const r = hook(dir, 'guard.mjs', file(withTask.session, 'Edit', rel));
    assert.ok(isDeny(r), r.stdout);
    const dotted = path.join(store, 'tasks', withTask.slug, '.', 'manifest.json');
    assert.ok(isDeny(hook(dir, 'guard.mjs', file(withTask.session, 'Write', dotted))));
  });

  test('task artifacts stay writable (with and without a task)', () => {
    for (const [label, session] of sessions()) {
      for (const tool of ['Edit', 'Write']) {
        for (const t of [path.join(taskDir(withTask.slug), 'draft.md'), path.join(taskDir(withTask.slug), 'notes', 'manifest.json')]) {
          const r = hook(dir, 'guard.mjs', file(session, tool, t));
          assert.equal(r.code, 0);
          assert.ok(!isDeny(r), `${label}: ${tool} ${t}: ${r.stdout}`);
        }
      }
    }
  });

  test('Bash commands that reach the store\'s progress files, run the recorder, or pass --confirmed/--force are denied', () => {
    const home = homeFor(dir);
    const commands = [
      `cat ${path.join(taskDir(withTask.slug), 'manifest.json')}`,
      `echo '{}' > ${path.join(taskDir(withTask.slug), 'manifest.json')}`,
      `sed -i '' s/pending/done/ "${path.join(taskDir(withTask.slug), 'manifest.json')}"`,
      `rm ${statePath(withTask.session)}`,
      `echo x >> ${approvalsFile(withTask.session)}`,
      `ls ${path.join(store, 'approvals')}`,
      `cat ${path.join(home, 'projects', 'x', 'state', 's.json')}`,
      'rm ~/.shipline/projects/x/state/s.json',
      'cat ~/.shipline/projects/x/approvals/s.jsonl',
      'jq . $SHIPLINE_HOME/projects/x/tasks/t/manifest.json',
      'echo {} > "${SHIPLINE_HOME}/projects/x/approvals/s.jsonl"',
      'node .shipline/bin/record-answer.mjs < answer.json',
      'echo \'{"session_id":"s"}\' | node "$CLAUDE_PROJECT_DIR/.shipline/bin/record-answer.mjs"',
      'node .shipline/bin/stage.mjs advance --confirmed',
      'node .shipline/bin/stage.mjs skip --force --reason later',
      'node "$CLAUDE_PROJECT_DIR/.shipline/bin/stage.mjs" advance --force',
      'cd . && node .shipline/bin/stage.mjs advance --confirmed',
    ];
    for (const [label, session] of sessions()) {
      for (const c of commands) {
        const r = hook(dir, 'guard.mjs', bash(session, c));
        assert.equal(r.code, 0);
        assert.ok(isDeny(r), `${label}: ${c}: ${r.stdout}`);
      }
    }
  });

  test('ordinary commands are not blocked: git push --force, stage.mjs without the flags, reading artifacts', () => {
    const commands = [
      'git push --force',
      'git push --force-with-lease origin HEAD',
      'node .shipline/bin/stage.mjs advance && git push --force',
      'node .shipline/bin/stage.mjs advance; git push --force',
      'node .shipline/bin/stage.mjs status | grep --force',
      'node .shipline/bin/stage.mjs advance',
      'node .shipline/bin/stage.mjs status --json',
      'node .shipline/bin/stage.mjs pr-summary',
      `cat ${path.join(taskDir(withTask.slug), 'draft.md')}`,
      'grep -r approvals docs/',
      'ls src',
    ];
    for (const [label, session] of sessions()) {
      for (const c of commands) {
        const r = hook(dir, 'guard.mjs', bash(session, c));
        assert.equal(r.code, 0);
        assert.ok(!isDeny(r), `${label}: ${c}: ${r.stdout}`);
      }
    }
  });

  test('source edits are still allowed when the stage has no blocks (the existing stage rules are unchanged)', () => {
    const r = hook(dir, 'guard.mjs', file(withTask.session, 'Edit', path.join(dir, 'src', 'a.js')));
    assert.equal(r.code, 0);
    assert.ok(!isDeny(r), r.stdout);
  });
});

// ---------- pr-summary ----------

describe('stage.mjs pr-summary', () => {
  test('a visible table, then the hidden JSON (done / skipped / pending, and your answer / auto / —)', () => {
    const { session, slug } = taskAt('docs', { ui: 'false' });
    refused(session, 'skip', skipQ('docs', slug), '"Skip" and "Don\'t skip"');
    answer(session, skipQ('docs', slug), 'Skip');
    assert.equal(stage(dir, ['skip'], session).code, 0); // docs (answer); ui skipped (not UI work); ship is current
    const r = stage(dir, ['pr-summary'], session);
    assert.equal(r.code, 0, r.stderr);
    const json = {
      v: 1,
      workflow: 'trust',
      task: slug,
      stages: [
        { id: 'draft', status: 'done', enforcement: 'block', confirmed: 'answer' },
        { id: 'review', status: 'done', enforcement: 'warn', confirmed: 'auto' },
        { id: 'extra', status: 'skipped', enforcement: 'guide', confirmed: 'auto' },
        { id: 'docs', status: 'skipped', enforcement: 'guide', confirmed: 'answer' },
        { id: 'ui', status: 'skipped', enforcement: 'guide', confirmed: 'auto' },
        { id: 'ship', status: 'pending', enforcement: 'block', confirmed: null },
      ],
    };
    assert.equal(
      r.stdout,
      [
        '### Shipline',
        '| Stage | Status | Confirmed |',
        '| --- | --- | --- |',
        '| draft | done | your answer |',
        '| review | done | auto |',
        '| extra | skipped | auto |',
        '| docs | skipped | your answer |',
        '| ui | skipped | auto |',
        '| ship | pending | — |',
        `<!-- shipline:summary ${JSON.stringify(json)} -->`,
        '',
      ].join('\n'),
    );
    // The hidden part parses back to the same data.
    const m = /<!-- shipline:summary (.*) -->/.exec(r.stdout);
    assert.deepEqual(JSON.parse(m[1]), json);
  });

  test('a done confirm stage without a recorded answer (a hand-edited or pre-upgrade manifest) shows —, not auto', () => {
    const { session, slug } = taskAt('draft');
    const m = manifest(slug);
    m.stages[0].status = 'done'; // as an older stage.mjs --confirmed would have left it
    m.stages[1].status = 'in_progress';
    writeFileSync(path.join(taskDir(slug), 'manifest.json'), JSON.stringify(m, null, 2));
    const r = stage(dir, ['pr-summary'], session);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('| draft | done | — |'), r.stdout);
    const data = JSON.parse(/<!-- shipline:summary (.*) -->/.exec(r.stdout)[1]);
    assert.deepEqual(data.stages[0], { id: 'draft', status: 'done', enforcement: 'block', confirmed: null });
    assert.equal(data.stages[1].status, 'pending', 'in_progress is reported as pending');
  });

  test('needs a session with a task', () => {
    const r = stage(dir, ['pr-summary'], 'nobody');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /this session has no active task/);
  });
});
