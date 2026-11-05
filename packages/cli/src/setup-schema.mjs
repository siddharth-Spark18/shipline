// Checks for the files the setup screen edits (config.yml and workflows/<id>.yml), plus the shipped
// header and layout the writer keeps. Node 18+, no dependencies.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'shipline');

// Keys the form edits. Anything else in a file is shown as "other fields (kept)".
export const KNOWN_FIELDS = {
  config: {
    top: ['branch_pattern', 'tracker', 'commands', 'skills', 'ci'],
    commands: ['test', 'lint', 'build'],
    ci: ['missing_block', 'skip_label'],
  },
  workflow: {
    top: ['id', 'name', 'description', 'branch_type', 'stages'],
    stage: ['id', 'name', 'artifact', 'description', 'optional', 'confirm_to_advance', 'condition', 'agent', 'enforcement', 'blocks'],
    block: ['tools', 'allow_paths', 'bash'],
  },
};

const ID_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PATTERN_VARS = new Set(['key', 'slug', 'type']);
const ENFORCEMENT = ['guide', 'warn', 'block'];
export const CI_MISSING_BLOCK = ['fail-unless-label', 'warn', 'fail'];
export const DEFAULT_CI = { missing_block: 'fail-unless-label', skip_label: 'shipline:skip' };
const SKIP_LABEL_MAX = 50;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (p, message) => ({ path: p, message });
const warn = (p, message) => ({ path: p, message, severity: 'warning' });

// Every string, anywhere in the model, must be representable on one line.
function lineBreakErrors(value, p, out) {
  if (typeof value === 'string') {
    if (CONTROL_RE.test(value)) out.push(err(p, 'line breaks are not allowed here'));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => lineBreakErrors(v, `${p}[${i}]`, out));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) lineBreakErrors(v, p ? `${p}.${k}` : k, out);
  }
}

function checkPattern(model, key, out) {
  const v = model[key];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') return void out.push(err(key, 'must be text'));
  if (!v.includes('{slug}')) out.push(err(key, 'must contain {slug}'));
  for (const m of v.matchAll(/\{([^}]*)\}/g)) {
    if (!PATTERN_VARS.has(m[1])) out.push(err(key, `{${m[1]}} is not allowed here; use {key}, {slug} or {type}`));
  }
}

// opts.skills: names of the folders in .claude/skills (omit to skip the missing-folder warning).
// Returns [{ path, message }]. Warnings carry severity: 'warning'; everything else is an error.
export function validateConfig(model, { skills = null } = {}) {
  const out = [];
  if (!isObj(model)) return [err('', 'config must be a map')];

  checkPattern(model, 'branch_pattern', out);
  if (model.commands !== undefined && model.commands !== null && !isObj(model.commands)) {
    out.push(err('commands', 'must be a map of commands'));
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
      const sl = ci.skip_label;
      if (sl !== undefined && sl !== null) {
        if (typeof sl !== 'string' || sl.trim() === '') out.push(err('ci.skip_label', 'must be a non-empty label name'));
        else if (sl.length > SKIP_LABEL_MAX) out.push(err('ci.skip_label', `must be at most ${SKIP_LABEL_MAX} characters`));
      }
    }
  }
  lineBreakErrors(model, '', out);
  return out;
}

function compiles(src) {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

// opts.id: the file name's id. opts.agents: names from .claude/agents/*.md. opts.existingStageIds: stage
// ids already on disk; those are read-only in the form, so only new ids get the id-format check.
export function validateWorkflow(model, { id, agents = [], existingStageIds = [] } = {}) {
  const out = [];
  if (!isObj(model)) return [err('', 'workflow must be a map')];

  if (model.id !== id) out.push(err('id', `must equal the file name "${id}"`));
  for (const k of ['name', 'description']) {
    if (model[k] !== undefined && model[k] !== null && typeof model[k] !== 'string') out.push(err(k, 'must be text'));
  }
  const bt = model.branch_type;
  if (bt !== undefined && bt !== null && (typeof bt !== 'string' || !/^[A-Za-z0-9_-]*$/.test(bt))) {
    out.push(err('branch_type', 'may only contain letters, digits, - and _'));
  }

  if (!Array.isArray(model.stages) || model.stages.length === 0) {
    out.push(err('stages', 'a workflow needs at least one stage'));
  } else {
    const existing = new Set(existingStageIds);
    const seen = new Set();
    model.stages.forEach((s, i) => {
      const p = `stages[${i}]`;
      if (!isObj(s)) return void out.push(err(p, 'must be a map'));

      if (typeof s.id !== 'string' || s.id === '') out.push(err(`${p}.id`, 'every stage needs an id'));
      else {
        if (!existing.has(s.id) && !ID_RE.test(s.id)) out.push(err(`${p}.id`, 'may only contain letters, digits, - and _'));
        if (seen.has(s.id)) out.push(err(`${p}.id`, `duplicate stage id "${s.id}"`));
        seen.add(s.id);
      }
      for (const k of ['name', 'description']) {
        if (s[k] !== undefined && s[k] !== null && typeof s[k] !== 'string') out.push(err(`${p}.${k}`, 'must be text'));
      }
      if (s.artifact !== undefined && s.artifact !== null) {
        if (typeof s.artifact !== 'string') out.push(err(`${p}.artifact`, 'must be a file name'));
        else if (s.artifact.includes('/')) out.push(err(`${p}.artifact`, 'must be a file name, not a path (no /)'));
      }
      for (const k of ['optional', 'confirm_to_advance']) {
        if (s[k] !== undefined && s[k] !== null && typeof s[k] !== 'boolean') out.push(err(`${p}.${k}`, 'must be true or false'));
      }
      if (s.condition !== undefined && s.condition !== null && s.condition !== 'ui_only') {
        out.push(err(`${p}.condition`, 'must be empty or ui_only'));
      }
      if (s.agent !== undefined && s.agent !== null && s.agent !== '') {
        if (typeof s.agent !== 'string') out.push(err(`${p}.agent`, 'must be an agent name'));
        else if (!agents.includes(s.agent)) out.push(warn(`${p}.agent`, `no agent file .claude/agents/${s.agent}.md found`));
      }
      if (!ENFORCEMENT.includes(s.enforcement)) {
        out.push(err(`${p}.enforcement`, 'must be guide, warn or block (anything else silently falls back to guide)'));
      }

      if (s.blocks !== undefined && s.blocks !== null) {
        if (!Array.isArray(s.blocks)) out.push(err(`${p}.blocks`, 'must be a list'));
        else {
          s.blocks.forEach((b, j) => {
            const bp = `${p}.blocks[${j}]`;
            if (!isObj(b)) return void out.push(err(bp, 'must be a map'));
            const hasTools = b.tools !== undefined && b.tools !== null;
            const hasBash = b.bash !== undefined && b.bash !== null;
            if (!hasTools && !hasBash) out.push(err(bp, 'needs either tools (with allow_paths) or bash'));
            if (hasTools && (typeof b.tools !== 'string' || !compiles(`^(?:${b.tools})$`))) {
              out.push(err(`${bp}.tools`, 'must be a valid regular expression of tool names'));
            }
            if (hasBash && (typeof b.bash !== 'string' || !compiles(b.bash))) {
              out.push(err(`${bp}.bash`, 'must be a valid regular expression'));
            }
            const ap = b.allow_paths;
            if (ap !== undefined && ap !== null && (!Array.isArray(ap) || ap.some((g) => typeof g !== 'string'))) {
              out.push(err(`${bp}.allow_paths`, 'must be a list of path globs'));
            }
          });
          if (s.blocks.length && ENFORCEMENT.includes(s.enforcement) && s.enforcement === 'guide') {
            out.push(warn(`${p}.blocks`, 'has no effect under guide'));
          }
        }
      }
    });
  }

  lineBreakErrors(model, '', out);
  return out;
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
