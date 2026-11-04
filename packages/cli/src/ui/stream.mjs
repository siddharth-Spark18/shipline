// `claude -p --output-format stream-json` lines and the helpers that read them. Copied from
// packages/shared/src/stream-json.ts. Node 20+, no dependencies.

// Event types the chat forwards. A valid JSON line with another `type` is logged and skipped.
export const KNOWN_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

// UNVERIFIED (chat test Q6): the guard's deny reason reaches Claude as a tool_result error whose text
// contains the `Shipline (` prefix (templates/shipline/bin/guard.mjs). The exact wrapping is not captured yet.
export const GUARD_DENIAL_PATTERN = /Shipline \(/;
const GUARD_DENIAL_WINDOW = 300;

// UNVERIFIED (chat test Q8): a hook systemMessage may not appear in -p stream-json at all.
const FAIL_OPEN_PATTERN = /^Shipline: ignoring a problem and continuing without enforcement/;
const LOST_TASK_PATTERN = /^Shipline: branch .* isn't tracking it/s;

const USAGE_LIMIT = /(usage limit|rate limit|limit reached|5-hour limit|weekly limit)/i;

// { ok: true, event } | { ok: false, error, line } | { skip: true } for a blank line.
export function parseLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return { skip: true };
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return { ok: false, error: 'event has no string "type"', line };
    }
    return { ok: true, event: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON', line };
  }
}

// The line written to stdin with --input-format stream-json.
export function userMessage(text) {
  return (
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) +
    '\n'
  );
}

export const isInit = (e) => !!e && e.type === 'system' && e.subtype === 'init';
export const isResult = (e) => !!e && e.type === 'result';

// A string, or a `result` event (its `result` text).
export function isUsageLimit(textOrEvent) {
  const text = typeof textOrEvent === 'string' ? textOrEvent : textOrEvent && textOrEvent.result;
  return typeof text === 'string' && USAGE_LIMIT.test(text);
}

export function toolResultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .filter((b) => b && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  return '';
}

// For a tool_result block: the guard's deny text when it is one, otherwise null.
export function guardDenial(toolResult) {
  if (!toolResult || toolResult.is_error !== true) return null;
  const text = toolResultText(toolResult);
  return GUARD_DENIAL_PATTERN.test(text.slice(0, GUARD_DENIAL_WINDOW)) ? text : null;
}

function asObject(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

// UNVERIFIED (chat test Q8): where a hook's systemMessage sits in the event. Looks at the event itself, at
// `output`/`stdout`/`data` (an object or a JSON string). Returns the text or null.
export function hookSystemMessage(event) {
  if (!event || event.type !== 'system') return null;
  for (const holder of [
    event,
    asObject(event.output),
    asObject(event.stdout),
    asObject(event.data),
  ]) {
    if (holder && typeof holder.systemMessage === 'string' && holder.systemMessage)
      return holder.systemMessage;
  }
  return null;
}

// { kind: 'reminder' | 'notice', banner?: 'fail-open' | 'lost-task' }
export function classifyHookMessage(text) {
  if (text.startsWith('Shipline reminder:')) return { kind: 'reminder' };
  if (FAIL_OPEN_PATTERN.test(text)) return { kind: 'notice', banner: 'fail-open' };
  if (LOST_TASK_PATTERN.test(text)) return { kind: 'notice', banner: 'lost-task' };
  return { kind: 'notice' };
}
