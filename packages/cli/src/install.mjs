// What `shipline init` and the browser wizard share: what can be chosen, the plan for a selection (which reads
// files and writes nothing), and the all-or-nothing write. Node 18+, no dependencies.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectEol, isInside, parseYaml, toEol } from '../templates/shipline/bin/lib.mjs';
import { INTERFACE } from './interface.mjs';
import {
  CI_WORKFLOW, CI_WORKFLOW_TEMPLATE, CLAUDE_MD_KEY, HOOK_MARK, PACKAGE_VERSION, SETTINGS_KEY, START, VERSION_FILE,
  TEMPLATES, canonicalSettingsPart, claudeMdBlock, claudeMdSection, isShiplineHookEntry, ownedTemplateFiles, sha256,
  templateFiles, templateSettings,
} from './hashes.mjs';
import { detectCommands } from './detect-commands.mjs';
import { detectUi } from './detect-ui.mjs';
import { CONFIRMATIONS, RAIL_IDS, TRACKERS, branchPatternError, configLayout } from './setup-schema.mjs';
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
const COMMAND_KEYS = ['test', 'lint', 'build'];
export const DEFAULT_BRANCH_PATTERN = '{type}/{key}-{slug}';
export const GUARDRAILS_OFF_NOTE = '# Guardrails are off (chosen at setup). Turn them on here or in Setup → Guardrails.';
const pickCommands = (detected) => Object.fromEntries(COMMAND_KEYS.map((k) => [k, (detected && detected[k]) || '']));

// Names of the *.md files / folders directly under dir (empty when it doesn't exist).
export function listNames(dir, { dirs = false } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (dirs ? e.isDirectory() : e.isFile() && e.name.endsWith('.md')))
    .map((e) => (dirs ? e.name : e.name.slice(0, -3)))
    .filter((n) => ID_RE.test(n))
    .sort();
}

// The workflows Shipline ships: [{ id, name, description, stages: [{ id, name, agent, condition }] }], from the templates.
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
        stages: wf.stages.map((st) => ({ id: st.id, name: st.name || st.id, agent: st.agent || null, condition: st.condition || null })),
      };
    });
}

// The default order of Shipline's agents.
const AGENT_ORDER = ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher'];
export function shippedAgents() {
  const names = listNames(path.join(TEMPLATES, 'claude', 'agents'));
  return [...AGENT_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !AGENT_ORDER.includes(n))];
}

// The `description:` line of a shipped agent's front matter ('' when absent).
export function agentDescription(name) {
  const text = readFileSync(path.join(TEMPLATES, 'claude', 'agents', `${name}.md`), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m = fm && /^description:\s*(.*)$/m.exec(fm[1]);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

// The stages of a workflow that stay in the written file: `ui_only` stages go when the repo has no UI.
export const activeStages = (wf, ui) => wf.stages.filter((st) => ui !== false || st.condition !== 'ui_only');

// Shipline's agents that a stage names: those the chosen workflows' remaining stages use. Standalone agents
// (no shipped stage names them) are never part of this.
export function defaultAgents(info, workflowIds, ui) {
  const used = new Set();
  for (const wf of info.workflows) {
    if (!workflowIds.includes(wf.id)) continue;
    for (const st of activeStages(wf, ui)) if (st.agent) used.add(st.agent);
  }
  return info.agents.filter((a) => used.has(a));
}

// What `.shipline/config.yml` (a team file) and the merge targets say about this folder.
// 'installed': config.yml exists. 'partial': no config, but the CLAUDE.md block or Shipline's hooks are there.
// 'clean': none of these. found lists what a partial install has.
export function installState(root) {
  if (existsSync(path.join(root, '.shipline', 'config.yml'))) return { state: 'installed', found: [] };
  const claudeMd = readIfExists(path.join(root, 'CLAUDE.md'));
  const settingsText = readIfExists(path.join(root, '.claude', 'settings.json'));
  const found = [];
  if (claudeMd && claudeMd.includes(START)) found.push('claude-md-block');
  if (hasShiplineHooks(settingsText)) found.push('hooks');
  return { state: found.length ? 'partial' : 'clean', found };
}

// New installs start with no tracker: the ticket stage is skipped until the team picks GitHub Issues or Jira.
function trackerDefault() {
  return 'none';
}

// What the repo already has, and what Shipline offers.
export function installInfo(root) {
  const workflows = shippedWorkflows();
  const agents = shippedAgents();
  const agentUse = Object.fromEntries(agents.map((a) => [a, []]));
  for (const wf of workflows) for (const st of wf.stages) if (st.agent && agentUse[st.agent]) agentUse[st.agent].push(`${wf.id}.${st.id}`);
  const { state, found } = installState(root);
  return {
    workflows,
    agents,
    repoAgents: listNames(path.join(root, '.claude', 'agents')),
    repoSkills: listNames(path.join(root, '.claude', 'skills'), { dirs: true }),
    detected: detectCommands(root),
    trackerDefault: trackerDefault(),
    uiDetected: detectUi(root).ui,
    agentUse,
    state,
    found,
  };
}

// What an answer-less install does (`init --yes`): every workflow, the UI stages when a UI is detected, the agents
// those stages use, "keep yours" on every clash, stage agents left alone, no repo skills.
export function defaultSelection(info) {
  const workflows = info.workflows.map((w) => w.id);
  const agents = defaultAgents(info, workflows, info.uiDetected);
  return {
    workflows,
    ui: info.uiDetected,
    agents,
    clashes: Object.fromEntries(agents.filter((a) => info.repoAgents.includes(a)).map((a) => [a, 'keep'])),
    stageAgents: {},
    skills: [],
    commands: pickCommands(info.detected),
    tracker: 'none',
    confirmations: 'standard',
    guardrails: 'on',
    branchPattern: DEFAULT_BRANCH_PATTERN,
    ci: false,
  };
}

// Terminal init: fills what an answer left out (the API requires every field instead).
export function fillSelection(info, sel) {
  const out = { ui: info.uiDetected, clashes: {}, stageAgents: {}, skills: [], tracker: 'none', confirmations: 'standard', guardrails: 'on', branchPattern: DEFAULT_BRANCH_PATTERN, ci: false, ...sel };
  out.commands = sel.commands === undefined ? pickCommands(info.detected) : { ...pickCommands(null), ...sel.commands };
  return out;
}

// Throws `invalid selection: ...` for a selection that can't be installed. With partial: true the optional
// fields may be missing (terminal init fills them); the API passes every field.
export function checkSelection(info, sel, { partial = false } = {}) {
  const fail = (m) => {
    throw new Error(`invalid selection: ${m}`);
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(sel)) fail('not an object');
  const need = (k) => {
    if (!partial && sel[k] === undefined) fail(`${k} is required`);
    return sel[k] !== undefined;
  };
  if (!Array.isArray(sel.workflows) || sel.workflows.length === 0) fail('choose at least one workflow');
  if (sel.workflows.some((id) => !info.workflows.some((w) => w.id === id))) fail('unknown workflow');
  if (!Array.isArray(sel.agents) || sel.agents.some((a) => !info.agents.includes(a))) fail('unknown agent');
  if (need('ui') && typeof sel.ui !== 'boolean') fail('ui must be true or false');
  if (need('clashes')) {
    if (!isObj(sel.clashes)) fail('clashes must be an object');
    for (const [name, c] of Object.entries(sel.clashes)) if (!['keep', 'ours', 'skip'].includes(c)) fail(`clash "${name}" must be keep, ours or skip`);
  }
  if (need('stageAgents')) {
    if (!isObj(sel.stageAgents)) fail('stageAgents must be an object');
    for (const [key, v] of Object.entries(sel.stageAgents)) {
      if (v !== null && (typeof v !== 'string' || !ID_RE.test(v))) fail(`stageAgents "${key}" must be an agent name or null`);
    }
  }
  if (need('ci') && typeof sel.ci !== 'boolean') fail('ci must be true or false');
  if (need('tracker') && !TRACKERS.includes(sel.tracker)) fail(`tracker must be ${TRACKERS.join(' or ')}`);
  if (need('commands')) {
    const c = sel.commands;
    if (!isObj(c) || Object.entries(c).some(([k, v]) => !COMMAND_KEYS.includes(k) || typeof v !== 'string')) {
      fail('commands must be an object of test, lint and build text');
    }
    if (!partial && COMMAND_KEYS.some((k) => typeof c[k] !== 'string')) fail('commands must have test, lint and build text');
  }
  // These three are optional everywhere: a missing field means the default (older API callers keep working).
  if (sel.confirmations !== undefined && !CONFIRMATIONS.includes(sel.confirmations)) fail(`confirmations must be ${CONFIRMATIONS.join(' or ')}`);
  if (sel.guardrails !== undefined && !['on', 'off'].includes(sel.guardrails)) fail('guardrails must be on or off');
  if (sel.branchPattern !== undefined) {
    if (typeof sel.branchPattern !== 'string') fail('branchPattern must be text');
    const bad = branchPatternError(sel.branchPattern.trim());
    if (bad) fail(`branchPattern ${bad}`);
  }
  if (need('skills') && (!Array.isArray(sel.skills) || sel.skills.some((n) => typeof n !== 'string' || !ID_RE.test(n)))) fail('skills must be a list of names');
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
// Stages a no-UI repo drops (selection.ui === false) are not asked about.
export function missingStageAgents(workflows, selection) {
  const present = presentAgents(selection);
  const out = [];
  for (const wf of workflows) {
    if (!selection.workflows.includes(wf.id)) continue;
    for (const st of activeStages(wf, selection.ui)) {
      if (st.agent && !present.has(st.agent)) out.push({ key: `${wf.id}.${st.id}`, workflow: wf.id, stage: st.id, agent: st.agent });
    }
  }
  return out;
}

// Removes whole stage blocks (from their `  - id:` line to the next `  - id:` line or top-level key) from a
// workflow template's text. Comments above the stage list are kept; the YAML is never re-emitted.
function removeStages(text, ids) {
  if (!ids.length) return text;
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const idm = /^ {2}- id:\s*(\S+)\s*$/.exec(line);
    if (idm) skipping = ids.includes(idm[1].replace(/^['"]|['"]$/g, ''));
    else if (/^[A-Za-z_]/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

// Sets (or removes) the `agent:` of each stage in a workflow template's text, keeping comments and layout.
function applyStageAgents(text, wfId, selection) {
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

// The text of a shipped workflow as it is written for a selection.
function workflowText(from, wf, selection) {
  const uiOnly = selection.ui === false ? wf.stages.filter((st) => st.condition === 'ui_only').map((st) => st.id) : [];
  return applyStageAgents(removeStages(readFileSync(from, 'utf8'), uiOnly), wf.id, selection);
}

// The files to write for a selection: [{ to, data (Buffer), overwrite? }].
function planWrites(info, selection) {
  const wfs = info.workflows.filter((w) => selection.workflows.includes(w.id));
  const ruleIds = new Set(wfs.flatMap((w) => activeStages(w, selection.ui).map((st) => st.id)));
  const writes = [];
  for (const f of templateFiles()) {
    let m;
    if ((m = /^\.shipline\/workflows\/([^/]+)\.yml$/.exec(f.to))) {
      if (!selection.workflows.includes(m[1])) continue;
      writes.push({ to: f.to, data: Buffer.from(workflowText(f.from, wfs.find((w) => w.id === m[1]), selection)) });
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
      if (selection.confirmations === 'light') {
        model.confirmations = 'light';
        changed = true;
      }
      const pattern = typeof selection.branchPattern === 'string' ? selection.branchPattern.trim() : '';
      if (pattern && pattern !== model.branch_pattern) {
        model.branch_pattern = pattern;
        changed = true;
      }
      const guardrailsOff = selection.guardrails === 'off';
      if (guardrailsOff) {
        model.rails = Object.fromEntries(RAIL_IDS.map((id) => [id, 'off']));
        model.protected_paths = [];
        changed = true;
      }
      if (!changed) writes.push({ to: f.to, data: Buffer.from(text) });
      else {
        let out = emitConfig(model, { layout: configLayout(), raw: text });
        // The note goes directly above `rails:`, in the file's own line ending.
        if (guardrailsOff) out = out.replace(/^rails:/m, (m) => `${GUARDRAILS_OFF_NOTE}${detectEol(out) === '\r\n' ? '\r\n' : '\n'}${m}`);
        writes.push({ to: f.to, data: Buffer.from(out) });
      }
    } else writes.push({ to: f.to, data: readFileSync(f.from) });
  }
  if (selection.ci) writes.push({ to: CI_WORKFLOW, data: readFileSync(CI_WORKFLOW_TEMPLATE) });
  return writes;
}

// The numbered "what now" checklist as lines of text (terminal and wizard show the same). Step 5 only with the CI check.
export function nextSteps(selection = {}) {
  const ci = Boolean(selection.ci);
  const out = [
    'Next steps',
    ci
      ? '  1. Commit the setup:  git add .shipline .claude CLAUDE.md .github/workflows/shipline.yml && git commit -m "Add Shipline"'
      : '  1. Commit the setup:  git add .shipline .claude CLAUDE.md && git commit -m "Add Shipline"',
  ];
  out.push(
    '  2. Open Claude Code in this folder (`claude`) and trust it when asked, so the hooks run.',
    '  3. Try it: ask Claude for a small change, e.g. "fix the typo in README". It picks a workflow and shows the stages.',
    '  4. Tailor the rules to this repo: run /shipline-setup in Claude Code (or `npx @forgeyard/shipline ui` → Setup).',
  );
  if (ci) {
    out.push(
      '  5. Make the CI check count: on GitHub, protect your main branch and require the "Shipline check", and add',
      '     CODEOWNERS for .shipline/ and .github/ (see the README, "The pull-request check").',
    );
  }
  return out;
}

// Shipline's agent files the team doesn't have from us: deselected, skipped, or "keep yours" clashes.
function excludedPaths(info, selection) {
  return info.agents
    .filter((a) => !selection.agents.includes(a) || ['skip', 'keep'].includes(clashOf(info, selection, a)))
    .map(AGENT_PATH)
    .sort();
}

// The plan for a selection. Reads files, writes nothing.
// -> { writes: [{ to, data, overwrite? }], settings: { before, after }, claudeMd: { before, after }, excluded,
//      collisions, mergeError, ci }. before is the current text (null when the file is missing); after is null
// when mergeError is set (.claude/settings.json can't be merged).
export function planInstall(root, info, selection) {
  const settingsFile = path.join(root, '.claude', 'settings.json');
  const claudeMdFile = path.join(root, 'CLAUDE.md');
  const settingsText = readIfExists(settingsFile);
  const claudeMd = readIfExists(claudeMdFile);

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

  let newSettings = null;
  let mergeError = null;
  try {
    newSettings = mergeSettings(settingsText, templateSettings());
  } catch (e) {
    mergeError = e.message;
  }
  const section = claudeMdSection();
  const newClaudeMd = claudeMd === null ? section : toEol(claudeMd.replace(/\s*$/, '\n\n') + section, detectEol(claudeMd));

  return {
    writes,
    settings: { before: settingsText, after: newSettings },
    claudeMd: { before: claudeMd, after: newClaudeMd },
    excluded: excludedPaths(info, selection),
    collisions: [...new Set(collisions)],
    mergeError,
    ci: Boolean(selection.ci),
  };
}

// The files `add workflow` writes into an installed repo: the workflow (its UI-only stages dropped when ui is
// false), the rules of its stages that don't exist yet, and the stage agents the repo doesn't have yet.
// -> { workflow, writes: [{ to, data, agent? }] } (agent: the agent's name, for the files in VERSION).
export function planWorkflowAdd(root, id, ui) {
  const info = { workflows: shippedWorkflows(), agents: shippedAgents(), repoAgents: listNames(path.join(root, '.claude', 'agents')) };
  const wf = info.workflows.find((w) => w.id === id);
  if (!wf) return null;
  const stages = activeStages(wf, ui);
  const needed = defaultAgents(info, [id], ui);
  const missing = needed.filter((a) => !existsSync(path.join(root, AGENT_PATH(a))));
  // Agents already on disk (Shipline's or the team's own) are used as they are; the rest are installed.
  const selection = { workflows: [id], ui, agents: needed, clashes: {}, stageAgents: {}, skills: [], commands: pickCommands(null), tracker: 'none', ci: false };
  const writes = [];
  for (const f of templateFiles()) {
    let m;
    if (f.to === `.shipline/workflows/${id}.yml`) writes.push({ to: f.to, data: Buffer.from(workflowText(f.from, wf, selection)) });
    else if ((m = /^\.shipline\/rules\/([^/]+)\.md$/.exec(f.to)) && stages.some((st) => st.id === m[1])) {
      if (!existsSync(path.join(root, f.to))) writes.push({ to: f.to, data: readFileSync(f.from) });
    } else if ((m = /^\.claude\/agents\/([^/]+)\.md$/.exec(f.to)) && missing.includes(m[1])) {
      writes.push({ to: f.to, data: readFileSync(f.from), agent: m[1] });
    }
  }
  return { workflow: wf, writes };
}

const codedError = (code, message, details) => Object.assign(new Error(message), { code, details });

const hashOrNull = (text) => (text === null ? null : sha256(text));

// The hashes of the merge targets, for the "did the repo change since Review" check.
export function baseHashes(root) {
  return {
    settings: hashOrNull(readIfExists(path.join(root, '.claude', 'settings.json'))),
    claudeMd: hashOrNull(readIfExists(path.join(root, 'CLAUDE.md'))),
  };
}

// Writes a plan, rolling back on failure so a half-written install never remains. With base ({ settings, claudeMd }
// hashes), first re-checks the repo and throws, writing nothing, an error with code:
//   'installed' (something installed meanwhile), 'changed' (a merge target differs from base), or 'collision'
//   (a path to create now exists). 'store' means the store isn't writable (also nothing written); 'write-failed'
//   means a write failed and everything was rolled back.
export function applyInstall(root, plan, { base = null } = {}) {
  if (base) {
    if (installState(root).state !== 'clean') throw codedError('installed', 'Shipline was installed here in the meantime');
    const now = baseHashes(root);
    const changed = [];
    if (now.settings !== base.settings) changed.push('.claude/settings.json');
    if (now.claudeMd !== base.claudeMd) changed.push('CLAUDE.md');
    if (changed.length) throw codedError('changed', 'A file changed since it was reviewed', { paths: changed });
    const taken = [...plan.writes.filter((f) => !f.overwrite), { to: VERSION_FILE }].filter((f) => existsSync(path.join(root, f.to))).map((f) => f.to);
    if (taken.length) throw codedError('collision', 'These paths already exist', { paths: taken });
  }
  // The store must be writable before anything is installed (SHIPLINE_HOME, or ~/.shipline).
  try {
    storeDir(root);
  } catch (e) {
    throw codedError('store', e.message);
  }

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const claudeMdFile = path.join(root, 'CLAUDE.md');
  const created = [];
  const replaced = []; // [abs, original Buffer] for repo agent files that "use ours" overwrote
  const written = {};
  try {
    for (const f of plan.writes) {
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
    writeFileSync(settingsFile, plan.settings.after);
    writeFileSync(claudeMdFile, plan.claudeMd.after);
    // Last write: if anything above failed, VERSION is never written.
    const versionAbs = path.join(root, VERSION_FILE);
    const owned = new Set(ownedTemplateFiles().map((f) => f.to));
    if (plan.ci) owned.add(CI_WORKFLOW);
    const fileHashes = Object.fromEntries(Object.entries(written).filter(([to]) => owned.has(to)));
    fileHashes[CLAUDE_MD_KEY] = sha256(claudeMdBlock(plan.claudeMd.after));
    fileHashes[SETTINGS_KEY] = sha256(canonicalSettingsPart(JSON.parse(plan.settings.after)));
    writeFileSync(versionAbs, versionText(fileHashes, plan.excluded), { flag: 'wx' });
    created.push(versionAbs);
  } catch (e) {
    for (const abs of created) rmSync(abs, { force: true });
    for (const [abs, data] of replaced) writeFileSync(abs, data);
    if (plan.settings.before === null) rmSync(settingsFile, { force: true });
    else writeFileSync(settingsFile, plan.settings.before);
    if (plan.claudeMd.before === null) rmSync(claudeMdFile, { force: true });
    else writeFileSync(claudeMdFile, plan.claudeMd.before);
    throw codedError('write-failed', e.message);
  }
  return { written: Object.keys(written) };
}

function versionText(fileHashes, excluded) {
  const files = Object.fromEntries(Object.entries(fileHashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ package: PACKAGE_VERSION, interface: INTERFACE, files, excluded: [...excluded].sort() }, null, 2) + '\n';
}

export { clashOf, pickCommands, COMMAND_KEYS };
