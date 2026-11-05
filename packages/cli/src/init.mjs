import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectEol, isInside, parseYaml, toEol } from '../templates/shipline/bin/lib.mjs';
import { INTERFACE } from './interface.mjs';
import {
  CI_WORKFLOW, CI_WORKFLOW_TEMPLATE, CLAUDE_MD_KEY, HOOK_MARK, PACKAGE_VERSION, SETTINGS_KEY, START, VERSION_FILE,
  TEMPLATES, canonicalSettingsPart, claudeMdBlock, claudeMdSection, isShiplineHookEntry, ownedTemplateFiles, sha256,
  templateFiles, templateSettings,
} from './hashes.mjs';
import { detectCommands } from './detect-commands.mjs';
import { TRACKERS, configLayout } from './setup-schema.mjs';
import { storeDir } from './store.mjs';
import { emitConfig } from './yaml-emit.mjs';

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// Parses and checks .claude/settings.json (text may be null or empty).
export function parseSettings(existingText) {
  let settings = {};
  if (existingText !== null && existingText.trim() !== '') {
    try {
      settings = JSON.parse(existingText);
    } catch (e) {
      throw new Error(`.claude/settings.json is not valid JSON (${e.message}). Fix it first; nothing was written.`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('.claude/settings.json is not a JSON object; nothing was written.');
    }
  }
  if (settings.hooks === undefined) settings.hooks = {};
  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error('.claude/settings.json has a "hooks" value that is not an object; nothing was written.');
  }
  if (settings.permissions !== undefined && (settings.permissions === null || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
    throw new Error('.claude/settings.json has a "permissions" value that is not an object; nothing was written.');
  }
  if (settings.permissions && settings.permissions.allow !== undefined && !Array.isArray(settings.permissions.allow)) {
    throw new Error('.claude/settings.json permissions.allow is not an array; nothing was written.');
  }
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) {
      throw new Error(`.claude/settings.json hooks.${event} is not an array; nothing was written.`);
    }
  }
  return settings;
}

// Adds Shipline's hook entries and allow rules to the parsed settings. With replace: true (upgrade),
// Shipline's existing hook entries are swapped for the template's in place; without it they are appended.
// Other entries and existing allow rules are left alone, and no rule is added twice.
export function mergeSettingsObject(settings, template, { replace = false } = {}) {
  for (const [event, entries] of Object.entries(template.hooks)) {
    const current = settings.hooks[event] === undefined ? [] : settings.hooks[event];
    if (!Array.isArray(current)) {
      throw new Error(`.claude/settings.json hooks.${event} is not an array; nothing was written.`);
    }
    if (replace && current.some(isShiplineHookEntry)) {
      const next = [];
      let placed = false;
      for (const e of current) {
        if (!isShiplineHookEntry(e)) next.push(e);
        else if (!placed) {
          next.push(...entries);
          placed = true;
        }
      }
      settings.hooks[event] = next;
    } else {
      settings.hooks[event] = [...current, ...entries];
    }
  }
  const rules = (template.permissions && template.permissions.allow) || [];
  if (rules.length) {
    if (!settings.permissions) settings.permissions = {};
    const allow = settings.permissions.allow || [];
    settings.permissions.allow = [...allow, ...rules.filter((r) => !allow.includes(r))];
  }
  return settings;
}

function mergeSettings(existingText, template) {
  return JSON.stringify(mergeSettingsObject(parseSettings(existingText), template), null, 2) + '\n';
}

function hasShiplineHooks(settingsText) {
  return settingsText !== null && settingsText.includes(HOOK_MARK);
}

// ---------- what can be chosen ----------

const AGENT_PATH = (name) => `.claude/agents/${name}.md`;
const ID_RE = /^[A-Za-z0-9_-]+$/;

// Names of the *.md files / folders directly under dir (empty when it doesn't exist).
function listNames(dir, { dirs = false } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (dirs ? e.isDirectory() : e.isFile() && e.name.endsWith('.md')))
    .map((e) => (dirs ? e.name : e.name.slice(0, -3)))
    .filter((n) => ID_RE.test(n))
    .sort();
}

// The workflows Shipline ships: [{ id, name, description, stages: [{ id, name, agent }] }], from the templates.
export function shippedWorkflows() {
  const dir = path.join(TEMPLATES, 'shipline', 'workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => {
      const wf = parseYaml(readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: wf.id,
        name: wf.name || wf.id,
        description: wf.description || '',
        stages: wf.stages.map((st) => ({ id: st.id, name: st.name || st.id, agent: st.agent || null })),
      };
    });
}

// The default order of Shipline's agents.
const AGENT_ORDER = ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher'];
export function shippedAgents() {
  const names = listNames(path.join(TEMPLATES, 'claude', 'agents'));
  return [...AGENT_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !AGENT_ORDER.includes(n))];
}

// What happens to a Shipline agent whose name the repo already uses: 'keep' (the default), 'ours' or 'skip'.
// null when there is no clash.
const clashOf = (info, selection, name) => (info.repoAgents.includes(name) ? (selection.clashes || {})[name] || 'keep' : null);

// Agents that will be present (Shipline's chosen ones, kept clashes included) once the selection is applied.
// A "skip" clash and a deselected agent count as missing.
function presentAgents(selection) {
  return new Set(selection.agents.filter((n) => (selection.clashes || {})[n] !== 'skip'));
}

// Stages of the chosen workflows whose suggested agent is not present: [{ key: '<wf>.<stage>', workflow, stage, agent }].
export function missingStageAgents(workflows, selection) {
  const present = presentAgents(selection);
  const out = [];
  for (const wf of workflows) {
    if (!selection.workflows.includes(wf.id)) continue;
    for (const st of wf.stages) {
      if (st.agent && !present.has(st.agent)) out.push({ key: `${wf.id}.${st.id}`, workflow: wf.id, stage: st.id, agent: st.agent });
    }
  }
  return out;
}

// What --yes does: every workflow and agent, "keep yours" on every clash, stage agents left alone (or removed
// when missing, which cannot happen with every agent installed), no repo skills.
function defaultSelection(info) {
  return {
    workflows: info.workflows.map((w) => w.id),
    agents: [...info.agents],
    clashes: Object.fromEntries(info.agents.filter((a) => info.repoAgents.includes(a)).map((a) => [a, 'keep'])),
    stageAgents: {},
    skills: [],
    commands: pickCommands(info.detected),
    tracker: 'jira',
    ci: false,
  };
}

const COMMAND_KEYS = ['test', 'lint', 'build'];
const pickCommands = (detected) => Object.fromEntries(COMMAND_KEYS.map((k) => [k, (detected && detected[k]) || '']));

// 'github' when `origin` points at github.com, otherwise 'jira' (also with no remote or no git).
function trackerDefault(root) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return url.includes('github.com') ? 'github' : 'jira';
  } catch {
    return 'jira';
  }
}

function checkSelection(info, sel) {
  const fail = (m) => {
    throw new Error(`invalid selection: ${m}`);
  };
  if (!sel || typeof sel !== 'object') fail('not an object');
  if (!Array.isArray(sel.workflows) || sel.workflows.length === 0) fail('choose at least one workflow');
  if (sel.workflows.some((id) => !info.workflows.some((w) => w.id === id))) fail('unknown workflow');
  if (!Array.isArray(sel.agents) || sel.agents.some((a) => !info.agents.includes(a))) fail('unknown agent');
  for (const [name, c] of Object.entries(sel.clashes || {})) if (!['keep', 'ours', 'skip'].includes(c)) fail(`clash "${name}" must be keep, ours or skip`);
  if (sel.ci !== undefined && typeof sel.ci !== 'boolean') fail('ci must be true or false');
  if (sel.tracker !== undefined && !TRACKERS.includes(sel.tracker)) fail(`tracker must be ${TRACKERS.join(' or ')}`);
  if (sel.commands !== undefined) {
    const c = sel.commands;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !COMMAND_KEYS.includes(k) || typeof v !== 'string')) {
      fail('commands must be an object of test, lint and build text');
    }
  }
  if (sel.skills !== undefined && (!Array.isArray(sel.skills) || sel.skills.some((n) => typeof n !== 'string' || !ID_RE.test(n)))) fail('skills must be a list of names');
}

// Sets (or removes) the `agent:` of each stage in a workflow template's text, keeping comments and layout.
function applyStageAgents(text, wfId, info, selection) {
  const present = presentAgents(selection);
  const lines = text.split('\n');
  const out = [];
  let stage = null;
  for (const line of lines) {
    const idm = /^ {2}- id:\s*(\S+)\s*$/.exec(line);
    if (idm) stage = idm[1].replace(/^['"]|['"]$/g, '');
    const am = /^( {4}agent:\s*)(\S+)\s*$/.exec(line);
    if (am && stage) {
      const current = am[2].replace(/^['"]|['"]$/g, '');
      const key = `${wfId}.${stage}`;
      let next = current;
      if (Object.prototype.hasOwnProperty.call(selection.stageAgents || {}, key)) next = selection.stageAgents[key];
      else if (!present.has(current)) next = null;
      if (next === null || next === undefined || next === '') continue; // drop the line
      if (next !== current && !ID_RE.test(next)) throw new Error(`invalid agent name "${next}"`);
      out.push(next === current ? line : `${am[1]}${next}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// The files to write for a selection: [{ to, data (Buffer), overwrite? }].
function planWrites(info, selection) {
  const wfs = info.workflows.filter((w) => selection.workflows.includes(w.id));
  const ruleIds = new Set(wfs.flatMap((w) => w.stages.map((st) => st.id)));
  const writes = [];
  for (const f of templateFiles()) {
    let m;
    if ((m = /^\.shipline\/workflows\/([^/]+)\.yml$/.exec(f.to))) {
      if (!selection.workflows.includes(m[1])) continue;
      writes.push({ to: f.to, data: Buffer.from(applyStageAgents(readFileSync(f.from, 'utf8'), m[1], info, selection)) });
    } else if ((m = /^\.shipline\/rules\/([^/]+)\.md$/.exec(f.to))) {
      if (!ruleIds.has(m[1])) continue;
      writes.push({ to: f.to, data: readFileSync(f.from) });
    } else if ((m = /^\.claude\/agents\/([^/]+)\.md$/.exec(f.to))) {
      const clash = clashOf(info, selection, m[1]);
      if (!selection.agents.includes(m[1]) || clash === 'skip' || clash === 'keep') continue;
      writes.push({ to: f.to, data: readFileSync(f.from), overwrite: clash === 'ours' });
    } else if (f.to === '.shipline/config.yml') {
      const text = readFileSync(f.from, 'utf8');
      const model = parseYaml(text) || {};
      const commands = { ...pickCommands(null), ...selection.commands };
      let changed = false;
      if (selection.skills && selection.skills.length) {
        model.skills = selection.skills;
        changed = true;
      }
      if (COMMAND_KEYS.some((k) => commands[k])) {
        model.commands = commands;
        changed = true;
      }
      if (selection.tracker && selection.tracker !== model.tracker) {
        model.tracker = selection.tracker;
        changed = true;
      }
      if (!changed) writes.push({ to: f.to, data: Buffer.from(text) });
      else writes.push({ to: f.to, data: Buffer.from(emitConfig(model, { layout: configLayout(), raw: text })) });
    } else writes.push({ to: f.to, data: readFileSync(f.from) });
  }
  if (selection.ci) writes.push({ to: CI_WORKFLOW, data: readFileSync(CI_WORKFLOW_TEMPLATE) });
  return writes;
}

// Shipline's agent files the team doesn't have from us: deselected, skipped, or "keep yours" clashes.
function excludedPaths(info, selection) {
  return info.agents
    .filter((a) => !selection.agents.includes(a) || ['skip', 'keep'].includes(clashOf(info, selection, a)))
    .map(AGENT_PATH)
    .sort();
}

function commandsSummary(commands, detected) {
  const rows = COMMAND_KEYS.filter((k) => commands[k]).map((k) => `  ${k}: ${commands[k]}${detected.sources[k] && commands[k] === detected[k] ? ` (from ${detected.sources[k]})` : ''}`);
  return rows.length ? `Commands for the verify stage:\n${rows.join('\n')}` : 'No test, lint or build commands set; add them under commands: in .shipline/config.yml.';
}

// Returns a process exit code. Preflights everything, then writes. `prompts` (optional) replaces the interactive
// questions in-process: an async function (info) => selection, where info is
// { workflows, agents, repoAgents, repoSkills, missingStageAgents(selection) }.
export async function runInit({ target, dryRun = false, yes = false, prompts = null }) {
  const root = path.resolve(target);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    console.error(`shipline: ${root} is not a directory.`);
    return 1;
  }

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const claudeMdFile = path.join(root, 'CLAUDE.md');
  const settingsText = readIfExists(settingsFile);
  const claudeMd = readIfExists(claudeMdFile);

  // Already initialized? Checked before any prompt, with or without --yes.
  if (existsSync(path.join(root, '.shipline', 'config.yml')) || (claudeMd && claudeMd.includes(START)) || hasShiplineHooks(settingsText)) {
    console.log(`Shipline is already initialized in this repo (found .shipline/, the CLAUDE.md block or the hooks). Nothing was written.
  - Change which agents and skills are installed: \`npx @forgeyard/shipline ui\`, then Setup, Agents & skills.
  - Update to this version: \`npx @forgeyard/shipline upgrade\`.
  - Start over: \`npx @forgeyard/shipline uninstall\`, then \`init\` again.`);
    return 0;
  }

  if (!yes && !prompts && !process.stdin.isTTY) {
    console.error('shipline: init asks questions, and this is not a terminal. Run it in a terminal, or pass --yes to install the defaults.');
    return 1;
  }

  // What the repo already has, and what Shipline offers.
  const info = {
    workflows: shippedWorkflows(),
    agents: shippedAgents(),
    repoAgents: listNames(path.join(root, '.claude', 'agents')),
    repoSkills: listNames(path.join(root, '.claude', 'skills'), { dirs: true }),
  };
  info.detected = detectCommands(root);
  info.trackerDefault = trackerDefault(root);
  info.missingStageAgents = (selection) => missingStageAgents(info.workflows, selection);

  let selection;
  try {
    if (yes) selection = defaultSelection(info);
    else if (prompts) selection = await prompts(info);
    else selection = await (await import('./init-prompts.mjs')).askSelection(info);
    checkSelection(info, selection);
  } catch (e) {
    console.error(`shipline: init cancelled, nothing was written. ${e.message}`);
    return 1;
  }
  selection = { clashes: {}, stageAgents: {}, skills: [], commands: pickCommands(info.detected), tracker: 'jira', ci: false, ...selection };

  // Preflight: nothing is written until every check passes.
  const writes = planWrites(info, selection);
  const collisions = [];
  for (const f of [...writes, { to: VERSION_FILE }]) {
    const abs = path.join(root, f.to);
    if (existsSync(abs)) {
      if (!f.overwrite) collisions.push(f.to);
      continue;
    }
    // A parent that exists as a file would also make the write fail.
    let p = path.dirname(abs);
    while (isInside(root, p) && p !== root) {
      if (existsSync(p) && !lstatSync(p).isDirectory()) {
        collisions.push(path.relative(root, p));
        break;
      }
      p = path.dirname(p);
    }
  }
  for (const [file, label] of [[settingsFile, '.claude/settings.json'], [claudeMdFile, 'CLAUDE.md']]) {
    if (existsSync(file) && lstatSync(file).isDirectory()) collisions.push(label);
  }
  if (collisions.length) {
    console.error('shipline: init aborted, nothing was written. These paths already exist:\n' + [...new Set(collisions)].map((c) => `  - ${c}`).join('\n'));
    console.error('\nRename or move them, then run init again.');
    return 1;
  }

  let newSettings;
  try {
    newSettings = mergeSettings(settingsText, templateSettings());
  } catch (e) {
    console.error(`shipline: init aborted. ${e.message}`);
    return 1;
  }
  const section = claudeMdSection();
  const newClaudeMd =
    claudeMd === null ? section : toEol(claudeMd.replace(/\s*$/, '\n\n') + section, detectEol(claudeMd));
  const excluded = excludedPaths(info, selection);

  if (!dryRun) {
    // The store must be writable before anything is installed (SHIPLINE_HOME, or ~/.shipline).
    try {
      storeDir(root);
    } catch (e) {
      console.error(`shipline: ${e.message}`);
      return 1;
    }
  }

  if (dryRun) {
    console.log('Dry run, nothing written. Would create:');
    for (const f of writes) console.log(`  ${f.overwrite ? '~' : '+'} ${f.to}`);
    console.log(`  + ${VERSION_FILE}`);
    console.log(`  ${settingsText === null ? '+' : '~'} .claude/settings.json (hooks and allow rules merged)`);
    console.log(`  ${claudeMd === null ? '+' : '~'} CLAUDE.md (marked block ${claudeMd === null ? 'created' : 'appended'})`);
    for (const p of excluded) console.log(`  = ${p} (not installed; recorded as excluded)`);
    return 0;
  }

  // Write, rolling back on failure so a half-written install never remains.
  const created = [];
  const replaced = []; // [abs, original Buffer] for repo agent files that "use ours" overwrote
  const written = {};
  try {
    for (const f of writes) {
      const abs = path.join(root, f.to);
      mkdirSync(path.dirname(abs), { recursive: true });
      if (f.overwrite && existsSync(abs)) {
        replaced.push([abs, readFileSync(abs)]);
        writeFileSync(abs, f.data);
      } else {
        writeFileSync(abs, f.data, { flag: 'wx' });
        created.push(abs);
      }
      written[f.to] = sha256(f.data);
    }
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, newSettings);
    writeFileSync(claudeMdFile, newClaudeMd);
    // Last write: if anything above failed, VERSION is never written.
    const versionAbs = path.join(root, VERSION_FILE);
    const owned = new Set(ownedTemplateFiles().map((f) => f.to));
    if (selection.ci) owned.add(CI_WORKFLOW);
    const fileHashes = Object.fromEntries(Object.entries(written).filter(([to]) => owned.has(to)));
    fileHashes[CLAUDE_MD_KEY] = sha256(claudeMdBlock(newClaudeMd));
    fileHashes[SETTINGS_KEY] = sha256(canonicalSettingsPart(JSON.parse(newSettings)));
    writeFileSync(versionAbs, JSON.stringify({ package: PACKAGE_VERSION, interface: INTERFACE, files: Object.fromEntries(Object.entries(fileHashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), excluded: [...excluded].sort() }, null, 2) + '\n', { flag: 'wx' });
    created.push(versionAbs);
  } catch (e) {
    for (const abs of created) rmSync(abs, { force: true });
    for (const [abs, data] of replaced) writeFileSync(abs, data);
    if (settingsText === null) rmSync(settingsFile, { force: true });
    else writeFileSync(settingsFile, settingsText);
    if (claudeMd === null) rmSync(claudeMdFile, { force: true });
    else writeFileSync(claudeMdFile, claudeMd);
    console.error(`shipline: init failed while writing (${e.message}); changes were rolled back.`);
    return 1;
  }

  const kept = info.agents.filter((a) => selection.agents.includes(a) && clashOf(info, selection, a) === 'keep');
  console.log(`Shipline initialized in ${root}

  created ${writes.filter((f) => f.to !== CI_WORKFLOW).length} files under .shipline/ and .claude/
  ${settingsText === null ? 'created' : 'merged hooks and allow rules into'} .claude/settings.json
  ${claudeMd === null ? 'created' : 'appended a marked block to'} CLAUDE.md
${kept.length ? `\nKept your own agents (used where Shipline's would be): ${kept.join(', ')}. To use Shipline's instead: \`npx @forgeyard/shipline ui\` -> Setup -> Agents & skills, or uninstall and re-run \`init\` interactively.\n` : ''}${selection.ci ? `\nAdded the pull-request check .github/workflows/shipline.yml (paste \`node .shipline/bin/stage.mjs pr-summary\` into PR descriptions).\n` : ''}
${commandsSummary(selection.commands, info.detected)}
Tracker: ${selection.tracker === 'github' ? 'GitHub Issues (read with the gh CLI)' : 'Jira (read through the Atlassian MCP)'}. Change it in .shipline/config.yml.

Next: tailor the rules to this repo. Run \`/shipline-setup\` in Claude Code, or open \`npx @forgeyard/shipline ui\` and use Setup -> Set up with Claude.
Then commit .shipline/, .claude/ and CLAUDE.md so teammates get the same flow on clone (Node 18+ required).`);
  return 0;
}
