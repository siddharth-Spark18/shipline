// The workflow validator, shared by the setup screen (src/setup-schema.mjs re-exports it) and by
// `stage.mjs validate` / `stage.mjs draft`. Vendored into .shipline/bin/ with lib.mjs. Node 18+, no dependencies.
import { ACTIONS } from './lib.mjs';

export { ACTIONS };

const ID_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENFORCEMENT = ['guide', 'warn', 'block'];

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const err = (p, message) => ({ path: p, message });
export const warn = (p, message) => ({ path: p, message, severity: 'warning' });

// Every string, anywhere in the model, must be representable on one line.
export function lineBreakErrors(value, p, out) {
  if (typeof value === 'string') {
    if (CONTROL_RE.test(value)) out.push(err(p, 'line breaks are not allowed here'));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => lineBreakErrors(v, `${p}[${i}]`, out));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) lineBreakErrors(v, p ? `${p}.${k}` : k, out);
  }
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
      for (const k of ['optional', 'confirm_to_advance', 'checks', 'checkpoint']) {
        if (s[k] !== undefined && s[k] !== null && typeof s[k] !== 'boolean') out.push(err(`${p}.${k}`, 'must be true or false'));
      }
      if (s.checkpoint === true && s.confirm_to_advance !== true) out.push(warn(`${p}.checkpoint`, 'has no effect without confirm_to_advance'));
      if (s.sections !== undefined && s.sections !== null) {
        if (!Array.isArray(s.sections)) out.push(err(`${p}.sections`, 'must be a list of headings'));
        else {
          s.sections.forEach((h, j) => {
            if (typeof h !== 'string' || h.trim() === '') out.push(err(`${p}.sections[${j}]`, 'must be a non-empty heading'));
          });
        }
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
            const hasActions = b.actions !== undefined && b.actions !== null;
            if (!hasTools && !hasBash && !hasActions) out.push(err(bp, 'needs tools (with allow_paths), bash or actions'));
            if (hasActions) {
              if (!Array.isArray(b.actions) || b.actions.length === 0) out.push(err(`${bp}.actions`, 'must be a list of actions'));
              else {
                b.actions.forEach((a, k) => {
                  if (!ACTIONS.includes(a)) out.push(warn(`${bp}.actions[${k}]`, `not a known action (${ACTIONS.join(', ')}); it never matches`));
                });
              }
            }
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
