#!/usr/bin/env node
// The Shipline pull-request check (run by .github/workflows/shipline.yml). Reads the PR description and labels
// from $GITHUB_EVENT_PATH, plus .shipline/config.yml and .shipline/workflows/<workflow>.yml from the checkout.
// A v2 summary may carry `scope` (test, lint and CI files edited, files outside the plan); it is shown, never a failure.
// With a v2 summary it also compares the code the checks ran on (summary.checks.fingerprint, a git tree id) with
// this checkout's `git rev-parse HEAD^{tree}`; a mismatch warns or fails per `ci.stale_checks`.
// Exit 0 = pass, 1 = fail. Writes GitHub annotations and, when it has a summary, a table to $GITHUB_STEP_SUMMARY.
// Node 18+, no dependencies. It needs no secrets, so it also works on PRs from forks.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
if (data.v !== undefined && data.v !== 1 && data.v !== 2) {
  fail(`The Shipline summary is version ${esc(data.v)}, which this check doesn't know. Upgrade Shipline in this repo (\`npx @forgeyard/shipline upgrade\`).`);
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
const STALE_TEXT =
  'The checks in the Shipline summary ran on different code than this PR (code changed after `stage.mjs check`, or the summary is from another task). Rerun `stage.mjs check` and paste `pr-summary` again.';
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

// ---------- checks (v2 summaries) ----------
const checks = data.checks && typeof data.checks === 'object' && Array.isArray(data.checks.results) ? data.checks : null;
const hasChecksStage = wf.stages.some((s) => s && s.checks === true);
const secs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '');
let checksCell = null;
if (checks) {
  const results = checks.results.filter((r) => r && typeof r === 'object');
  checksCell = results.length
    ? results
        .map((r) => (r.exit === 0 ? `${r.name} \u2713 ${secs(r.duration_ms)}`.trim() : `${r.name} \u2717 (${r.accepted ? 'accepted' : r.exit === null ? 'did not run' : `exit ${r.exit}`})`))
        .join(' \u00b7 ')
    : 'no commands configured';
  for (const r of results) {
    if (r.exit !== 0 && !r.accepted) problems.push(`The ${r.name} command failed (${r.exit === null ? 'it did not run' : `exit ${r.exit}`}) and the developer did not accept the failure.`);
  }
}

// ---------- scope (information only, never a failure) ----------
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const scope = data.scope && typeof data.scope === 'object' ? data.scope : null;
const scopeSensitive = scope ? strs(scope.sensitive) : [];
const scopeOutside = scope && Array.isArray(scope.outside_plan) ? strs(scope.outside_plan) : null;
let scopeCell = null;
if (scope) {
  const bits = [];
  if (scopeSensitive.length) bits.push(`${scopeSensitive.length} test, lint or CI file${scopeSensitive.length === 1 ? '' : 's'}`);
  if (scopeOutside && scopeOutside.length) bits.push(`${scopeOutside.length} file${scopeOutside.length === 1 ? '' : 's'} outside the plan`);
  scopeCell = bits.length ? `edits ${bits.join(', ')}${scope.accepted ? ' (accepted)' : ''}` : 'nothing sensitive, nothing outside the plan';
  if (bits.length) notice(`Scope: ${scopeCell}.`);
}

// Were the checks run on exactly this code? Never a failure when it can't be told, or for a v1 summary.
let staleMessage = null;
if (data.v === 1 || data.v === undefined) {
  if (hasChecksStage) notice("This summary is from an older Shipline (v1) and doesn't record where the checks ran, so their freshness can't be checked.");
} else if (!checks) {
  if (hasChecksStage) staleMessage = STALE_TEXT;
} else if (!checks.fingerprint) {
  notice("The summary's checks have no code fingerprint (not a git repo, or git failed), so their freshness can't be checked.");
} else {
  let head = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // Handled below.
  }
  if (!head) notice("Couldn't read this checkout's git tree, so the freshness of the checks can't be checked.");
  else if (head === checks.fingerprint) notice('Checks ran on this exact code.');
  else staleMessage = STALE_TEXT;
}
if (staleMessage && cfg.ci.stale_checks === 'fail') problems.push(staleMessage);
else if (staleMessage) warning(staleMessage);

const label = { answer: 'your answer', auto: 'auto' };
const cell = (v) => String(v === undefined || v === null ? '' : v).replace(/[|\r\n]/g, ' ');
summaryOut(
  [
    `### Shipline: ${cell(data.workflow)} / ${cell(data.task)}`,
    '| Stage | Status | Confirmed |',
    '| --- | --- | --- |',
    ...data.stages.map((s) => `| ${cell(s && s.id)} | ${cell(s && s.status)} | ${label[s && s.confirmed] || '—'} |`),
    ...(checksCell !== null ? [`| Checks | ${cell(checksCell)} | \u2014 |`] : []),
    ...(scopeCell !== null ? [`| Scope | ${cell(scopeCell)} | \u2014 |`] : []),
    ...(scopeSensitive.length ? ['', '<details><summary>Test, lint and CI files edited</summary>', '', ...scopeSensitive.map((f) => `- \`${cell(f)}\``), '', '</details>'] : []),
    ...(scopeOutside && scopeOutside.length ? ['', '<details><summary>Files outside the plan</summary>', '', ...scopeOutside.map((f) => `- \`${cell(f)}\``), '', '</details>'] : []),
    ...(problems.length ? ['', ...problems.map((p) => `- ${p}`)] : []),
  ].join('\n'),
);

if (problems.length) fail(...problems);
console.log(`Shipline: the ${wf.id} workflow summary checks out (${data.stages.length} stages).`);
