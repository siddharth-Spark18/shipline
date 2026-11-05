// `claude -p --output-format stream-json` lines and the helpers that read them. Ported from the v1 hub (removed).
// Node 20+, no dependencies.

// Event types the chat forwards. A valid JSON line with another `type` is logged and skipped.
export const KNOWN_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

// Verified 2026-11-05 (claude 2.1.317): the guard's denial arrives as a tool_result with is_error: true and the
// text `PreToolUse:Edit hook error: Shipline (…): …`, so the `Shipline (` prefix is inside the first 300 characters.
export const GUARD_DENIAL_PATTERN = /Shipline \(/;
const GUARD_DENIAL_WINDOW = 300;

// Verified 2026-11-05 (claude 2.1.317): a hook's systemMessage arrives as its own event,
// {type:'system', subtype:'informational', level:'notice', content:'<Event>:<Tool> says: <message>'}. There is no
// hook_response event for PreToolUse.
const INFORMATIONAL_PREFIX = /^[A-Za-z]+(?::[^\s:]+)? says: /;
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

// The line written to stdin with --input-format stream-json. Image blocks come first, then the text block
// (left out when the text is empty). `images` is [{ media_type, data }] with base64 data.
export function userMessage(text, images = []) {
  const content = images.map((i) => ({
    type: 'image',
    source: { type: 'base64', media_type: i.media_type, data: i.data },
  }));
  if (text || content.length === 0) content.push({ type: 'text', text });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
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

// The text of a hook's systemMessage, or null. Reads the `system`/`informational` event's `content` (prefix
// stripped), otherwise the event itself or `output`/`stdout`/`data` (an object or a JSON string).
export function hookSystemMessage(event) {
  if (!event || event.type !== 'system') return null;
  if (event.subtype === 'informational' && typeof event.content === 'string' && event.content)
    return event.content.replace(INFORMATIONAL_PREFIX, '');
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

// system/init.mcp_servers is [{ name, status: 'connected' | 'needs-auth' | 'failed', source }].
// -> 'connected' | 'needs-auth' | 'failed' | 'missing' for the Atlassian / Jira server, or null when there is no
// list yet (no system/init seen). Several matches: the first connected one wins, otherwise the first match.
export function jiraStatus(mcpServers) {
  if (!Array.isArray(mcpServers)) return null;
  const matches = mcpServers.filter(
    (s) => s && typeof s.name === 'string' && /atlassian|jira/i.test(s.name),
  );
  if (!matches.length) return 'missing';
  const hit = matches.find((s) => s.status === 'connected') || matches[0];
  return hit.status === 'connected' || hit.status === 'needs-auth' ? hit.status : 'failed';
}
