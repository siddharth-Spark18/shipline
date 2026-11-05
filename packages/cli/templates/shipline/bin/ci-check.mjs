#!/usr/bin/env node
// The Shipline pull-request check (run by .github/workflows/shipline.yml). Reads the PR description and labels
// from $GITHUB_EVENT_PATH, plus .shipline/config.yml and .shipline/workflows/<workflow>.yml from the checkout.
// Exit 0 = pass, 1 = fail. Writes GitHub annotations and, when it has a summary, a table to $GITHUB_STEP_SUMMARY.
// Node 18+, no dependencies. It needs no secrets, so it also works on PRs from forks.
import { appendFileSync, readFileSync } from 'node:fs';
import { findRoot, findStage, loadConfig, loadWorkflow, stageEnforcement } from './lib.mjs';

// Annotation text may not contain raw line breaks or percent signs.
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const error = (m) => console.log(`::error title=Shipline::${esc(m)}`);
const warning = (m) => console.log(`::warning title=Shipline::${esc(m)}`);
const notice = (m) => console.log(`::notice title=Shipline::${esc(m)}`);

function summaryOut(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  } catch {
    // The job summary is a convenience only.
  }
}

function fail(...messages) {
  for (const m of messages) error(m);
  process.exit(1);
}

let event;
try {
  event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'));
} catch (e) {
  fail(`Couldn't read the pull request event (${e.message}). This check only runs on pull_request events.`);
}
const pr = event && event.pull_request;
if (!pr) fail('This check only runs on pull_request events.');
const body = typeof pr.body === 'string' ? pr.body : '';
const labels = Array.isArray(pr.labels) ? pr.labels.map((l) => (l && l.name) || '').filter(Boolean) : [];

const root = findRoot(process.cwd());
if (!root) fail('No .shipline/config.yml in this checkout; Shipline is not installed in this repo.');
let cfg;
try {
  cfg = loadConfig(root);
} catch (e) {
  fail(`.shipline/config.yml could not be read: ${e.message}`);
}

// The last summary block in the description wins.
const blocks = [...body.matchAll(/<!--\s*shipline:summary\s+([\s\S]*?)\s*-->/g)];

if (!blocks.length) {
  const { missing_block: mode, skip_label: label } = cfg.ci;
  if (mode === 'warn') {
    warning('This pull request has no Shipline summary. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output into the description.');
    process.exit(0);
  }
  if (mode === 'fail-unless-label' && labels.includes(label)) {
    notice(`No Shipline summary, but the "${label}" label is set.`);
    process.exit(0);
  }
  fail(
    'This pull request has no Shipline summary. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output into the description' +
      (mode === 'fail-unless-label' ? `, or add the "${label}" label.` : '.'),
  );
}

let data;
try {
  data = JSON.parse(blocks[blocks.length - 1][1]);
} catch (e) {
  fail(`The Shipline summary in the description is not valid JSON (${e.message}). Paste the output of \`stage.mjs pr-summary\` again, unchanged.`);
}
if (!data || typeof data !== 'object' || !Array.isArray(data.stages)) {
  fail('The Shipline summary in the description has no stage list. Paste the output of `stage.mjs pr-summary` again, unchanged.');
}

let wf;
try {
  wf = loadWorkflow(root, data.workflow);
} catch (e) {
  fail(`The Shipline summary names a workflow this repo doesn't have (${e.message}).`);
}

// The summary and the workflow may name the ticket stage differently (`jira` before 0.10.0, `ticket` after).
const ranStages = data.stages.filter((s) => s && typeof s === 'object');
const problems = [];
for (const sc of wf.stages) {
  const s = findStage(ranStages, sc.id);
  const finished = s && (s.status === 'done' || (s.status === 'skipped' && (s.confirmed === 'answer' || s.confirmed === 'auto')));
  if (stageEnforcement(sc) === 'block' && !finished) {
    problems.push(`Stage "${sc.id}" is a block stage and is not done${s ? ` (it is ${s.status})` : ' (it is missing from the summary)'}.`);
  }
  if (sc.confirm_to_advance && s && s.status === 'done' && s.confirmed !== 'answer') {
    problems.push(`Stage "${sc.id}" needs the developer's confirmation, but the summary doesn't show their answer.`);
  }
}

const label = { answer: 'your answer', auto: 'auto' };
const cell = (v) => String(v === undefined || v === null ? '' : v).replace(/[|\r\n]/g, ' ');
summaryOut(
  [
    `### Shipline: ${cell(data.workflow)} / ${cell(data.task)}`,
    '| Stage | Status | Confirmed |',
    '| --- | --- | --- |',
    ...data.stages.map((s) => `| ${cell(s && s.id)} | ${cell(s && s.status)} | ${label[s && s.confirmed] || '—'} |`),
    ...(problems.length ? ['', ...problems.map((p) => `- ${p}`)] : []),
  ].join('\n'),
);

if (problems.length) fail(...problems);
console.log(`Shipline: the ${wf.id} workflow summary checks out (${data.stages.length} stages).`);
