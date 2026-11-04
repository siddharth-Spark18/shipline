/**
 * Event model for `claude -p --output-format stream-json`.
 *
 * The CLI's stream-json format is not formally documented for direct use and may change, so
 * this is deliberately permissive: unknown event types are preserved as `UnknownEvent` rather
 * than treated as parse failures. Pin and test against `minClaudeCliVersion`.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  permissionMode?: string;
}
export interface SystemOtherEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
  [key: string]: unknown;
}
export interface AssistantEvent {
  type: 'assistant';
  session_id?: string;
  message: { id?: string; role: 'assistant'; content: ContentBlock[] };
}
export interface UserEvent {
  type: 'user';
  session_id?: string;
  message: { role: 'user'; content: ContentBlock[] | string };
}
export interface ResultEvent {
  type: 'result';
  subtype: string;
  is_error: boolean;
  result?: string;
  session_id?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}
export interface PartialStreamEvent {
  type: 'stream_event';
  session_id?: string;
  event: { type: string; delta?: { type: string; text?: string }; [key: string]: unknown };
}
export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type StreamEvent =
  | SystemInitEvent
  | SystemOtherEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | PartialStreamEvent
  | UnknownEvent;

export type ParseResult = { ok: true; event: StreamEvent } | { ok: false; error: string; line: string };

export function parseStreamLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, error: 'empty line', line };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'event has no string "type"', line };
    }
    return { ok: true, event: parsed as StreamEvent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON', line };
  }
}

/** Message written to stdin when running with `--input-format stream-json`. */
export function buildUserInputMessage(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

export function isSystemInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === 'system' && (e as { subtype?: string }).subtype === 'init';
}

const USAGE_LIMIT = /(usage limit|rate limit|limit reached|5-hour limit|weekly limit)/i;

export function isUsageLimitText(text: string | undefined): boolean {
  return !!text && USAGE_LIMIT.test(text);
}
