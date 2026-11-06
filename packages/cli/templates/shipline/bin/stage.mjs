#!/usr/bin/env node
// Stage CLI that Claude calls through Bash to record workflow progress.
//   node .shipline/bin/stage.mjs workflows
//   node .shipline/bin/stage.mjs start --workflow feature --title "Add export" [--ticket PROJ-12 | 123] [--ui true|false]
//   node .shipline/bin/stage.mjs resume <task folder name or absolute path>
//   node .shipline/bin/stage.mjs status [--json] [--verbose]   (without a session: the unfinished tasks on this branch)
//   node .shipline/bin/stage.mjs advance
//   node .shipline/bin/stage.mjs skip [--reason "..."]
//   node .shipline/bin/stage.mjs reopen <stage>
//   node .shipline/bin/stage.mjs flag ui true|false
//   node .shipline/bin/stage.mjs check
//   node .shipline/bin/stage.mjs pr-summary
// A confirm_to_advance stage (and skipping a non-optional stage) needs the developer's own answer to the
// question that `advance` / `skip` prints; there are no override flags.
// `check` runs the test, lint and build commands from config.yml and records the results in the manifest; a stage
// with `checks: true` (verify) can't finish without a passing run on the current code, unless the developer accepts.
// `check` also records the scope of the change (test, lint and CI files it edits, files outside the plan); when
// there is any, finishing that stage needs the developer's answer to a `scope` question too.
// Session: $SHIPLINE_SESSION (set by the SessionStart hook) or --session <id>. Task override: --task <folder>.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  findRoot, loadConfig, needsAnswer, loadWorkflow, listWorkflows, readManifest, manifestPath, readSession, statePath,
  tasksDir, writeJson, isDone, currentStage, slugify, stageEnforcement, confirmQuestion, readApprovals,
  consumeApproval, CONFIRM_OPTIONS, sameStage, findStage, fingerprint, findSection, sectionProblems, scopeOf, scopeText,
  listOpenTasks, currentBranch,
} from './lib.mjs';

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

function activeTaskDir() {
  if (typeof flags.task === 'string') return resolveTask(flags.task);
  if (!sessionId) die('no session id. Pass --session <id> (it is in the SessionStart context) or set SHIPLINE_SESSION.');
  const s = readSession(root, sessionId);
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
  writeJson(statePath(root, sessionId), { session_id: sessionId, workflow, task_dir: taskDir, started: now() });
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
    kind === 'advance' ? 'confirm advancing' : kind === 'accept' ? 'decide whether to finish with failed checks' : kind === 'scope' ? 'decide whether to finish with edits to test, lint or CI files or files outside the plan' : 'confirm skipping';
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
      `Then run \`${cmd}\` again. Do not pass any flag or edit any progress file to get around this.`,
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

switch (cmd) {
  case 'workflows': {
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
    const slug = slugify(flags.slug || flags.title);
    if (!flags.slug && !flags.title) die('--title (or --slug) is required.');
    const vars = { key, slug, type: typeof flags.type === 'string' ? flags.type : wf.branch_type || wf.id };
    const taskDir = path.join(tasksBase, key ? `${key}-${slug}` : slug);
    if (existsSync(manifestPath(root, taskDir))) die(`${taskDir} already exists. Use: resume ${taskDir}`);
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
    console.log(`Started ${wf.name || wf.id} task in ${taskDir}\nSuggested branch: ${manifest.task.branch}\n\n${describeCurrent(taskDir, manifest, wf)}`);
    break;
  }

  case 'resume': {
    if (!pos[1]) die('usage: resume <task folder name or absolute path>');
    const taskDir = resolveTask(pos[1]);
    const { manifest, wf } = load(taskDir);
    bind(taskDir, wf.id);
    console.log(`Resumed ${taskDir} (${wf.id} workflow).\nSuggested branch: ${manifest.task.branch}\n\n${statusText(taskDir, manifest, wf)}`);
    break;
  }

  case 'status': {
    // No session and no --task: say which unfinished tasks belong to this branch instead of failing.
    if (typeof flags.task !== 'string' && !sessionId) {
      listBranchTasks();
      break;
    }
    const taskDir = activeTaskDir();
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
        if (wanted.length) {
          const problems = sectionProblems(readFileSync(path.join(taskDir, sc.artifact), 'utf8'), wanted);
          if (problems.length) die(`${sc.artifact} is missing: ${problems.join(', ')}.`);
        }
      }
      if (sc.checks === true) gateChecks(taskDir, manifest, cur);
      if (needsAnswer(sc, cfg)) {
        const a = requireAnswer('advance', cur.id, taskDir, manifest);
        cur.confirmed = { via: 'answer', at: a.at };
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
    const commands = configuredCommands();
    if (!commands.length) {
      manifest.checks = { fingerprint: fingerprint(root), ran_at: now(), results: [] };
      recordScope(taskDir, manifest, wf);
      save(taskDir, manifest);
      console.log('No test, lint or build commands are configured in .shipline/config.yml.');
      printScope(manifest.checks.scope, wf);
      break;
    }
    // The fingerprint is taken before the commands run: it is the code they saw.
    const fp = fingerprint(root);
    if (fp === null) console.log('Note: this is not a git repository (or git failed), so the checks cannot be tied to a version of the code.');
    const results = commands.map(([name, command]) => {
      console.log(`Running ${name}: ${command}`);
      return runCommand(name, command);
    });
    manifest.checks = { fingerprint: fp, ran_at: now(), results };
    recordScope(taskDir, manifest, wf);
    save(taskDir, manifest);
    const failed = results.filter((r) => r.exit !== 0);
    console.log(`\n${checksLine(results)}`);
    printScope(manifest.checks.scope, wf);
    for (const r of failed) console.log(`\n--- ${r.name} (${r.exit === null ? 'did not run' : `exit ${r.exit}`}) last output ---\n${r.tail}`);
    console.log(`\nFingerprint: ${fp ? fp.slice(0, 12) : 'none'}`);
    if (failed.length) process.exit(1);
    break;
  }

  case 'pr-summary': {
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    const closes = cfg.tracker === 'github' && Number.isInteger(manifest.task.issue) ? `Closes #${manifest.task.issue}\n` : '';
    console.log(closes + prSummary(taskDir, manifest, wf));
    break;
  }

  default:
    console.log('usage: stage.mjs workflows | start | resume <task> | status | advance | skip | reopen <stage> | flag ui true|false | check | pr-summary');
    process.exit(cmd ? 1 : 0);
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
  const label = { answer: 'your answer', auto: 'auto' };
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
