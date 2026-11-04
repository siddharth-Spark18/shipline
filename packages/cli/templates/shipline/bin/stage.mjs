#!/usr/bin/env node
// Stage CLI that Claude calls through Bash to record workflow progress.
//   node .shipline/bin/stage.mjs workflows
//   node .shipline/bin/stage.mjs start --workflow feature --title "Add export" [--ticket PROJ-12] [--ui true|false]
//   node .shipline/bin/stage.mjs resume <task folder name or absolute path>
//   node .shipline/bin/stage.mjs status [--json]
//   node .shipline/bin/stage.mjs advance [--confirmed]
//   node .shipline/bin/stage.mjs skip [--reason "..."] [--force]
//   node .shipline/bin/stage.mjs reopen <stage>
//   node .shipline/bin/stage.mjs flag ui true|false
// Session: $SHIPLINE_SESSION (set by the SessionStart hook) or --session <id>. Task override: --task <folder>.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  findRoot, loadConfig, loadWorkflow, listWorkflows, readManifest, manifestPath, readSession, statePath,
  tasksDir, writeJson, isDone, currentStage, slugify, stageEnforcement,
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
    `Enforcement: ${stageEnforcement(sc)}. Confirm with the developer before advancing: ${sc.confirm_to_advance ? 'YES (pass --confirmed after they agree)' : 'no (auto-advance)'}`,
  ].filter(Boolean);
  if (Array.isArray(cfg.skills) && cfg.skills.length) lines.push(`Repo skills you can use: ${cfg.skills.join(', ')}`);
  const rules = rulesFor(cur.id);
  if (rules) lines.push('', `Repo rules for this stage (.shipline/rules/${cur.id}.md):`, rules);
  return lines.join('\n');
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
    else console.log(statusText(taskDir, manifest, wf));
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
      if (sc.confirm_to_advance && !flags.confirmed) {
        die(`stage "${cur.id}" needs the developer's confirmation to advance. Ask them, then re-run with --confirmed.`);
      }
      if (sc.artifact && !flags.force && !existsSync(path.join(taskDir, sc.artifact))) {
        die(`stage "${cur.id}" is not finished: ${taskDir}/${sc.artifact} does not exist yet.`);
      }
      cur.status = 'done';
    } else {
      if (!sc.optional && !sc.condition && !flags.force) die(`stage "${cur.id}" is not optional. Use --force only if the developer agreed.`);
      cur.status = 'skipped';
      cur.reason = typeof flags.reason === 'string' ? flags.reason : 'skipped';
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
      }
    });
    manifest.stages[idx].status = 'in_progress';
    delete manifest.stages[idx].reason;
    manifest.complete = false;
    save(taskDir, manifest);
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

  default:
    console.log('usage: stage.mjs workflows | start | resume <task> | status | advance [--confirmed] | skip | reopen <stage> | flag ui true|false');
    process.exit(cmd ? 1 : 0);
}

function statusText(taskDir, manifest, wf) {
  const mark = { done: '[x]', skipped: '[-]', in_progress: '[>]', pending: '[ ]' };
  const rows = manifest.stages.map((s) => `${mark[s.status] || '[ ]'} ${s.id}${s.reason ? ` (${s.reason})` : ''}`);
  return `Task ${taskDir} (${wf.id}) ui=${manifest.flags.ui}\n${rows.join('\n')}\n\n${describeCurrent(taskDir, manifest, wf)}`;
}
