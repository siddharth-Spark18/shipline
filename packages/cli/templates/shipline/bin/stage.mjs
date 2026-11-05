#!/usr/bin/env node
// Stage CLI that Claude calls through Bash to record workflow progress.
//   node .shipline/bin/stage.mjs workflows
//   node .shipline/bin/stage.mjs start --workflow feature --title "Add export" [--ticket PROJ-12] [--ui true|false]
//   node .shipline/bin/stage.mjs resume <task folder name or absolute path>
//   node .shipline/bin/stage.mjs status [--json]
//   node .shipline/bin/stage.mjs advance
//   node .shipline/bin/stage.mjs skip [--reason "..."]
//   node .shipline/bin/stage.mjs reopen <stage>
//   node .shipline/bin/stage.mjs flag ui true|false
//   node .shipline/bin/stage.mjs pr-summary
// A confirm_to_advance stage (and skipping a non-optional stage) needs the developer's own answer to the
// question that `advance` / `skip` prints; there are no override flags.
// Session: $SHIPLINE_SESSION (set by the SessionStart hook) or --session <id>. Task override: --task <folder>.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  findRoot, loadConfig, loadWorkflow, listWorkflows, readManifest, manifestPath, readSession, statePath,
  tasksDir, writeJson, isDone, currentStage, slugify, stageEnforcement, confirmQuestion, readApprovals,
  consumeApproval, CONFIRM_OPTIONS,
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

function stageCfg(wf, id) {
  return wf.stages.find((s) => s.id === id) || { id };
}

function rulesFor(id) {
  const f = path.join(root, '.shipline', 'rules', `${id}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

function describeCurrent(taskDir, manifest, wf) {
  const cur = currentStage(manifest);
  if (!cur) return 'All stages are done. The task is complete.';
  const sc = stageCfg(wf, cur.id);
  const lines = [
    `Current stage: ${sc.name || cur.id} [${cur.id}]`,
    sc.artifact ? `Artifact to produce: ${taskDir}/${sc.artifact}` : 'No required artifact.',
    sc.agent ? `Suggested agent: ${sc.agent}` : null,
    `Enforcement: ${stageEnforcement(sc)}. Confirm with the developer before advancing: ${sc.confirm_to_advance ? 'YES (`advance` prints the question to ask them; it only goes through after they answer it)' : 'no (auto-advance)'}`,
  ].filter(Boolean);
  if (Array.isArray(cfg.skills) && cfg.skills.length) lines.push(`Repo skills you can use: ${cfg.skills.join(', ')}`);
  const rules = rulesFor(cur.id);
  if (rules) lines.push('', `Repo rules for this stage (.shipline/rules/${cur.id}.md):`, rules);
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
function requireAnswer(kind, stageId, taskDir, manifest) {
  const verb = kind === 'advance' ? 'confirm advancing' : 'confirm skipping';
  if (!sessionId) die(`no session id; confirmations need the session that asked the question. Pass --session <id> or set SHIPLINE_SESSION.`);
  const q = confirmQuestion(stageId, kind, manifest.task.slug);
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

// Moves to the next stage that applies; marks conditional stages that do not apply as skipped.
function activateNext(manifest, wf) {
  for (const ms of manifest.stages) {
    if (isDone(ms.status)) continue;
    const sc = stageCfg(wf, ms.id);
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
    const key = typeof flags.ticket === 'string' ? flags.ticket.toUpperCase() : '';
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
        workflow: wf.id,
        branch: fill(cfg.branch_pattern, vars),
        created: now(),
        updated: now(),
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
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    if (flags.json) console.log(JSON.stringify({ task_dir: taskDir, ...manifest }, null, 2));
    else {
      console.log(statusText(taskDir, manifest, wf));
      // A confirmation question that is still open (for example after resuming in a new session) is printed again.
      const cur = currentStage(manifest);
      const st = sessionId ? readSession(root, sessionId) : null;
      const pend = st && st.pending_confirm;
      if (cur && pend && pend.stage === cur.id && pend.task_dir === taskDir) {
        console.log(`\nA confirmation is still open (run \`${pend.kind}\` after the developer answers).\n${questionText(confirmQuestion(cur.id, pend.kind, manifest.task.slug))}`);
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
      if (sc.confirm_to_advance) {
        const a = requireAnswer('advance', cur.id, taskDir, manifest);
        cur.confirmed = { via: 'answer', at: a.at };
      } else clearPending();
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
    const idx = manifest.stages.findIndex((s) => s.id === pos[1]);
    if (idx < 0) die(`unknown stage "${pos[1]}".`);
    manifest.stages.forEach((s, i) => {
      if (i > idx) {
        s.status = 'pending';
        delete s.reason;
        delete s.confirmed;
        delete s.skipped;
      }
    });
    manifest.stages[idx].status = 'in_progress';
    delete manifest.stages[idx].reason;
    delete manifest.stages[idx].confirmed;
    delete manifest.stages[idx].skipped;
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

  case 'pr-summary': {
    const taskDir = activeTaskDir();
    const { manifest, wf } = load(taskDir);
    console.log(prSummary(manifest, wf));
    break;
  }

  default:
    console.log('usage: stage.mjs workflows | start | resume <task> | status | advance | skip | reopen <stage> | flag ui true|false | pr-summary');
    process.exit(cmd ? 1 : 0);
}

function statusText(taskDir, manifest, wf) {
  const mark = { done: '[x]', skipped: '[-]', in_progress: '[>]', pending: '[ ]' };
  const rows = manifest.stages.map((s) => `${mark[s.status] || '[ ]'} ${s.id}${s.reason ? ` (${s.reason})` : ''}`);
  return `Task ${taskDir} (${wf.id}) ui=${manifest.flags.ui}\n${rows.join('\n')}\n\n${describeCurrent(taskDir, manifest, wf)}`;
}

// How a finished stage was decided: 'answer' (the developer's own answer), 'auto' (no question was needed), or null.
function provenance(ms, sc) {
  if (ms.status === 'done') return ms.confirmed && ms.confirmed.via === 'answer' ? 'answer' : sc.confirm_to_advance ? null : 'auto';
  if (ms.status === 'skipped') return ms.skipped ? (ms.skipped.via === 'answer' ? 'answer' : 'auto') : 'auto';
  return null;
}

// The PR description block: a visible table, then the hidden data that .shipline/bin/ci-check.mjs reads.
function prSummary(manifest, wf) {
  const label = { answer: 'your answer', auto: 'auto' };
  const rows = [];
  const data = [];
  for (const ms of manifest.stages) {
    const sc = stageCfg(wf, ms.id);
    const status = ms.status === 'done' || ms.status === 'skipped' ? ms.status : 'pending';
    const confirmed = provenance(ms, sc);
    rows.push(`| ${ms.id} | ${status} | ${label[confirmed] || '\u2014'} |`);
    data.push({ id: ms.id, status, enforcement: stageEnforcement(sc), confirmed });
  }
  const json = JSON.stringify({ v: 1, workflow: wf.id, task: manifest.task.slug, stages: data });
  return ['### Shipline', '| Stage | Status | Confirmed |', '| --- | --- | --- |', ...rows, `<!-- shipline:summary ${json} -->`].join('\n');
}
