// Turns the chat's server-ordered log entries into timeline items. The server does the conversion (live stream-json
// events and the transcript alike); this only folds entries, in pos order, into what the message list shows.
// Unknown entry types are ignored, never thrown on.

import type { ChatEntry, NoticeLevel } from '@/lib/types';

export type { NoticeLevel };

export type Item =
  /** `images` are image references (GET /api/chats/<id>/images/<ref>), shown lazily. */
  | { kind: 'user'; id: string; text: string; images?: string[] }
  /** An image from history, shown like a user message (it came with the user text next to it). */
  | { kind: 'image'; id: string; ref: string | null; media_type: string }
  /** A `!` command run: this page session only, never in history. `afterPos` is the log position it follows. */
  | {
      kind: 'shell';
      id: string;
      afterPos: number;
      command: string;
      startedAt?: number | string;
      output: string;
      truncated: boolean;
      running: boolean;
      code?: number | null;
      signal?: string | null;
      durationMs?: number;
    }
  | {
      kind: 'text';
      id: string;
      text: string;
      /** True while the text still comes from `stream_event` partials; the final message replaces it. */
      streaming?: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: { text: string; isError: boolean };
      outcome?: 'blocked' | 'denied';
      /** The turn ended, was interrupted, or the chat stopped before this call got a result. */
      cancelled?: boolean;
    }
  | { kind: 'notice'; id: string; level: NoticeLevel; text: string }
  /** A compact summary: shown as a collapsed "Conversation compacted" notice. */
  | { kind: 'compact'; id: string; text: string };

export interface ChatResult {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Epoch ms from a number (ms or s) or a date string. NaN when unreadable. */
export function toMs(v: number | string): number {
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  return Date.parse(v);
}

/** The cost/usage line source: the last `result` entry. */
export function lastResult(entries: ChatEntry[]): ChatResult | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'result') return e.result;
  }
  return null;
}

/**
 * The items for a chat: its log entries folded in pos order (a tool_result joins its tool_use, a tools_cancelled
 * entry marks the calls that never got a result), with the page session's `!` command blocks after the position they were
 * started at. Never dedupes by text: a repeated "yes" is two messages.
 */
export function buildItems(
  entries: ChatEntry[],
  shells: Extract<Item, { kind: 'shell' }>[] = [],
): Item[] {
  const out: Item[] = [];
  const toolAt = new Map<string, number>();
  let s = 0;
  const flushShells = (pos: number) => {
    while (s < shells.length && shells[s].afterPos <= pos) out.push(shells[s++]);
  };
  if (entries.length > 0) flushShells(entries[0].pos - 1);
  for (const e of entries) {
    switch (e.type) {
      case 'user':
        out.push({
          kind: 'user',
          id: `e${e.pos}`,
          text: e.text,
          ...(e.images && e.images.length > 0 ? { images: e.images } : {}),
        });
        break;
      case 'image':
        out.push({ kind: 'image', id: `e${e.pos}`, ref: e.ref, media_type: e.media_type });
        break;
      case 'text':
        if (e.text.trim() || e.streaming)
          out.push({
            kind: 'text',
            id: `e${e.pos}`,
            text: e.text,
            ...(e.streaming && !e.done ? { streaming: true } : {}),
          });
        break;
      case 'tool_use': {
        const at = toolAt.get(e.id);
        const item: Item = { kind: 'tool', id: e.id, name: e.name, input: e.input };
        if (at !== undefined) out[at] = { ...(out[at] as Item), ...item };
        else {
          toolAt.set(e.id, out.length);
          out.push(item);
        }
        break;
      }
      case 'tool_result': {
        const at = toolAt.get(e.toolUseId);
        const tool = at === undefined ? undefined : out[at];
        if (tool && tool.kind === 'tool')
          out[at as number] = {
            ...tool,
            result: { text: e.text, isError: e.isError },
            outcome: e.outcome,
            cancelled: undefined,
          };
        break;
      }
      case 'tools_cancelled':
        for (const id of e.ids) {
          const at = toolAt.get(id);
          const tool = at === undefined ? undefined : out[at];
          if (tool && tool.kind === 'tool' && !tool.result)
            out[at as number] = { ...tool, cancelled: true };
        }
        break;
      case 'notice':
        out.push({ kind: 'notice', id: `e${e.pos}`, level: e.level, text: e.text });
        break;
      case 'compact':
        out.push({ kind: 'compact', id: `e${e.pos}`, text: e.text });
        break;
      default:
        break; // result and unknown types: nothing to show here
    }
    flushShells(e.pos);
  }
  while (s < shells.length) out.push(shells[s++]);
  return out;
}

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** One-line description of a tool call's input. */
export function inputSummary(name: string, input: unknown): string {
  if (typeof input === 'string') return clip(input);
  if (!isRec(input)) return '';
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = asStr(input[k]);
      if (v) return clip(v.split('\n')[0]);
    }
    return '';
  };
  switch (name) {
    case 'Bash':
      return pick('command');
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep':
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'Task':
      return pick('description');
    default:
      return pick('command', 'file_path', 'path', 'pattern', 'description');
  }
}
