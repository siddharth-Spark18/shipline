// Checks for the files the setup screen edits (config.yml and workflows/<id>.yml), plus the shipped
// header and layout the writer keeps. Node 22+, no dependencies.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, err, isObj, lineBreakErrors, validateWorkflow, warn } from '../templates/shipline/bin/workflow-check.mjs';

// The workflow validator lives in the vendored workflow-check.mjs (stage.mjs validate uses the same copy).
export { ACTIONS, validateWorkflow };

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'shipline');

// Keys the form edits. Anything else in a file is shown as "other fields (kept)".
export const KNOWN_FIELDS = {
  config: {
    top: ['branch_pattern', 'tracker', 'commands', 'skills', 'ci', 'setup', 'rails', 'rails_commands', 'protected_paths', 'scope_check', 'confirmations', 'fail_first', 'non_interactive', 'stale_task_days'],
    commands: ['test', 'lint', 'build'],
    ci: ['missing_block', 'skip_label', 'stale_checks', 'allow_non_interactive'],
    rails: ['force_push_default', 'push_default', 'pipe_to_shell', 'print_credentials', 'read_credentials', 'deploy', 'migrate', 'install_packages', 'agent_config'],
    rails_commands: ['deploy', 'migrate', 'install_packages'],
    scope_check: ['enabled', 'sensitive_extra'],
    fail_first: ['level', 'workflows'],
  },
  workflow: {
    top: ['id', 'name', 'description', 'branch_type', 'stages'],
    stage: ['id', 'name', 'artifact', 'description', 'optional', 'confirm_to_advance', 'condition', 'agent', 'enforcement', 'blocks', 'checks', 'sections', 'checkpoint'],
    block: ['tools', 'allow_paths', 'bash', 'actions'],
  },
};

const ID_RE = /^[A-Za-z0-9_-]+$/;
const PATTERN_VARS = new Set(['key', 'slug', 'type']);
export const CI_MISSING_BLOCK = ['fail-unless-label', 'warn', 'fail'];
export const CI_STALE_CHECKS = ['warn', 'fail'];
export const DEFAULT_CI = { missing_block: 'fail-unless-label', skip_label: 'shipline:skip', stale_checks: 'warn' };
const SKIP_LABEL_MAX = 50;
export const TRACKERS = ['none', 'jira', 'github'];
export const CONFIRMATIONS = ['standard', 'light'];
export const NON_INTERACTIVE = ['deny', 'checks_pass'];
export const RAIL_IDS = KNOWN_FIELDS.config.rails;
export const RAIL_LEVELS = ['deny', 'ask', 'off'];
export const FAIL_FIRST_LEVELS = ['off', 'note', 'section', 'proof'];


function checkPattern(model, key, out) {
  const v = model[key];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') return void out.push(err(key, 'must be text'));
  if (!v.includes('{slug}')) out.push(err(key, 'must contain {slug}'));
  for (const m of v.matchAll(/\{([^}]*)\}/g)) {
    if (!PATTERN_VARS.has(m[1])) out.push(err(key, `{${m[1]}} is not allowed here; use {key}, {slug} or {type}`));
  }
}

// The first error message for a branch pattern, or null when it is fine (text with {slug}; only {key}, {slug} and {type}).
export function branchPatternError(value) {
  const out = [];
  checkPattern({ branch_pattern: value }, 'branch_pattern', out);
  return out.length ? out[0].message : null;
}

// opts.skills: names of the folders in .claude/skills (omit to skip the missing-folder warning).
// opts.workflows: [{ id, stages: [{ id }] }] of the repo's workflows (omit to skip the fail_first workflow checks).
// Returns [{ path, message }]. Warnings carry severity: 'warning'; everything else is an error.
export function validateConfig(model, { skills = null, workflows = null } = {}) {
  const out = [];
  if (!isObj(model)) return [err('', 'config must be a map')];

  checkPattern(model, 'branch_pattern', out);
  if (model.tracker !== undefined && model.tracker !== null && model.tracker !== '' && !TRACKERS.includes(model.tracker)) {
    out.push(warn('tracker', 'not supported; the ticket stage will be skipped'));
  }
  if (model.commands !== undefined && model.commands !== null && !isObj(model.commands)) {
    out.push(err('commands', 'must be a map of commands'));
  }
  if (model.confirmations !== undefined && model.confirmations !== null && model.confirmations !== '' && !CONFIRMATIONS.includes(model.confirmations)) {
    out.push(err('confirmations', `must be one of ${CONFIRMATIONS.join(', ')}`));
  }
  if (model.non_interactive !== undefined && model.non_interactive !== null && model.non_interactive !== '' && !NON_INTERACTIVE.includes(model.non_interactive)) {
    out.push(err('non_interactive', `must be one of ${NON_INTERACTIVE.join(', ')}`));
  }
  if (model.stale_task_days !== undefined && model.stale_task_days !== null && model.stale_task_days !== '' && !(Number.isInteger(model.stale_task_days) && model.stale_task_days >= 1)) {
    out.push(err('stale_task_days', 'must be a whole number, 1 or more'));
  }
  const sk = model.skills;
  if (sk !== undefined && sk !== null) {
    if (!Array.isArray(sk)) out.push(err('skills', 'must be a list of skill names'));
    else {
      sk.forEach((n, i) => {
        const p = `skills[${i}]`;
        if (typeof n !== 'string' || !ID_RE.test(n)) out.push(err(p, 'may only contain letters, digits, - and _'));
        else if (skills && !skills.includes(n)) out.push(warn(p, `no skill folder .claude/skills/${n}/ found`));
      });
    }
  }
  const ci = model.ci;
  if (ci !== undefined && ci !== null) {
    if (!isObj(ci)) out.push(err('ci', 'must be a map'));
    else {
      const mb = ci.missing_block;
      if (mb !== undefined && mb !== null && !CI_MISSING_BLOCK.includes(mb)) {
        out.push(err('ci.missing_block', `must be one of ${CI_MISSING_BLOCK.join(', ')}`));
      }
      const sc = ci.stale_checks;
      if (sc !== undefined && sc !== null && !CI_STALE_CHECKS.includes(sc)) {
        out.push(err('ci.stale_checks', `must be one of ${CI_STALE_CHECKS.join(', ')}`));
      }
      const ani = ci.allow_non_interactive;
      if (ani !== undefined && ani !== null && typeof ani !== 'boolean') out.push(err('ci.allow_non_interactive', 'must be true or false'));
      const sl = ci.skip_label;
      if (sl !== undefined && sl !== null) {
        if (typeof sl !== 'string' || sl.trim() === '') out.push(err('ci.skip_label', 'must be a non-empty label name'));
        else if (sl.length > SKIP_LABEL_MAX) out.push(err('ci.skip_label', `must be at most ${SKIP_LABEL_MAX} characters`));
      }
    }
  }
  validateGuardrails(model, out);
  validateFailFirst(model, out, workflows);
  lineBreakErrors(model, '', out);
  return out;
}

// rails, rails_commands, protected_paths and scope_check. An unknown rail id or value is a warning (the default is used).
function validateGuardrails(model, out) {
  const stringList = (v, p) => {
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) return void out.push(err(p, 'must be a list'));
    v.forEach((x, i) => {
      if (typeof x !== 'string' || x.trim() === '') out.push(err(`${p}[${i}]`, 'must be non-empty text'));
    });
  };
  const rails = model.rails;
  if (rails !== undefined && rails !== null) {
    if (!isObj(rails)) out.push(err('rails', 'must be a map of rail to deny, ask or off'));
    else {
      for (const [id, v] of Object.entries(rails)) {
        if (!RAIL_IDS.includes(id)) out.push(warn(`rails.${id}`, 'not a known rail; it is ignored'));
        else if (v !== undefined && v !== null && !RAIL_LEVELS.includes(v)) out.push(warn(`rails.${id}`, `must be one of ${RAIL_LEVELS.join(', ')}; the default is used`));
      }
    }
  }
  const rc = model.rails_commands;
  if (rc !== undefined && rc !== null) {
    if (!isObj(rc)) out.push(err('rails_commands', 'must be a map with deploy, migrate and install_packages lists'));
    else {
      for (const k of Object.keys(rc)) if (!KNOWN_FIELDS.config.rails_commands.includes(k)) out.push(warn(`rails_commands.${k}`, 'not a known key; it is ignored'));
      stringList(rc.deploy, 'rails_commands.deploy');
      stringList(rc.migrate, 'rails_commands.migrate');
      stringList(rc.install_packages, 'rails_commands.install_packages');
    }
  }
  stringList(model.protected_paths, 'protected_paths');
  const sc = model.scope_check;
  if (sc !== undefined && sc !== null) {
    if (!isObj(sc)) out.push(err('scope_check', 'must be a map'));
    else {
      if (sc.enabled !== undefined && sc.enabled !== null && typeof sc.enabled !== 'boolean') out.push(err('scope_check.enabled', 'must be true or false'));
      stringList(sc.sensitive_extra, 'scope_check.sensitive_extra');
    }
  }
}

// fail_first: level must be one of FAIL_FIRST_LEVELS; workflows a list of existing workflow ids. A listed workflow
// with no `reproduce` stage is a warning (nothing to enforce there). An unknown workflow id is an error unless
// the level is off.
function validateFailFirst(model, out, workflows) {
  const ff = model.fail_first;
  if (ff === undefined || ff === null) return;
  if (!isObj(ff)) return void out.push(err('fail_first', 'must be a map with level and workflows'));
  for (const k of Object.keys(ff)) if (!KNOWN_FIELDS.config.fail_first.includes(k)) out.push(warn(`fail_first.${k}`, 'not a known key; it is ignored'));
  if (ff.level !== undefined && ff.level !== null && !FAIL_FIRST_LEVELS.includes(ff.level)) {
    out.push(err('fail_first.level', `must be one of ${FAIL_FIRST_LEVELS.join(', ')}`));
  }
  const wf = ff.workflows;
  if (wf === undefined || wf === null) return;
  if (!Array.isArray(wf)) return void out.push(err('fail_first.workflows', 'must be a list of workflow ids'));
  wf.forEach((id, i) => {
    const p = `fail_first.workflows[${i}]`;
    if (typeof id !== 'string' || !ID_RE.test(id)) return void out.push(err(p, 'must be a workflow id'));
    if (!workflows) return;
    const known = workflows.find((w) => w.id === id);
    if (!known) {
      if (ff.level !== 'off' && ff.level !== undefined && ff.level !== null) out.push(err(p, `no workflow "${id}" in this repo`));
    }
    else if (!(known.stages || []).some((s) => s && s.id === 'reproduce')) out.push(warn(p, `workflow "${id}" has no reproduce stage, so fail_first does nothing there`));
  });
}

// The run of `#` lines from line 1 of the shipped template, plus one blank line after it if there is one.
// A workflow with no shipped template gets feature.yml's header.
export function headerFor(workflowId) {
  const file = path.join(TEMPLATES, 'workflows', `${workflowId}.yml`);
  const source = ID_RE.test(String(workflowId)) && existsSync(file) ? file : path.join(TEMPLATES, 'workflows', 'feature.yml');
  const lines = readFileSync(source, 'utf8').split('\n');
  let n = 0;
  while (n < lines.length && lines[n].startsWith('#')) n++;
  if (n === 0) return '';
  const blank = lines[n] === '' && n < lines.length - 1;
  return lines.slice(0, n).join('\n') + '\n' + (blank ? '\n' : '');
}

// The text of the shipped config.yml, which fixes the layout `emitConfig` writes.
export function configLayout() {
  return readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');
}
