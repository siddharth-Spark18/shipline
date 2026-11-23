#!/usr/bin/env node
// Stage CLI that Claude calls through Bash to record workflow progress.
//   node .shipline/bin/stage.mjs workflows [--shipped]   (--shipped: the shipped workflows this repo doesn't have yet)
//   node .shipline/bin/stage.mjs start --workflow feature --title "Add export" [--ticket PROJ-12 | 123] [--ui true|false]
//   node .shipline/bin/stage.mjs resume <task folder name or absolute path>
//   node .shipline/bin/stage.mjs status [--json] [--verbose]   (without a session: the unfinished tasks on this branch)
//   node .shipline/bin/stage.mjs status --all                  (every task in the store, with age and done/abandoned marker)
//   node .shipline/bin/stage.mjs abandon [--reason "..."] [--task <folder>]   (the developer confirms; resume undoes it)
//   node .shipline/bin/stage.mjs side --files a.md,docs/b.md --reason "..."   (the developer confirms; 30 minutes)
//   node .shipline/bin/stage.mjs side done
//   node .shipline/bin/stage.mjs explain                       (the last denial or question for this session, and the way past it)
//   node .shipline/bin/stage.mjs advance
//   node .shipline/bin/stage.mjs skip [--reason "..."]
//   node .shipline/bin/stage.mjs reopen <stage>
//   node .shipline/bin/stage.mjs flag ui true|false
//   node .shipline/bin/stage.mjs check
//   node .shipline/bin/stage.mjs check --expect-fail [test file or name]   (fail_first: records a failing test run at Reproduce)
//   node .shipline/bin/stage.mjs pr-summary
//   node .shipline/bin/stage.mjs validate <folder with workflow.yml and rules/ | workflow .yml file | .shipline>
//   node .shipline/bin/stage.mjs draft --tmp                           (a fresh scratch folder for /shipline-workflow-designer)
//   node .shipline/bin/stage.mjs draft <workflow-id> --from <folder>   (validates the folder, then stores it as a draft for Setup)
// A confirm_to_advance stage (and skipping a non-optional stage) needs the developer's own answer to the
// question that `advance` / `skip` prints; there are no override flags.
// `check` runs the test, lint and build commands from config.yml and records the results in the manifest; a stage
// with `checks: true` (verify) can't finish without a passing run on the current code, unless the developer accepts.
// `check` also records the scope of the change (test, lint and CI files it edits, files outside the plan); when
// there is any, finishing that stage needs the developer's answer to a `scope` question too.
// With SHIPLINE_NONINTERACTIVE=1 nothing can be asked: see non_interactive in config.yml.
// Session: $SHIPLINE_SESSION (set by the SessionStart hook) or --session <id>. Task override: --task <folder>.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  findRoot, loadConfig, needsAnswer, loadWorkflow, listWorkflows, readManifest, manifestPath, readSession, statePath,
  tasksDir, writeJson, isDone, currentStage, slugify, stageEnforcement, confirmQuestion, readApprovals,
  consumeApproval, CONFIRM_OPTIONS, sameStage, findStage, fingerprint, findSection, sectionProblems, scopeOf, scopeText,
  listOpenTasks, listAllTasks, currentBranch, draftsDir, draftsTmpDir, parseYaml, isInside, failFirstLevel,
  bindSession, readOwner, writeOwner, activeOtherOwner, ownerWarning, readDecision,
} from './lib.mjs';
import { validateWorkflow } from './workflow-check.mjs';

function die(msg) {
  console.error(`shipline: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
if (flags.confirmed !== undefined || flags.force !== undefined) {
  die(
    '--confirmed and --force no longer exist. Run `advance` (or `skip`) without them: when the developer must decide, ' +
      'it prints a question to ask them with AskUserQuestion, and the stage moves on only after they answer it.',
  );
}
const root = findRoot(process.cwd());
if (!root) die('no .shipline/config.yml found. Run `npx @forgeyard/shipline init` first.');

let cfg;
try {
  cfg = loadConfig(root);
} catch (e) {
  die(e.message);
}
let tasksBase;
try {
  tasksBase = tasksDir(root);
} catch (e) {
  die(e.message);
}
const sessionId = typeof flags.session === 'string' ? flags.session : process.env.SHIPLINE_SESSION;
const now = () => new Date().toISOString();

function fill(pattern, vars) {
  let s = String(pattern);
  s = vars.key ? s.replaceAll('{key}', vars.key) : s.replace(/\{key\}[-_]?/g, '');
  return s.replaceAll('{slug}', vars.slug).replaceAll('{type}', vars.type);
}

// A task is given as a folder name in the store or as an absolute store path; either becomes the absolute path.
function resolveTask(given) {
  const t = String(given).replace(/[\\/]+$/, '');
  return path.isAbsolute(t) ? t : path.join(tasksBase, t);
}

// allowLast: with no binding, fall back to the task this session just finished (`last_task`), and say so.
function activeTaskDir(allowLast = false) {
  if (typeof flags.task === 'string') return resolveTask(flags.task);
  if (!sessionId) die('no session id. Pass --session <id> (it is in the SessionStart context) or set SHIPLINE_SESSION.');
  const s = readSession(root, sessionId);
  if (s && !s.task_dir && allowLast && typeof s.last_task === 'string' && s.last_task) {
    console.error(`(task ${s.last_task}, finished in this session)`); // stderr: pr-summary output is pasted as is
    return s.last_task;
  }
  if (!s || !s.task_dir) die('this session has no active task. Use `start` or `resume` first.');
  return s.task_dir;
}

function load(taskDir) {
  const manifest = readManifest(root, taskDir);
  if (!manifest) die(`no manifest.json in ${taskDir}`);
  const wf = loadWorkflow(root, manifest.task.workflow);
  return { manifest, wf };
}

function save(taskDir, manifest) {
  manifest.task.updated = now();
  writeJson(manifestPath(root, taskDir), manifest);
}

function bind(taskDir, workflow) {
  if (!sessionId) die('no session id. Pass --session <id> or set SHIPLINE_SESSION.');
  bindSession(root, sessionId, taskDir, workflow);
  writeOwner(taskDir, sessionId);
}

// Removes this session's binding when it is bound to taskDir. keepLast: the state keeps `last_task` (a finished task),
// so pr-summary and status still find it.
function unbind(taskDir, keepLast = false) {
  if (!sessionId) return false;
  const st = readSession(root, sessionId);
  if (!st || !st.task_dir || path.resolve(st.task_dir) !== path.resolve(taskDir)) return false;
  if (keepLast) writeJson(statePath(root, sessionId), { session_id: sessionId, last_task: taskDir });
  else rmSync(statePath(root, sessionId), { force: true });
  return true;
}

const nonInteractive = process.env.SHIPLINE_NONINTERACTIVE === '1';

// A command that needs the developer's answer, in a run where nobody can give it: ends with the policy message.
function denyNonInteractive(detail) {
  die(
    "This stage needs the developer's answer, and this is a non-interactive run (SHIPLINE_NONINTERACTIVE=1). " +
      'Set non_interactive: checks_pass in .shipline/config.yml to let passing checks advance, or run interactively.' +
      (detail ? ` (${detail})` : ''),
  );
}

// null when the latest `check` ran on the current code and every command passed; else what is missing or failing.
function checksProblem(manifest) {
  const ch = manifest.checks && Array.isArray(manifest.checks.results) ? manifest.checks : null;
  if (!ch || !ch.results.length) return 'no check has been run: run `stage.mjs check`';
  const failed = ch.results.filter((r) => r.exit !== 0).map((r) => r.name);
  if (failed.length) return `checks failing: ${failed.join(', ')}`;
  const current = fingerprint(root);
  if (!ch.fingerprint || !current || current !== ch.fingerprint) return 'the checks did not run on the current code: run `stage.mjs check` again';
  return null;
}

// The commit the task starts from (`git rev-parse HEAD`), or null outside git or with no commits. The scope check
// compares the working tree against it.
function baseCommit() {
  try {
    const id = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function stageCfg(wf, id) {
  return findStage(wf.stages, id) || { id };
}

// A stage's rules: rules/<id>.md. The ticket stage (`ticket`, or `jira` before 0.10.0) tries ticket.md, then jira.md.
function rulesFor(id) {
  const names = sameStage(id, 'ticket') ? ['ticket', 'jira'] : [id];
  for (const n of names) {
    const f = path.join(root, '.shipline', 'rules', `${n}.md`);
    if (existsSync(f)) return { file: `${n}.md`, text: readFileSync(f, 'utf8').trim() };
  }
  return null;
}

// What to do at the ticket stage, for the configured tracker.
function trackerLine(manifest) {
  const tracker = cfg.tracker;
  if (tracker === 'github') {
    const n = manifest.task.issue;
    return n
      ? `Tracker: github. Read the issue with \`gh issue view ${n} --json number,title,body,labels,url,state\` (read-only) and save it to the artifact. Skip with \`stage.mjs skip --reason "GitHub not connected"\` when gh is missing, not signed in, or the call fails.`
      : 'Tracker: github. This task has no issue number; use ticket details the developer pasted, or skip with `stage.mjs skip --reason "No issue"`.';
  }
  if (tracker === 'jira') {
    return 'Tracker: jira. Read the ticket through the Atlassian tools (read-only) and save it to the artifact. Skip with `stage.mjs skip --reason "Jira not connected"` when they are unavailable.';
  }
  if (tracker === 'none') return 'Tracker: none. This stage is skipped automatically; if you are here anyway, run `stage.mjs skip --reason "No tracker"`.';
  return `Tracker: "${tracker}" is not supported; skip this stage with \`stage.mjs skip --reason "Tracker not supported"\`.`;
}

// The stage's required section headings: non-empty strings only.
function sections(sc) {
  return Array.isArray(sc.sections) ? sc.sections.filter((h) => typeof h === 'string' && h.trim()) : [];
}

// ---------- fail-first (config.yml `fail_first`) ----------

// failFirstLevel (lib.mjs) with this run's config and the workflow's id.
const ffLevel = (stageId, wf) => failFirstLevel(cfg, stageId, wf.id);

// The built-in note printed with Reproduce, before the repo's own rules; null when fail_first doesn't apply.
function failFirstNote(stageId, wf) {
  const level = ffLevel(stageId, wf);
  if (level === 'off') return null;
  const lines = ['Shipline (fail-first): before changing any code, write a test that reproduces this bug and fails on the current code. Name it in reproduction.md.'];
  if (level === 'section') lines.push('reproduction.md must have a `## Failing test` section naming the test and showing its failing output.');
  if (level === 'proof') lines.push('Run `node .shipline/bin/stage.mjs check --expect-fail [test file or name]` to record that it fails. Reproduce can\'t finish until a failing run is recorded.');
  return lines.join('\n');
}

// The code after a check run: { fp, note }. When the commands changed files (coverage reports, tsbuildinfo,
// `eslint --fix`), fp is the post-run fingerprint and note says which files; otherwise fp is the pre-run one.
function afterRun(pre) {
  if (pre === null) return { fp: pre, note: null };
  const post = fingerprint(root);
  if (post === null || post === pre) return { fp: pre, note: null };
  let list = '';
  try {
    const names = execFileSync('git', ['diff-tree', '-r', '--name-only', pre, post], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(Boolean);
    if (names.length) list = `: ${names.slice(0, 10).join(', ')}${names.length > 10 ? `, +${names.length - 10} more` : ''}`;
  } catch {
    // No list; the note is still printed.
  }
  return {
    fp: post,
    note: `Note: the checks changed these files${list}. The result is recorded for the code as it is now. Add generated files to .gitignore to keep them out of the diff.`,
  };
}

// Arguments `check --expect-fail` may append to the test command: no spaces, quotes, shell characters or `..` segments.
const EXPECT_FAIL_ARG = /^[A-Za-z0-9_./:@=,+-]+$/;

// The words after --expect-fail on the command line (parseArgs would read the first one as the flag's value), without
// the global --session and --task options.
function expectFailExtras() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--expect-fail');
  const out = [];
  for (let k = i + 1; k < argv.length; k++) {
    if (argv[k] === '--session' || argv[k] === '--task') k++;
    else out.push(argv[k]);
  }
  return out;
}

// The "Fail-first: ..." facts for Verify and the PR summary, or null when no failing run is recorded:
// { before: { exit, fingerprint }, after: { exit, fingerprint } | null } (after: the latest test result).
function failFirstFacts(manifest) {
  const ff = manifest.fail_first;
  if (!ff || typeof ff !== 'object') return null;
  const ch = manifest.checks && Array.isArray(manifest.checks.results) ? manifest.checks : null;
  const t = ch && ch.results.find((r) => r.name === 'test');
  return { before: { exit: ff.exit, fingerprint: ff.fingerprint || null }, after: t ? { exit: t.exit, fingerprint: ch.fingerprint || null } : null };
}

function failFirstLine(facts) {
  const fp = (v) => (v ? v.slice(0, 12) : 'none');
  const before = `failed before (exit ${facts.before.exit} on ${fp(facts.before.fingerprint)})`;
  if (!facts.after) return `Fail-first: ${before}, no test result after`;
  return `Fail-first: ${before}, ${facts.after.exit === 0 ? 'passed' : `not passing (exit ${facts.after.exit === null ? 'did not run' : facts.after.exit})`} after (on ${fp(facts.after.fingerprint)})`;
}

function describeCurrent(taskDir, manifest, wf) {
  const cur = currentStage(manifest);
  if (!cur) return 'All stages are done. The task is complete.';
  const sc = stageCfg(wf, cur.id);
  const lines = [
    `Current stage: ${sc.name || cur.id} [${cur.id}]`,
    sc.artifact ? `Artifact to produce: ${taskDir}/${sc.artifact}` : 'No required artifact.',
    sc.agent ? `Suggested agent: ${sc.agent}` : null,
    sections(sc).length ? `Required sections in the artifact (each needs real text under its heading): ${sections(sc).join(', ')}` : null,
    sc.checks === true ? 'Checks: run `node .shipline/bin/stage.mjs check` (Bash timeout 600000 ms, or in the background for slow suites) before advancing; rerun it after any code change.' : null,
    `Enforcement: ${stageEnforcement(sc)}. Confirm with the developer before advancing: ${needsAnswer(sc, cfg) ? 'YES (`advance` prints the question to ask them; it only goes through after they answer it)' : sc.confirm_to_advance ? 'no (light confirmations: auto-advance)' : 'no (auto-advance)'}`,
  ].filter(Boolean);
  if (Array.isArray(cfg.skills) && cfg.skills.length) lines.push(`Repo skills you can use: ${cfg.skills.join(', ')}`);
  if (sameStage(cur.id, 'ticket')) lines.push(trackerLine(manifest));
  const note = failFirstNote(cur.id, wf);
  if (note) lines.push('', note);
  const rules = rulesFor(cur.id);
  if (rules && rules.text) lines.push('', `Repo rules for this stage (.shipline/rules/${rules.file}):`, rules.text);
  return lines.join('\n');
}

// ---------- confirmations ----------

function clearPending() {
  if (!sessionId) return;
  const st = readSession(root, sessionId);
  if (st && st.pending_confirm) {
    const { pending_confirm: _gone, ...rest } = st;
    writeJson(statePath(root, sessionId), rest);
  }
}

function questionText(q) {
  return [
    'Ask the developer this with the AskUserQuestion tool, exactly as written (do not change the wording):',
    `  header: ${q.header}`,
    `  question: ${q.question}`,
    `  options: ${q.options.map((o) => `"${o}"`).join(' and ')}`,
  ].join('\n');
}

// The developer's own answer for advancing past / skipping the current stage. Returns the approval it used
// (and clears pending_confirm), or ends the process after printing the question to ask.
function requireAnswer(kind, stageId, taskDir, manifest, extra) {
  const verb =
    kind === 'abandon' ? 'confirm abandoning the task' : kind === 'side' ? 'allow edits outside the task stages' : kind === 'advance' ? 'confirm advancing' : kind === 'accept' ? 'decide whether to finish with failed checks' : kind === 'scope' ? 'decide whether to finish with edits to test, lint or CI files or files outside the plan' : 'confirm skipping';
  if (nonInteractive) {
    // Only `advance` can be approved without a developer, and only by passing checks on the current code.
    if (kind === 'advance' && cfg.non_interactive === 'checks_pass') {
      const problem = checksProblem(manifest);
      if (!problem) return { at: now(), non_interactive: true };
      denyNonInteractive(problem);
    }
    denyNonInteractive();
  }
  if (!sessionId) die(`no session id; confirmations need the session that asked the question. Pass --session <id> or set SHIPLINE_SESSION.`);
  const q = confirmQuestion(stageId, kind, manifest.task.slug, extra);
  const st = readSession(root, sessionId) || { session_id: sessionId };
  const pend = st.pending_confirm;
  // Re-running keeps the original issued_at, so an answer already given stays valid.
  const same = pend && pend.stage === stageId && pend.kind === kind && pend.question === q.question && pend.task_dir === taskDir;
  const pending = same ? pend : { stage: stageId, kind, question: q.question, issued_at: now(), task_dir: taskDir };
  if (!same) writeJson(statePath(root, sessionId), { ...st, pending_confirm: pending });

  const issued = Date.parse(pending.issued_at);
  const yes = CONFIRM_OPTIONS[kind].yes;
  const approval = consumeApproval(
    root,
    sessionId,
    (a) =>
      a.kind === kind &&
      a.stage === stageId &&
      typeof a.task_dir === 'string' && path.resolve(a.task_dir) === path.resolve(taskDir) &&
      a.answer === yes &&
      (a.question === undefined || a.question === pending.question) &&
      Date.parse(a.at) > issued,
  );
  if (approval) {
    clearPending();
    return approval;
  }
  const declined = readApprovals(root, sessionId).some((a) => a.kind === kind && a.stage === stageId && a.answer === CONFIRM_OPTIONS[kind].no && Date.parse(a.at) > issued);
  console.error(
    `shipline: stage "${stageId}" needs the developer to ${verb}${declined ? ' (they answered "' + CONFIRM_OPTIONS[kind].no + '" last time)' : ''}.\n` +
      `${questionText(q)}\n` +
      `Then run \`${cmd}\` again${kind === 'abandon' || kind === 'side' ? ' with exactly the same arguments' : ''}. Do not pass any flag or edit any progress file to get around this.`,
  );
  process.exit(1);
}

// The developer's answer to an `advance` question that is pending for this stage, consumed with the same lookup
// requireAnswer uses; null when there is no such question or no answer yet.
function takePendingAdvanceAnswer(stageId, taskDir) {
  if (!sessionId) return null;
  const st = readSession(root, sessionId);
  const pend = st && st.pending_confirm;
  if (!pend || pend.kind !== 'advance' || pend.stage !== stageId || pend.task_dir !== taskDir) return null;
  const issued = Date.parse(pend.issued_at);
  return consumeApproval(
    root,
    sessionId,
    (a) =>
      a.kind === 'advance' &&
      a.stage === stageId &&
      typeof a.task_dir === 'string' && path.resolve(a.task_dir) === path.resolve(taskDir) &&
      a.answer === CONFIRM_OPTIONS.advance.yes &&
      (a.question === undefined || a.question === pend.question) &&
      Date.parse(a.at) > issued,
  );
}

// Moves to the next stage that applies; marks conditional stages that do not apply as skipped.
function activateNext(manifest, wf) {
  for (const ms of manifest.stages) {
    if (isDone(ms.status)) continue;
    const sc = stageCfg(wf, ms.id);
    // No tracker: there is no ticket to read, so the ticket stage is skipped without a question.
    if (cfg.tracker === 'none' && sameStage(ms.id, 'ticket')) {
      ms.status = 'skipped';
      ms.reason = 'No tracker';
      ms.skipped = { via: sc.optional ? 'optional' : 'auto', at: now(), reason: ms.reason };
      ms.updated = now();
      continue;
    }
    if (sc.condition === 'ui_only') {
      if (manifest.flags.ui === null || manifest.flags.ui === undefined) {
        die(`stage "${ms.id}" only applies to UI work. Decide first: node .shipline/bin/stage.mjs flag ui true|false`);
      }
      if (manifest.flags.ui === false) {
        ms.status = 'skipped';
        ms.reason = 'not UI work';
        ms.skipped = { via: 'optional', at: now(), reason: ms.reason };
        ms.updated = now();
        continue;
      }
    }
    ms.status = 'in_progress';
    ms.updated = now();
    return ms;
  }
  manifest.complete = true;
  return null;
}

// ---------- workflow validation and drafts (used by /shipline-workflow-designer) ----------

const ID_RE = /^[A-Za-z0-9_-]+$/;
const DRAFT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function listNames(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext) && ID_RE.test(f.slice(0, -ext.length)))
      .map((f) => f.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

function readTextOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// What to check for a `validate` target: [{ file (shown in messages), path, id (null: the file's own id), rulesDir }].
function validationTargets(target) {
  const abs = path.resolve(process.cwd(), target);
  let st;
  try {
    st = statSync(abs);
  } catch {
    die(`validate: ${target} does not exist`);
  }
  const repoShipline = path.join(root, '.shipline');
  if (st.isDirectory() && path.resolve(abs) === repoShipline) {
    return listNames(path.join(repoShipline, 'workflows'), '.yml').map((id) => ({
      file: `.shipline/workflows/${id}.yml`,
      path: path.join(repoShipline, 'workflows', `${id}.yml`),
      id,
      rulesDir: null,
    }));
  }
  if (st.isDirectory()) {
    const wf = path.join(abs, 'workflow.yml');
    if (!existsSync(wf)) die(`validate: ${target} has no workflow.yml`);
    return [{ file: path.join(target, 'workflow.yml'), path: wf, id: null, rulesDir: path.join(abs, 'rules') }];
  }
  if (!abs.endsWith('.yml')) die('validate: expected a folder, a .yml file or .shipline');
  return [{ file: target, path: abs, id: path.basename(abs, '.yml'), rulesDir: null }];
}

// -> { errors: [string], warnings: [string], model } for one target.
function validateTarget(t, agents) {
  const errors = [];
  const warnings = [];
  const line = (i) => `${t.file}: ${i.path || '(workflow)'}: ${i.message}`;
  let model = null;
  try {
    model = parseYaml(readFileSync(t.path, 'utf8'));
  } catch (e) {
    errors.push(`${t.file}: (workflow): ${e.message}`);
    return { errors, warnings, model };
  }
  const id = t.id ?? (model && typeof model.id === 'string' ? model.id : '');
  if (t.id === null && !ID_RE.test(id)) {
    errors.push(`${t.file}: id: must be set, and may only contain letters, digits, - and _`);
    return { errors, warnings, model };
  }
  const onDisk = readTextOrNull(path.join(root, '.shipline', 'workflows', `${id}.yml`));
  let existingStageIds = [];
  try {
    const cur = onDisk === null ? null : parseYaml(onDisk);
    existingStageIds = cur && Array.isArray(cur.stages) ? cur.stages.filter((s) => s && typeof s === 'object').map((s) => s.id) : [];
  } catch {
    // An unreadable file on disk only means no stage id is exempt from the id-format check.
  }
  for (const i of validateWorkflow(model, { id, agents, existingStageIds })) (i.severity === 'warning' ? warnings : errors).push(line(i));
  // A stage without a rules file works, but has no repo rules to follow.
  if (model && Array.isArray(model.stages)) {
    model.stages.forEach((s, i) => {
      if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) return;
      const names = sameStage(s.id, 'ticket') ? ['ticket', 'jira'] : [s.id];
      const has = names.some((n) => (t.rulesDir && existsSync(path.join(t.rulesDir, `${n}.md`))) || existsSync(path.join(root, '.shipline', 'rules', `${n}.md`)));
      if (!has) warnings.push(`${t.file}: stages[${i}].id: no rules file rules/${s.id}.md for stage "${s.id}"`);
    });
  }
  return { errors, warnings, model };
}

// Prints the result; returns true when there are no errors.
function validateReport(targets) {
  const agents = listNames(path.join(root, '.claude', 'agents'), '.md');
  let ok = true;
  const results = targets.map((t) => ({ t, ...validateTarget(t, agents) }));
  for (const r of results) {
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const e of r.errors) console.log(e);
    if (r.errors.length) ok = false;
  }
  if (ok) console.log('ok');
  return { ok, results };
}

function removeOldTmp(base) {
  let names = [];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const n of names) {
    try {
      if (Date.now() - statSync(path.join(base, n)).mtimeMs > DRAFT_TMP_MAX_AGE_MS) rmSync(path.join(base, n), { recursive: true, force: true });
    } catch {
      // Best effort: a folder that is in use or already gone is left alone.
    }
  }
}

function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function draftCommand() {
  const tmpBase = draftsTmpDir(root);
  removeOldTmp(tmpBase);
  if (flags.tmp === true) {
    const dir = path.join(tmpBase, randomBytes(4).toString('hex'));
    mkdirSync(dir, { recursive: true });
    console.log(dir);
    return;
  }
  const id = pos[1];
  if (!id || typeof flags.from !== 'string') die('usage: draft --tmp | draft <workflow-id> --from <folder in the drafts-tmp folder>');
  if (!ID_RE.test(id)) die(`draft: "${id}" is not a workflow id (letters, digits, - and _ only)`);
  const from = path.resolve(process.cwd(), flags.from);
  const inside = [[path.resolve(tmpBase), path.resolve(from)], [realOrResolved(tmpBase), realOrResolved(from)]].every(([b, f]) => f !== b && isInside(b, f));
  if (!inside) die(`draft: --from must be a folder inside ${tmpBase} (create one with \`draft --tmp\`)`);
  if (!existsSync(path.join(from, 'workflow.yml'))) die(`draft: ${flags.from} has no workflow.yml`);

  const target = { file: 'workflow.yml', path: path.join(from, 'workflow.yml'), id: null, rulesDir: path.join(from, 'rules') };
  const { ok, results } = validateReport([target]);
  if (!ok) process.exit(1);
  const model = results[0].model;
  if (model.id !== id) die(`draft: the id in workflow.yml ("${model.id}") must equal "${id}"`);

  const rules = listNames(path.join(from, 'rules'), '.md');
  const dest = path.join(draftsDir(root), id);
  const staging = `${dest}.${process.pid}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.join(staging, 'rules'), { recursive: true });
  cpSync(path.join(from, 'workflow.yml'), path.join(staging, 'workflow.yml'));
  const rulesBase = {};
  for (const n of rules) {
    cpSync(path.join(from, 'rules', `${n}.md`), path.join(staging, 'rules', `${n}.md`));
    const cur = readTextOrNull(path.join(root, '.shipline', 'rules', `${n}.md`));
    rulesBase[n] = cur === null ? null : sha256(cur);
  }
  const curWf = readTextOrNull(path.join(root, '.shipline', 'workflows', `${id}.yml`));
  writeJson(path.join(staging, 'meta.json'), { workflowId: id, createdAt: now(), baseHash: curWf === null ? null : sha256(curWf), rulesBase });
  rmSync(dest, { recursive: true, force: true }); // one draft per workflow id: the new one replaces the old
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(staging, dest, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  rmSync(from, { recursive: true, force: true });
  console.log(dest);
}

switch (cmd) {
  case 'workflows': {
    if (flags.shipped) {
      const dir = path.join(root, '.shipline', 'bin', 'shipped');
      const have = new Set(listWorkflows(root).map((w) => w.id));
      for (const id of listNames(dir, '.yml')) {
        if (have.has(id) || existsSync(path.join(root, '.shipline', 'workflows', `${id}.yml`))) continue;
        let w;
        try {
          w = parseYaml(readFileSync(path.join(dir, `${id}.yml`), 'utf8'));
        } catch {
          continue;
        }
        if (w && Array.isArray(w.stages)) console.log(`${id}: ${w.name || id} - ${w.description || ''} [${w.stages.map((x) => x.id).join(' > ')}]`);
      }
      break;
    }
    for (const w of listWorkflows(root)) console.log(`${w.id}: ${w.name || w.id} - ${w.description || ''} [${w.stages.map((s) => s.id).join(' > ')}]`);
    break;
  }

  case 'start': {
    const wfId = flags.workflow;
    if (typeof wfId !== 'string') die('--workflow <id> is required (see `workflows`).');
    let wf;
    try {
      wf = loadWorkflow(root, wfId);
    } catch (e) {
      die(e.message);
    }
    let key = '';
    let issue = null;
    if (typeof flags.ticket === 'string') {
      if (cfg.tracker === 'github') {
        const m = /^(?:#|issue-)?(\d+)$/i.exec(flags.ticket.trim());
        if (!m) die('GitHub issue numbers look like 123 or #123.');
        issue = Number(m[1]);
        key = `issue-${issue}`;
      } else key = flags.ticket.toUpperCase();
    }
    const baseSlug = slugify(flags.slug || flags.title);
    if (!flags.slug && !flags.title) die('--title (or --slug) is required.');
    // A folder that exists (open, done or abandoned) is never reused: -2, -3, ... for the folder and the suggested branch.
    let slug = baseSlug;
    let taskDir = path.join(tasksBase, key ? `${key}-${slug}` : slug);
    for (let n = 2; existsSync(taskDir); n++) {
      slug = `${baseSlug}-${n}`;
      taskDir = path.join(tasksBase, key ? `${key}-${slug}` : slug);
    }
    const vars = { key, slug, type: typeof flags.type === 'string' ? flags.type : wf.branch_type || wf.id };
    const ui = flags.ui === 'true' ? true : flags.ui === 'false' ? false : null;
    const manifest = {
      version: 1,
      task: {
        slug: path.basename(taskDir),
        title: typeof flags.title === 'string' ? flags.title : slug,
        key: key || null,
        ...(issue !== null ? { issue } : {}),
        workflow: wf.id,
        branch: fill(cfg.branch_pattern, vars),
        created: now(),
        updated: now(),
        base_commit: baseCommit(),
      },
      flags: { ui },
      complete: false,
      stages: wf.stages.map((s) => ({ id: s.id, status: 'pending', artifact: s.artifact || null, updated: now() })),
    };
    activateNext(manifest, wf);
    mkdirSync(taskDir, { recursive: true });
    bind(taskDir, wf.id);
    save(taskDir, manifest);
    if (slug !== baseSlug) console.log(`A task folder for "${baseSlug}" already exists; using ${path.basename(taskDir)}.`);
    console.log(`Started ${wf.name || wf.id} task in ${taskDir}\nSuggested branch: ${manifest.task.branch}\n\n${describeCurrent(taskDir, manifest, wf)}`);
    break;
  }

  case 'resume': {
    if (!pos[1]) die('usage: resume <task folder name or absolute path>');
    const taskDir = resolveTask(pos[1]);
    const { manifest, wf } = load(taskDir);
    const other = sessionId ? activeOtherOwner(taskDir, sessionId) : null;
    if (manifest.abandoned) {
      delete manifest.abandoned;
      save(taskDir, manifest);
    }
    bind(taskDir, wf.id);
    if (other) console.log(ownerWarning(other));
    console.log(`Resumed ${taskDir} (${wf.id} workflow).\nSuggested branch: ${manifest.task.branch}\n\n${statusText(taskDir, manifest, wf)}`);
    break;
  }

  case 'status': {
    if (flags.all) {
      listEverything();
      break;
    }
    // No session and no --task: say which unfinished tasks belong to this branch instead of failing.
    if (typeof flags.task !== 'string' && !sessionId) {
      listBranchTasks();
      break;
    }
    const taskDir = activeTaskDir(true);
    const { manifest, wf } = load(taskDir);
    if (flags.json) console.log(JSON.stringify({ task_dir: taskDir, ...manifest }, null, 2));
    else {
      console.log(flags.verbose ? statusText(taskDir, manifest, wf) : shortStatus(taskDir, manifest, wf));
      // A confirmation question that is still open (for example after resuming in a new session) is printed again.
      const cur = currentStage(manifest);
      const st = sessionId ? readSession(root, sessionId) : null;
      const pend = st && st.pending_confirm;
      if (cur && pend && pend.stage === cur.id && pend.task_dir === taskDir) {
        // An accept or scope question carries the run it is about, so it is shown as it was issued.
        const q = pend.kind === 'accept' || pend.kind === 'scope' ? { header: 'Shipline', question: pend.question, options: [CONFIRM_OPTIONS[pend.kind].yes, CONFIRM_OPTIONS[pend.kind].no] } : confirmQuestion(cur.id, pend.kind, manifest.task.slug);
        console.log(`\nA confirmation is still open (run \`${pend.kind === 'accept' || pend.kind === 'scope' ? 'advance' : pend.kind}\` after the developer answers).\n${questionText(q)}`);
      }
    }
    break;
  }

  case 'advance':
  case 'skip': {
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    const cur = currentStage(manifest);
    if (!cur) die('all stages are already done.');
    const sc = stageCfg(wf, cur.id);
    if (cmd === 'advance') {
      if (sc.artifact && !existsSync(path.join(taskDir, sc.artifact))) {
        die(`stage "${cur.id}" is not finished: ${taskDir}/${sc.artifact} does not exist yet.`);
      }
      if (sc.artifact) {
        const wanted = sections(sc);
        if (ffLevel(cur.id, wf) === 'section' && !wanted.some((h) => h.trim().replace(/:+$/, '').trim().toLowerCase() === 'failing test')) wanted.push('Failing test');
        if (wanted.length) {
          const problems = sectionProblems(readFileSync(path.join(taskDir, sc.artifact), 'utf8'), wanted);
          if (problems.length) die(`${sc.artifact} is missing: ${problems.join(', ')}.`);
        }
      }
      if (ffLevel(cur.id, wf) === 'proof') {
        if (!configuredCommands().some(([n]) => n === 'test')) {
          die('fail_first is set to proof but no test command is configured. Set commands.test in .shipline/config.yml, or skip this stage with a reason (`stage.mjs skip --reason "..."`).');
        }
        const rec = manifest.fail_first;
        if (!rec || typeof rec.exit !== 'number' || rec.exit === 0) {
          die('fail_first is set to proof: Reproduce can\'t finish until a failing test run is recorded. Run `node .shipline/bin/stage.mjs check --expect-fail [test file or name]` against the test that reproduces the bug.');
        }
      }
      if (sc.checks === true) gateChecks(taskDir, manifest, cur);
      if (needsAnswer(sc, cfg)) {
        const a = requireAnswer('advance', cur.id, taskDir, manifest);
        if (a.non_interactive) {
          cur.confirmed = { via: 'non_interactive', at: a.at };
          cur.approved_by = 'non_interactive';
        } else cur.confirmed = { via: 'answer', at: a.at };
      } else {
        // No question is needed (the stage doesn't ask, or light mode is on). An "Advance" answer the developer
        // already gave for a pending question on this stage is still used; otherwise the stage finishes as auto.
        const a = takePendingAdvanceAnswer(cur.id, taskDir);
        if (a) cur.confirmed = { via: 'answer', at: a.at };
        clearPending();
      }
      cur.status = 'done';
    } else {
      const reason = typeof flags.reason === 'string' ? flags.reason : 'skipped';
      if (!sc.optional && !sc.condition) {
        const a = requireAnswer('skip', cur.id, taskDir, manifest);
        cur.skipped = { via: 'answer', at: a.at, reason };
      } else {
        clearPending();
        cur.skipped = { via: 'optional', at: now(), reason };
      }
      cur.status = 'skipped';
      cur.reason = reason;
    }
    cur.updated = now();
    activateNext(manifest, wf);
    save(taskDir, manifest);
    console.log(`${cmd === 'advance' ? 'Done' : 'Skipped'}: ${cur.id}\n\n${describeCurrent(taskDir, manifest, wf)}`);
    // The last stage is done: this session stops tracking the task (the next request is a new one).
    if (manifest.complete && unbind(taskDir, true)) console.log(`\nTask ${path.basename(taskDir)} is complete; this session is no longer tracking a task.`);
    break;
  }

  case 'abandon': {
    const taskDir = activeTaskDir();
    const manifest = readManifest(root, taskDir);
    if (!manifest) die(`no manifest.json in ${taskDir}`);
    if (manifest.abandoned) die(`${path.basename(taskDir)} is already abandoned. Resume it with: stage.mjs resume ${path.basename(taskDir)}`);
    if (!currentStage(manifest)) die(`${path.basename(taskDir)} is complete; there is nothing to abandon.`);
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
    requireAnswer('abandon', 'abandon', taskDir, manifest, { reason });
    manifest.abandoned = { at: now(), reason };
    save(taskDir, manifest);
    unbind(taskDir);
    console.log(`Abandoned ${path.basename(taskDir)}. Resume it any time with stage.mjs resume ${path.basename(taskDir)}.`);
    break;
  }

  case 'side': {
    if (!sessionId) die('no session id. Pass --session <id> or set SHIPLINE_SESSION.');
    const st = readSession(root, sessionId);
    if (!st || !st.task_dir) {
      console.log('No task is active; nothing blocks this edit.');
      break;
    }
    if (pos[1] === 'done') {
      const { side_pass: _gone, ...rest } = st;
      writeJson(statePath(root, sessionId), rest);
      console.log('Side pass cleared.');
      break;
    }
    const files = sideFiles(flags.files);
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
    if (!reason) die('side needs --reason "why this edit is unrelated to the task".');
    const taskDir = st.task_dir;
    const manifest = readManifest(root, taskDir);
    if (!manifest) die(`no manifest.json in ${taskDir}`);
    requireAnswer('side', 'side', taskDir, manifest, { files, reason });
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    writeJson(statePath(root, sessionId), { ...(readSession(root, sessionId) || st), side_pass: { files, reason, expires_at: expires } });
    manifest.side_passes = [...(Array.isArray(manifest.side_passes) ? manifest.side_passes : []), { at: now(), session: sessionId, files, reason }];
    save(taskDir, manifest);
    console.log(`Side pass active for 30 minutes (until ${expires}): ${files.join(', ')}. Stage rules still apply to every other file, and guardrails still apply to these. End it with: stage.mjs side done`);
    break;
  }

  case 'explain': {
    if (!sessionId) die('no session id. Pass --session <id> or set SHIPLINE_SESSION.');
    explain(readDecision(root, sessionId));
    break;
  }

  case 'reopen': {
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    let idx = manifest.stages.findIndex((s) => s.id === pos[1]);
    if (idx < 0) idx = manifest.stages.findIndex((s) => sameStage(s.id, pos[1]));
    if (idx < 0) die(`unknown stage "${pos[1]}".`);
    manifest.stages.forEach((s, i) => {
      if (i > idx) {
        s.status = 'pending';
        delete s.reason;
        delete s.confirmed;
        delete s.skipped;
        delete s.accepted;
        delete s.scope_accepted;
      }
    });
    manifest.stages[idx].status = 'in_progress';
    delete manifest.stages[idx].reason;
    delete manifest.stages[idx].confirmed;
    delete manifest.stages[idx].skipped;
    delete manifest.stages[idx].accepted;
    delete manifest.stages[idx].scope_accepted;
    manifest.complete = false;
    save(taskDir, manifest);
    clearPending();
    console.log(`Reopened ${pos[1]}; later stages reset to pending.\n\n${describeCurrent(taskDir, manifest, wf)}`);
    break;
  }

  case 'flag': {
    if (pos[1] !== 'ui' || !['true', 'false'].includes(pos[2])) die('usage: flag ui true|false');
    const taskDir = activeTaskDir();
    const { manifest } = load(taskDir);
    manifest.flags.ui = pos[2] === 'true';
    save(taskDir, manifest);
    console.log(`ui = ${manifest.flags.ui}`);
    break;
  }

  case 'check': {
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    if (flags['expect-fail'] !== undefined) {
      expectFail(taskDir, manifest, wf);
      break;
    }
    const commands = configuredCommands();
    if (!commands.length) {
      manifest.checks = { fingerprint: fingerprint(root), ran_at: now(), results: [] };
      recordScope(taskDir, manifest, wf);
      save(taskDir, manifest);
      console.log('No test, lint or build commands are configured in .shipline/config.yml.');
      printScope(manifest.checks.scope, wf);
      break;
    }
    // The fingerprint is taken before the commands run; afterRun() replaces it if they changed any files.
    const fp = fingerprint(root);
    if (fp === null) console.log('Note: this is not a git repository (or git failed), so the checks cannot be tied to a version of the code.');
    const results = commands.map(([name, command]) => {
      console.log(`Running ${name}: ${command}`);
      return runCommand(name, command);
    });
    const post = afterRun(fp);
    manifest.checks = { fingerprint: post.fp, ran_at: now(), results };
    recordScope(taskDir, manifest, wf);
    save(taskDir, manifest);
    const failed = results.filter((r) => r.exit !== 0);
    console.log(`\n${checksLine(results)}`);
    printScope(manifest.checks.scope, wf);
    for (const r of failed) console.log(`\n--- ${r.name} (${r.exit === null ? 'did not run' : `exit ${r.exit}`}) last output ---\n${r.tail}`);
    if (post.note) console.log(`\n${post.note}`);
    console.log(`\nFingerprint: ${post.fp ? post.fp.slice(0, 12) : 'none'}`);
    const ffFacts = failFirstFacts(manifest);
    if (ffFacts) console.log(failFirstLine(ffFacts));
    if (failed.length) process.exit(1);
    break;
  }

  case 'pr-summary': {
    const taskDir = activeTaskDir(true);
    const { manifest, wf } = load(taskDir);
    const closes = cfg.tracker === 'github' && Number.isInteger(manifest.task.issue) ? `Closes #${manifest.task.issue}\n` : '';
    console.log(closes + prSummary(taskDir, manifest, wf));
    break;
  }

  case 'validate': {
    if (!pos[1]) die('usage: validate <folder with workflow.yml and rules/ | workflow .yml file | .shipline>');
    if (!validateReport(validationTargets(pos[1])).ok) process.exit(1);
    break;
  }

  case 'draft':
    draftCommand();
    break;

  default:
    console.log('usage: stage.mjs workflows [--shipped] | start | resume <task> | status [--all] | advance | skip | abandon [--reason ...] | side --files a,b --reason ... | side done | explain | reopen <stage> | flag ui true|false | check | pr-summary | validate <path> | draft --tmp | draft <id> --from <folder>');
    process.exit(cmd ? 1 : 0);
}

// `check --expect-fail [extra...]`: runs only commands.test (plus the validated extra words) and records a failing run
// as manifest.fail_first. Valid only at Reproduce of a workflow fail_first applies to.
function expectFail(taskDir, manifest, wf) {
  const cur = currentStage(manifest);
  if (!cur || ffLevel(cur.id, wf) === 'off') {
    die('check --expect-fail only applies at the Reproduce stage of a workflow listed in fail_first (and fail_first must not be off).');
  }
  const extras = expectFailExtras();
  const bad = extras.find((x) => !EXPECT_FAIL_ARG.test(x) || x.split('/').includes('..'));
  if (bad !== undefined) {
    console.error('shipline: check --expect-fail only accepts a test file or name made of letters, digits and _ . / : @ = , + - (no spaces, quotes, shell characters or ".." segments).');
    process.exit(2);
  }
  const test = configuredCommands().find(([n]) => n === 'test');
  if (!test) die('no test command is configured. Set commands.test in .shipline/config.yml.');
  const command = [test[1], ...extras].join(' ');
  const fp = fingerprint(root);
  console.log(`Running test: ${command}`);
  const r = runCommand('test', command);
  const post = afterRun(fp);
  if (r.exit === null) die(`the test command did not run:\n${r.tail}`);
  if (r.exit === 0) {
    console.log('The test passed, so it doesn\'t reproduce the bug: nothing recorded.');
    process.exit(1);
  }
  manifest.fail_first = { fingerprint: post.fp, ran_at: now(), command, exit: r.exit, tail: r.tail };
  save(taskDir, manifest);
  console.log(`${r.tail}\n\nFailing as expected (exit ${r.exit}): recorded.`);
  if (post.note) console.log(`\n${post.note}`);
}

// `side --files`: repo-relative paths, no globs, 1 to 10. Returns them sorted and deduplicated.
function sideFiles(raw) {
  if (typeof raw !== 'string' || !raw.trim()) die('side needs --files a.md,docs/b.md (repo-relative paths, 1 to 10).');
  const files = [...new Set(raw.split(',').map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))].sort();
  if (!files.length || files.length > 10) die('side takes 1 to 10 files.');
  for (const f of files) {
    if (/[*?[\]{}]/.test(f)) die(`side takes exact file paths, not globs: ${f}`);
    if (path.isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.split('/').includes('..')) die(`side takes paths inside the repo, relative to its root: ${f}`);
  }
  return files;
}

// `explain`: the last deny or ask this session got, and the way past it.
function explain(d) {
  if (!d) {
    console.log('No Shipline denial recorded for this session.');
    return;
  }
  const lines = [`${d.at}: ${d.decision === 'deny' ? 'denied' : 'asked about'} ${d.tool}${d.target ? ` on ${d.target}` : ''}.`, d.reason];
  if (d.kind === 'stage') {
    lines.push('', `Rule: the "${d.id}" stage of this task hasn't been finished.`, `Way past it: finish "${d.id}" and run stage.mjs advance.`);
    if (d.tool !== 'Bash' && d.target) lines.push(`If this edit is unrelated to the task: stage.mjs side --files ${d.target} --reason "..." (the developer confirms).`);
  } else if (d.kind === 'rail') {
    const level = cfg.rails && cfg.rails[d.id];
    lines.push('', `Rule: guardrail ${d.id}${level ? ` (currently ${level})` : ''}.`, `The developer can change it with rails.${d.id}: ask|off in .shipline/config.yml (or Setup, Guardrails).`);
  } else if (d.kind === 'protected') {
    lines.push('', `Rule: protected_paths entry ${d.id || '(unknown)'} in .shipline/config.yml.`, 'The developer approves or declines it when asked; remove the entry to stop the question.');
  } else {
    lines.push('', 'Rule: progress and approvals change only through stage.mjs and the developer\'s answers.');
  }
  console.log(lines.join('\n'));
}

function ageText(ms) {
  if (!ms) return 'age unknown';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : `${d}d ago`;
}

// `status --all`: every task in the store.
function listEverything() {
  let tasks;
  try {
    tasks = listAllTasks(root);
  } catch (e) {
    die(e.message);
  }
  tasks.sort((a, b) => b.newest - a.newest);
  if (flags.json) {
    console.log(JSON.stringify({ tasks: tasks.map((t) => ({ slug: t.slug, workflow: t.workflow, stage: t.next, branch: t.branch || null, state: t.state, last_activity: t.newest ? new Date(t.newest).toISOString() : null, task_dir: t.dir })) }, null, 2));
    return;
  }
  if (!tasks.length) {
    console.log('No tasks.');
    return;
  }
  for (const t of tasks) {
    console.log(`${t.slug} (${t.workflow}) stage: ${t.next || 'none'}, ${ageText(t.newest)}, branch: ${t.branch || 'none'}${t.state === 'open' ? '' : ` [${t.state}]`}`);
  }
}

function uiWork(manifest) {
  return manifest.flags.ui === true ? 'yes' : manifest.flags.ui === false ? 'no' : 'unknown';
}

function stageRows(manifest) {
  const mark = { done: '[x]', skipped: '[-]', in_progress: '[>]', pending: '[ ]' };
  return manifest.stages.map((s) => `${mark[s.status] || '[ ]'} ${s.id}${s.reason ? ` (${s.reason})` : ''}`);
}

function statusText(taskDir, manifest, wf) {
  return `Task ${taskDir} (${wf.id}) UI work: ${uiWork(manifest)}\n${stageRows(manifest).join('\n')}\n\n${describeCurrent(taskDir, manifest, wf)}`;
}

// The short status: the stage list, then the current stage's name, artifact, checks line and next step.
// --verbose adds the rules text and the full store paths (statusText).
function shortStatus(taskDir, manifest, wf) {
  const lines = [`Task ${manifest.task.slug} (${wf.id}) UI work: ${uiWork(manifest)}`, ...stageRows(manifest), ''];
  const cur = currentStage(manifest);
  if (!cur) return [...lines, 'All stages are done. The task is complete.'].join('\n');
  const sc = stageCfg(wf, cur.id);
  lines.push(`Current stage: ${sc.name || cur.id} [${cur.id}]`);
  if (sc.artifact) lines.push(`Artifact: ${sc.artifact}${existsSync(path.join(taskDir, sc.artifact)) ? '' : ' (not written yet)'}`);
  const ch = manifest.checks && Array.isArray(manifest.checks.results) ? manifest.checks : null;
  if (sc.checks === true) lines.push(`Checks: ${ch && ch.results.length ? checksLine(ch.results, acceptedNames(ch, cur)) : 'not run'}`);
  const asks = needsAnswer(sc, cfg) ? ' (it asks the developer to confirm)' : '';
  if (sc.checks === true && !(ch && ch.results.length)) lines.push('Next: node .shipline/bin/stage.mjs check');
  else if (sc.artifact && !existsSync(path.join(taskDir, sc.artifact))) lines.push(`Next: write ${sc.artifact}, then node .shipline/bin/stage.mjs advance${asks}`);
  else lines.push(`Next: node .shipline/bin/stage.mjs advance${asks}`);
  lines.push('(--verbose adds the stage rules and full paths)');
  return lines.join('\n');
}

// `status` with no session: the unfinished tasks whose branch is the current one (all of them outside git).
function listBranchTasks() {
  const branch = currentBranch(root);
  let tasks;
  try {
    tasks = listOpenTasks(root);
  } catch (e) {
    die(e.message);
  }
  if (branch && branch !== 'HEAD') tasks = tasks.filter((t) => t.branch === branch);
  if (flags.json) {
    console.log(JSON.stringify({ branch: branch || null, tasks: tasks.map((t) => ({ slug: t.slug, workflow: t.workflow, stage: t.next, task_dir: t.dir })) }, null, 2));
    return;
  }
  if (!tasks.length) {
    console.log(branch && branch !== 'HEAD' ? `No unfinished tasks on ${branch}.` : 'No unfinished tasks.');
    return;
  }
  console.log(`Unfinished tasks${branch && branch !== 'HEAD' ? ` on ${branch}` : ''}:`);
  for (const t of tasks) console.log(`  ${t.slug} (${t.workflow}) - current stage: ${t.next || 'none'}`);
  console.log('\nTo continue one, start Claude Code in this repo and run: node .shipline/bin/stage.mjs resume <slug>');
}

// How a finished stage was decided: 'answer' (the developer's own answer), 'auto' (no question was needed), or null.
function provenance(ms, sc) {
  if (ms.status === 'done' && ms.approved_by === 'non_interactive') return 'non_interactive';
  if (ms.status === 'done') return ms.confirmed && ms.confirmed.via === 'answer' ? 'answer' : needsAnswer(sc, cfg) ? null : 'auto';
  if (ms.status === 'skipped') return ms.skipped ? (ms.skipped.via === 'answer' ? 'answer' : 'auto') : 'auto';
  return null;
}

// ---------- checks ----------

// [[name, command]] for the configured, non-empty commands, in the order test, lint, build.
function configuredCommands() {
  const c = cfg.commands && typeof cfg.commands === 'object' ? cfg.commands : {};
  return ['test', 'lint', 'build'].filter((n) => typeof c[n] === 'string' && c[n].trim()).map((n) => [n, c[n].trim()]);
}

// The last 40 lines of the output, at most 4 KB.
function tailOf(text) {
  let t = String(text).replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n').slice(-40).join('\n');
  const buf = Buffer.from(t, 'utf8');
  if (buf.length > 4096) t = buf.subarray(buf.length - 4096).toString('utf8').replace(/^�+/, '');
  return t;
}

// Runs one command through the system shell in the repo root. exit is null when it did not start (or was killed).
function runCommand(name, command) {
  const t0 = Date.now();
  const r = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env });
  const duration_ms = Date.now() - t0;
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error) return { name, command, exit: null, duration_ms, tail: tailOf(output || r.error.message) };
  return { name, command, exit: typeof r.status === 'number' ? r.status : null, duration_ms, tail: tailOf(output || (r.signal ? `killed by ${r.signal}` : '')) };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// `test ✓ 41.9s · lint ✗ (exit 1) · build ✓ 12.0s`. accepted: names whose failure the developer accepted.
function checksLine(results, accepted = []) {
  return results
    .map((r) => {
      if (r.exit === 0) return `${r.name} ✓ ${seconds(r.duration_ms)}`;
      if (accepted.includes(r.name)) return `${r.name} ✗ (accepted)`;
      return `${r.name} ✗ (${r.exit === null ? 'did not run' : `exit ${r.exit}`})`;
    })
    .join(' · ');
}

// Names of the failed commands whose failure the stage's stored acceptance covers (it holds only for that run).
function acceptedNames(checks, stage) {
  const a = stage && stage.accepted;
  if (!checks || !a || a.fingerprint !== checks.fingerprint || a.ran_at !== checks.ran_at || !Array.isArray(a.names)) return [];
  return a.names;
}

// The gate on a `checks: true` stage: a recorded run, on the current code, with every result passed or accepted,
// and the scope of the change accepted when it edits test, lint or CI files or files outside the plan.
function gateChecks(taskDir, manifest, cur) {
  const ch = manifest.checks;
  if (configuredCommands().length) {
    if (!ch || !Array.isArray(ch.results) || !ch.results.length) die(`stage "${cur.id}" needs a check run. Run \`node .shipline/bin/stage.mjs check\` first.`);
    if (ch.fingerprint) {
      const current = fingerprint(root);
      if (current && current !== ch.fingerprint) die('The code changed since the last check run. Run `stage.mjs check` again.');
    }
    const failed = ch.results.filter((r) => r.exit !== 0).map((r) => r.name);
    if (failed.length && !acceptedNames(ch, cur).length) {
      // Accepting comes before any other question: a session has one pending confirmation at a time.
      requireAnswer('accept', cur.id, taskDir, manifest, { names: failed, fingerprint: ch.fingerprint, ran_at: ch.ran_at });
      cur.accepted = { names: failed, fingerprint: ch.fingerprint, ran_at: ch.ran_at };
      // Saved now: if another question follows, the acceptance has to survive until the developer answers it.
      save(taskDir, manifest);
    }
  }
  // Then the scope, before the advance question.
  const sc = ch && ch.scope;
  if (cfg.scope_check.enabled && sc && sc.changed !== null && !scopeAccepted(ch, cur)) {
    const sensitive = sc.sensitive.length;
    const outside = sc.outside_plan ? sc.outside_plan.length : 0;
    if (sensitive || outside) {
      requireAnswer('scope', cur.id, taskDir, manifest, { sensitive, outside, fingerprint: ch.fingerprint, ran_at: ch.ran_at });
      cur.scope_accepted = { fingerprint: ch.fingerprint, ran_at: ch.ran_at };
      save(taskDir, manifest);
    }
  }
}

// Has the developer accepted the scope of the run in `checks`? The acceptance holds only for that run.
function scopeAccepted(checks, stage) {
  const a = stage && stage.scope_accepted;
  return Boolean(checks && a && a.fingerprint === checks.fingerprint && a.ran_at === checks.ran_at);
}

// The stage whose artifact is the plan: the one whose `sections` include "Files to touch", else the `plan` stage.
function planStage(wf) {
  return wf.stages.find((st) => st.artifact && sections(st).some((h) => h.trim().replace(/:+$/, '').trim().toLowerCase() === 'files to touch')) || wf.stages.find((st) => st.id === 'plan' && st.artifact);
}

function hasPlanStage(wf) {
  return Boolean(planStage(wf));
}

// The text of the plan: the artifact of the stage whose `sections` include "Files to touch" (else the `plan` stage).
function planText(taskDir, wf) {
  const sc = planStage(wf);
  if (!sc) return null;
  try {
    return readFileSync(path.join(taskDir, sc.artifact), 'utf8');
  } catch {
    return null;
  }
}

// Computes the scope of the change and stores it in manifest.checks.scope (nothing with scope_check.enabled: false).
function recordScope(taskDir, manifest, wf) {
  if (!cfg.scope_check.enabled) return;
  try {
    manifest.checks.scope = scopeOf(root, manifest, planText(taskDir, wf), cfg);
  } catch (e) {
    manifest.checks.scope = { changed: null, sensitive: [], outside_plan: null, note: `unknown (${e.message})` };
  }
}

function printScope(sc, wf) {
  if (!sc) return;
  console.log(`Scope: ${scopeText(sc, cfg, hasPlanStage(wf))}`);
  if (sc.changed === null) return;
  if (sc.sensitive.length) console.log(`  Test, lint and CI files edited:\n${sc.sensitive.map((f) => `    ${f}`).join('\n')}`);
  if (sc.outside_plan && sc.outside_plan.length) console.log(`  Files outside the plan's "Files to touch":\n${sc.outside_plan.map((f) => `    ${f}`).join('\n')}`);
}

// The PR description block: a visible table, then the hidden data that .shipline/bin/ci-check.mjs reads.
// The text under `heading` in the artifact of the stage whose `sections` include it, or null.
function sectionBlock(taskDir, wf, heading) {
  const limit = 3000;
  const want = heading.toLowerCase();
  const sc = wf.stages.find((st) => sections(st).some((h) => h.trim().replace(/:+$/, '').trim().toLowerCase() === want) && st.artifact);
  if (!sc) return null;
  let md;
  try {
    md = readFileSync(path.join(taskDir, sc.artifact), 'utf8');
  } catch {
    return null;
  }
  const sec = findSection(md, heading);
  if (!sec.found || !sec.text) return null;
  return sec.text.length > limit ? `${sec.text.slice(0, limit)}\n\n…(truncated)` : sec.text;
}

function prSummary(taskDir, manifest, wf) {
  const label = { answer: 'your answer', auto: 'auto', non_interactive: 'auto (non-interactive)' };
  const rows = [];
  const data = [];
  for (const ms of manifest.stages) {
    const sc = stageCfg(wf, ms.id);
    const status = ms.status === 'done' || ms.status === 'skipped' ? ms.status : 'pending';
    const confirmed = provenance(ms, sc);
    rows.push(`| ${ms.id} | ${status} | ${label[confirmed] || '—'} |`);
    data.push({ id: ms.id, status, enforcement: stageEnforcement(sc), confirmed });
  }
  const out = ['### Shipline', '| Stage | Status | Confirmed |', '| --- | --- | --- |', ...rows];
  const json = { v: 2, workflow: wf.id, task: manifest.task.slug, stages: data };
  const headless = data.filter((d) => d.confirmed === 'non_interactive');
  if (headless.length) out.push('', `Advanced without a developer answer (non-interactive, checks passed): ${headless.map((d) => d.id).join(', ')}`);

  const checkStage = wf.stages.find((st) => st.checks === true);
  if (checkStage) {
    const ms = manifest.stages.find((m) => sameStage(m.id, checkStage.id));
    const ch = manifest.checks && Array.isArray(manifest.checks.results) ? manifest.checks : null;
    const accepted = ch ? acceptedNames(ch, ms) : [];
    if (ch && ch.results.length) {
      // Out of date only when both fingerprints are known and differ (as in the gate and the UI).
      const current = ch.fingerprint ? fingerprint(root) : null;
      const stale = Boolean(ch.fingerprint && current && current !== ch.fingerprint);
      out.push('', `**Checks:** ${checksLine(ch.results, accepted)}${stale ? ' (out of date)' : ''}`);
      json.checks = {
        fingerprint: ch.fingerprint || null,
        results: ch.results.map((r) => ({ name: r.name, exit: r.exit, duration_ms: r.duration_ms, accepted: r.exit !== 0 && accepted.includes(r.name) })),
      };
    } else if (!configuredCommands().length) {
      out.push('', '**Checks:** no commands configured');
      json.checks = { fingerprint: null, results: [] };
    } else {
      out.push('', '**Checks:** not run');
    }
    const ffFacts = failFirstFacts(manifest);
    if (ffFacts) {
      out.push('', `**${failFirstLine(ffFacts).replace(/^Fail-first:/, 'Fail-first:**')}`);
      json.fail_first = ffFacts;
    }
    const sc = cfg.scope_check.enabled && ch && ch.scope && Array.isArray(ch.scope.sensitive) ? ch.scope : null;
    if (sc) {
      const ok = scopeAccepted(ch, ms);
      const any = sc.sensitive.length || (sc.outside_plan && sc.outside_plan.length);
      out.push('', `**Scope:** ${any ? `edits ${scopeText(sc, cfg, hasPlanStage(wf))}${ok ? ' (accepted)' : ''}` : scopeText(sc, cfg, hasPlanStage(wf))}`);
      if (sc.sensitive.length) out.push('', '<details><summary>Test, lint and CI files edited</summary>', '', ...sc.sensitive.map((f) => `- \`${f}\``), '', '</details>');
      if (sc.outside_plan && sc.outside_plan.length) out.push('', '<details><summary>Files outside the plan</summary>', '', ...sc.outside_plan.map((f) => `- \`${f}\``), '', '</details>');
      json.scope = { sensitive: sc.sensitive, outside_plan: sc.outside_plan, accepted: Boolean(any && ok) };
    }
  }

  for (const [heading, title] of [['Scope', 'Plan scope'], ['Checklist', 'Verification checklist']]) {
    const text = sectionBlock(taskDir, wf, heading);
    if (text) out.push('', `<details><summary>${title}</summary>`, '', text, '', '</details>');
  }
  out.push(`<!-- shipline:summary ${JSON.stringify(json)} -->`);
  return out.join('\n');
}
