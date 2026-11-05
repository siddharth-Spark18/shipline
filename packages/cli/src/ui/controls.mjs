// Chat controls (model, effort, permission mode, context) on the server: the repo's remembered choices
// (<store>/ui/controls.json), validation, the start-up flags, the control_request builders and the readers that
// keep only the fields the UI needs. The control_request / control_response protocol is undocumented for the
// CLI; it was checked on claude 2.1.318 (2026-11-05), see docs/plans/shipline-chat-reliability.md.
// Node 20+, no dependencies.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { uiStateDir, writeAtomic } from './sessions.mjs';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// bypassPermissions and dontAsk are never offered.
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto'];
export const FALLBACK_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
const FULL_MODEL_NAME = /^claude-[a-z0-9.-]+$/;
// What a stored model value may look like (an alias, a full name, or a cached `value`).
const SAFE_MODEL_VALUE = /^[A-Za-z0-9._[\]-]+$/;
const CONTEXT_CATEGORIES = 5;

const controlsFile = (root) => path.join(uiStateDir(root), 'controls.json');

// The flag value `manual` is `default` in control messages and system/status; everything else is the same.
export const modeToControl = (mode) => (mode === 'manual' ? 'default' : mode);
export const modeFromControl = (mode) => (mode === 'default' ? 'manual' : mode);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : undefined);

// Keeps only the model, effort and permissionMode that are valid strings (a hand-edited file can't smuggle anything).
function cleanPicks(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  if (typeof raw.model === 'string' && SAFE_MODEL_VALUE.test(raw.model)) out.model = raw.model;
  if (EFFORT_LEVELS.includes(raw.effort)) out.effort = raw.effort;
  if (PERMISSION_MODES.includes(raw.permissionMode)) out.permissionMode = raw.permissionMode;
  return out;
}

// The model entries `initialize` returned, reduced to the fields we keep.
function cleanModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => isObject(m) && str(m.value))
    .map((m) => ({
      value: m.value,
      resolvedModel: str(m.resolvedModel) || null,
      displayName: str(m.displayName) || m.value,
      description: typeof m.description === 'string' ? m.description : '',
      supportsEffort: m.supportsEffort !== false,
      supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
        ? m.supportedEffortLevels.filter((l) => EFFORT_LEVELS.includes(l))
        : [],
      supportsAutoMode: m.supportsAutoMode !== false,
    }));
}

// { model?, effort?, permissionMode?, models: [] } from controls.json (empty when missing or unreadable).
export function readDefaults(root) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(controlsFile(root), 'utf8'));
  } catch {
    // No file yet, or not JSON: no defaults.
  }
  return { ...cleanPicks(raw), models: cleanModels(isObject(raw) ? raw.models : null) };
}

// Merges `patch` ({ model, effort, permissionMode, models }) into controls.json, atomically. Returns the result.
export function writeDefaults(root, patch) {
  const next = { ...readDefaults(root), ...cleanPicks(patch) };
  if (patch && patch.models !== undefined) next.models = cleanModels(patch.models);
  writeAtomic(controlsFile(root), JSON.stringify(next, null, 2) + '\n');
  return next;
}

const bad = (message) => new HttpError(400, 'bad-control', message);

// `input` is { model?, effort?, permissionMode? } from a request body. Returns the same keys, checked, or
// throws 400 bad-control. `models` is the cached list ([{ value }]).
export function validateControls(input, models = []) {
  if (!isObject(input)) throw bad('Expected an object');
  const out = {};
  if (input.model !== undefined) {
    const known = new Set([...FALLBACK_MODELS, ...(models || []).map((m) => m && m.value)]);
    if (
      typeof input.model !== 'string' ||
      !(known.has(input.model) || FULL_MODEL_NAME.test(input.model))
    )
      throw bad('Unknown model');
    out.model = input.model;
  }
  if (input.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(input.effort)) throw bad('Unknown effort level');
    out.effort = input.effort;
  }
  if (input.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(input.permissionMode)) throw bad('Unknown permission mode');
    out.permissionMode = input.permissionMode;
  }
  return out;
}

// Start-up flags, as separate argv entries (never a shell string), for the values that are set.
export function controlArgs(controls) {
  const c = isObject(controls) ? controls : {};
  const argv = [];
  if (c.model) argv.push('--model', c.model);
  if (c.effort) argv.push('--effort', c.effort);
  if (c.permissionMode) argv.push('--permission-mode', c.permissionMode);
  return argv;
}

// ---------- control_request builders (the line written to claude's stdin) ----------

export function controlRequest(requestId, request) {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n';
}

export const requests = {
  initialize: () => ({ subtype: 'initialize' }),
  getSettings: () => ({ subtype: 'get_settings' }),
  getContextUsage: () => ({ subtype: 'get_context_usage' }),
  setModel: (model) => ({ subtype: 'set_model', model }),
  // set_effort is "Unsupported control request subtype"; the in-memory flag layer takes effortLevel instead.
  setEffort: (effort) => ({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } }),
  setPermissionMode: (mode) => ({ subtype: 'set_permission_mode', mode: modeToControl(mode) }),
};

// { requestId, ok, response, error } for a control_response event, otherwise null.
export function parseControlResponse(event) {
  if (!event || event.type !== 'control_response' || !isObject(event.response)) return null;
  const r = event.response;
  if (typeof r.request_id !== 'string') return null;
  return {
    requestId: r.request_id,
    ok: r.subtype === 'success',
    response: isObject(r.response) ? r.response : {},
    error: typeof r.error === 'string' ? r.error : 'Unknown error',
  };
}

// ---------- readers: keep only what the UI needs, never the rest (initialize also returns `account`) ----------

// initialize -> { models, permissionMode } (permissionMode in flag terms, or null).
export function pickModels(response) {
  const r = isObject(response) ? response : {};
  return {
    models: cleanModels(r.models),
    permissionMode: str(r.current_permission_mode)
      ? modeFromControl(r.current_permission_mode)
      : null,
  };
}

// get_settings -> { effort, model }, from `applied` only (the rest is the user's whole merged settings).
export function pickEffort(response) {
  const applied = isObject(response) && isObject(response.applied) ? response.applied : {};
  return {
    effort: EFFORT_LEVELS.includes(applied.effort) ? applied.effort : null,
    model: str(applied.model) || null,
  };
}

// get_context_usage -> { totalTokens, maxTokens, autoCompactThreshold, isAutoCompactEnabled, percentage, categories }
export function pickContext(response) {
  const r = isObject(response) ? response : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const categories = (Array.isArray(r.categories) ? r.categories : [])
    .filter((c) => isObject(c) && typeof c.name === 'string')
    .map((c) => ({ name: c.name, tokens: num(c.tokens) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, CONTEXT_CATEGORIES);
  return {
    totalTokens: num(r.totalTokens),
    maxTokens: num(r.maxTokens),
    autoCompactThreshold: num(r.autoCompactThreshold),
    isAutoCompactEnabled: r.isAutoCompactEnabled === true,
    percentage: num(r.percentage),
    categories,
  };
}
