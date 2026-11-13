// Turns Claude Code's stream-json events (and the server's history entries) into timeline items.
// Unknown event types and odd shapes are ignored, never thrown on.

import type { ImageData } from '@/lib/types';

export type NoticeLevel = 'blocked' | 'reminder' | 'notice' | 'denied' | 'usage-limit' | 'info';

export type Item =
  | { kind: 'user'; id: string; text: string; images?: ImageData[] }
  /** An image from history, shown like a user message (it came with the user text next to it). */
  | { kind: 'image'; id: string; media_type: string; data: string }
  /** A `!` command run: this page session only, never in history. */
  | {
      kind: 'shell';
      id: string;
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
      /** Set while the text comes from `stream_event` partials; replaced by the final message. */
      streaming?: { msgId: string; done: boolean };
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: { text: string; isError: boolean };
      outcome?: 'blocked' | 'denied';
    }
  | { kind: 'notice'; id: string; level: NoticeLevel; text: string };

export interface ChatResult {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError: boolean;
}

/** Per-chat bookkeeping that the reducer needs between events. */
export interface StreamCtx {
  /** Tools the developer denied on a card, oldest first, waiting for their tool result. */
  denied: string[];
  /** Message id from the latest `message_start` partial. */
  curMsg: string | null;
  /** History entries: plain user strings are real user messages there. */
  history: boolean;
}

export function newCtx(history = false): StreamCtx {
  return { denied: [], curMsg: null, history };
}

const DENIED_TEXT = 'Denied by the developer in Shipline UI';
const USAGE_LIMIT = /usage limit|limit reached|rate limit/i;

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Epoch ms from a number (ms or s) or a date string. NaN when unreadable. */
export function toMs(v: number | string): number {
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  return Date.parse(v);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRec(b) && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** The `<Event>:<Tool> says: ` prefix Claude adds to a hook message in a `system`/`informational` event. */
const INFORMATIONAL_PREFIX = /^[A-Za-z]+(?::[^\s:]+)? says: /;

/**
 * A hook `systemMessage` in an event. Verified 2026-11-05 (claude 2.1.317): it arrives as
 * `{ type: 'system', subtype: 'informational', content: '<Event>:<Tool> says: <message>' }`.
 */
export function hookMessage(ev: Rec): string | null {
  const direct = asStr(ev.systemMessage);
  if (direct) return direct;
  if (ev.type === 'system') {
    const content = asStr(ev.content);
    if (ev.subtype === 'informational' && content) return content.replace(INFORMATIONAL_PREFIX, '');
    for (const key of ['output', 'stdout']) {
      const raw = asStr(ev[key]);
      if (!raw || !raw.includes('systemMessage')) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRec(parsed) && typeof parsed.systemMessage === 'string') return parsed.systemMessage;
      } catch {
        // not JSON; fall through
      }
    }
  }
  return null;
}

/** What Claude Code writes as a user message when a turn is interrupted (verified on claude 2.1.323). */
const INTERRUPTED_TEXT = '[Request interrupted by user]';
const INTERRUPTED_NOTICE = 'Interrupted';

const interruptedNotice = (): Item => ({
  kind: 'notice',
  id: nextId('n'),
  level: 'info',
  text: INTERRUPTED_NOTICE,
});

const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-stdout>/;

function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blockText(content);
}

function replaceAt(out: Item[], index: number, item: Item) {
  out[index] = item;
}

function streamPartial(out: Item[], se: unknown, ctx: StreamCtx) {
  if (!isRec(se)) return;
  const index = asNum(se.index) ?? 0;
  switch (se.type) {
    case 'message_start': {
      ctx.curMsg = isRec(se.message) ? (asStr(se.message.id) ?? null) : null;
      return;
    }
    case 'message_stop':
      ctx.curMsg = null;
      return;
    case 'content_block_start': {
      const block = se.content_block;
      if (!isRec(block) || block.type !== 'text' || !ctx.curMsg) return;
      out.push({
        kind: 'text',
        id: `s:${ctx.curMsg}:${index}`,
        text: asStr(block.text) ?? '',
        streaming: { msgId: ctx.curMsg, done: false },
      });
      return;
    }
    case 'content_block_delta': {
      const delta = se.delta;
      if (!isRec(delta) || delta.type !== 'text_delta' || !ctx.curMsg) return;
      const id = `s:${ctx.curMsg}:${index}`;
      const at = out.findIndex((i) => i.kind === 'text' && i.id === id);
      const cur = out[at];
      if (cur && cur.kind === 'text') {
        replaceAt(out, at, { ...cur, text: cur.text + (asStr(delta.text) ?? '') });
      }
      return;
    }
    case 'content_block_stop': {
      if (!ctx.curMsg) return;
      const id = `s:${ctx.curMsg}:${index}`;
      const at = out.findIndex((i) => i.kind === 'text' && i.id === id);
      const cur = out[at];
      if (cur && cur.kind === 'text' && cur.streaming) {
        replaceAt(out, at, { ...cur, streaming: { ...cur.streaming, done: true } });
      }
      return;
    }
    default:
      return;
  }
}

function assistantEvent(out: Item[], ev: Rec) {
  const msg = ev.message;
  if (!isRec(msg)) return;
  const msgId = asStr(msg.id);
  const blocks =
    typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!isRec(block)) continue;
    if (block.type === 'text') {
      const text = asStr(block.text) ?? '';
      if (!text.trim()) continue;
      // The final text replaces the partial it was streamed as, in place. Claude 2.1.318 sends the
      // `assistant` event for a block *before* that block's content_block_stop, so the partial may not
      // be marked done yet; matching only finished partials showed every streamed text twice.
      const at = out.findIndex(
        (i) => i.kind === 'text' && i.streaming !== undefined && i.streaming.msgId === msgId,
      );
      const final: Item = { kind: 'text', id: nextId('a'), text };
      if (at >= 0) out[at] = final;
      else out.push(final);
    } else if (block.type === 'tool_use') {
      const id = asStr(block.id) ?? nextId('t');
      const item: Item = {
        kind: 'tool',
        id,
        name: asStr(block.name) ?? 'tool',
        input: block.input,
      };
      const at = out.findIndex((i) => i.kind === 'tool' && i.id === id);
      if (at >= 0) replaceAt(out, at, item);
      else out.push(item);
    }
  }
}

function userEvent(out: Item[], ev: Rec, ctx: StreamCtx) {
  const msg = ev.message;
  if (!isRec(msg) || ev.isMeta === true) return;
  // Claude replays the output of a local command (for example `/model`) as a user event: not a message.
  if (ev.isReplay === true && LOCAL_COMMAND_OUTPUT.test(firstText(msg.content))) return;
  if (firstText(msg.content).trim() === INTERRUPTED_TEXT) {
    out.push(interruptedNotice());
    return;
  }
  if (typeof msg.content === 'string') {
    // Live: the composer already added the message. History: this is the real thing.
    if (ctx.history && msg.content.trim())
      out.push({ kind: 'user', id: nextId('u'), text: msg.content });
    return;
  }
  if (!Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (!isRec(block)) continue;
    if (block.type === 'image' && ctx.history && isRec(block.source)) {
      const data = asStr(block.source.data);
      const mt = asStr(block.source.media_type);
      if (data && mt) out.push({ kind: 'image', id: nextId('i'), media_type: mt, data });
      continue;
    }
    if (block.type === 'text' && ctx.history) {
      const text = asStr(block.text) ?? '';
      if (text.trim()) out.push({ kind: 'user', id: nextId('u'), text });
      continue;
    }
    if (block.type !== 'tool_result') continue;
    const text = blockText(block.content);
    const isError = block.is_error === true;
    const toolId = asStr(block.tool_use_id);
    const at = out.findIndex((i) => i.kind === 'tool' && i.id === toolId);
    const tool = out[at];
    const name = tool && tool.kind === 'tool' ? tool.name : undefined;

    let outcome: 'blocked' | 'denied' | undefined;
    if (text.includes('Shipline (')) {
      // The guard's deny reason; the `Shipline (` prefix is part of the hook interface.
      outcome = 'blocked';
    } else if (isError && text.includes(DENIED_TEXT)) {
      outcome = 'denied';
    } else if (isError && name) {
      // The prompt carries no tool_use_id: match the most recent denial for the same tool.
      const d = ctx.denied.lastIndexOf(name);
      if (d >= 0) {
        ctx.denied.splice(d, 1);
        outcome = 'denied';
      }
    }

    if (tool && tool.kind === 'tool')
      replaceAt(out, at, { ...tool, result: { text, isError }, outcome });
    if (outcome === 'blocked') {
      out.push({ kind: 'notice', id: nextId('n'), level: 'blocked', text });
    } else if (outcome === 'denied') {
      out.push({
        kind: 'notice',
        id: nextId('n'),
        level: 'denied',
        text: name ? `You denied ${name}.` : 'You denied this call.',
      });
    } else if (isError && text.includes('No answer within')) {
      out.push({ kind: 'notice', id: nextId('n'), level: 'notice', text });
    }
  }
}

function resultEvent(out: Item[], ev: Rec) {
  const text = asStr(ev.result) ?? '';
  const isError = ev.is_error === true || (asStr(ev.subtype) ?? '').startsWith('error');
  // The usage-limit message is already Claude's own text and the server's banner; any other error text that
  // repeats the last assistant text is not shown twice.
  const lastText = [...out].reverse().find((i) => i.kind === 'text');
  const repeated = lastText?.kind === 'text' && lastText.text.trim() === text.trim();
  if (isError && text) {
    if (!USAGE_LIMIT.test(text) && !repeated)
      out.push({ kind: 'notice', id: nextId('n'), level: 'info', text });
  } else if (isError) {
    // The result that follows an interrupt has no text and nothing to report beyond the notice before it.
    const prev = out[out.length - 1];
    const afterInterrupt =
      ev.subtype === 'error_during_execution' &&
      prev?.kind === 'notice' &&
      prev.text === INTERRUPTED_NOTICE;
    if (!afterInterrupt)
      out.push({
        kind: 'notice',
        id: nextId('n'),
        level: 'info',
        text: `Turn ended: ${asStr(ev.subtype) ?? 'error'}`,
      });
  }
  // Any partial that never got its final message stops being "streaming".
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (it.kind === 'text' && it.streaming) out[i] = { ...it, streaming: undefined };
  }
}

/** The cost/usage line source, from a `result` event. */
export function resultSummary(ev: unknown): ChatResult | null {
  if (!isRec(ev) || ev.type !== 'result') return null;
  const usage = isRec(ev.usage) ? ev.usage : {};
  return {
    costUsd: asNum(ev.total_cost_usd) ?? asNum(ev.cost_usd),
    durationMs: asNum(ev.duration_ms),
    turns: asNum(ev.num_turns),
    inputTokens: asNum(usage.input_tokens),
    outputTokens: asNum(usage.output_tokens),
    isError: ev.is_error === true,
  };
}

function itemKey(it: Item): string | null {
  switch (it.kind) {
    case 'tool':
      return `tool:${it.id}`;
    case 'user':
      return `user:${it.text.trim()}`;
    case 'text':
      return it.streaming && !it.streaming.done ? null : `text:${it.text.trim()}`;
    case 'notice':
      return `notice:${it.level}:${it.text.trim()}`;
    default:
      return null;
  }
}

const imageKey = (img: ImageData) =>
  `${img.media_type}:${img.data.length}:${img.data.slice(0, 64)}`;

/**
 * History (from Claude's session file) followed by live items, without the overlap. Live copies
 * win: they carry the running/result state. History items already seen live are dropped.
 */
export function mergeHistory(history: Item[], live: Item[]): Item[] {
  if (history.length === 0) return live;
  if (live.length === 0) return history;
  const liveKeys = new Set<string>();
  for (const it of live) {
    const k = itemKey(it);
    if (k) liveKeys.add(k);
  }
  // A live user message carries its images; the history copies of them are dropped too.
  const liveImages = new Set<string>();
  for (const it of live)
    if (it.kind === 'user') it.images?.forEach((i) => liveImages.add(imageKey(i)));
  return [
    ...history.filter(
      (it) =>
        !liveKeys.has(itemKey(it) ?? '') && !(it.kind === 'image' && liveImages.has(imageKey(it))),
    ),
    ...live,
  ];
}

/** Folds one stream-json event into the items. Returns a new array; `items` is not changed. */
export function applyEvent(items: Item[], ev: unknown, ctx: StreamCtx): Item[] {
  if (!isRec(ev)) return items;
  const out = [...items];
  const hook = hookMessage(ev);
  if (hook) {
    out.push({
      kind: 'notice',
      id: nextId('n'),
      level: hook.startsWith('Shipline reminder:') ? 'reminder' : 'notice',
      text: hook,
    });
  }
  // Sub-agent traffic (parent_tool_use_id set) stays out of the main timeline.
  const sidechain = ev.parent_tool_use_id != null;
  switch (ev.type) {
    case 'stream_event':
      if (!sidechain) streamPartial(out, ev.event, ctx);
      break;
    case 'assistant':
      if (!sidechain) assistantEvent(out, ev);
      break;
    case 'user':
      if (!sidechain) userEvent(out, ev, ctx);
      break;
    case 'result':
      resultEvent(out, ev);
      break;
    default:
      break; // system/init and unknown types: nothing to show
  }
  return out;
}

/**
 * History entries from GET /api/chats/<id>. The table gives no entry shape, so this accepts:
 * session-file lines (`{ type: 'user' | 'assistant', message }`), `{ role, text | content }`,
 * and `{ kind: 'tool_use' | 'tool', name, input | summary }`.
 */
export function normalizeHistory(history: unknown[] | null | undefined): Item[] {
  if (!history) return [];
  const ctx = newCtx(true);
  let items: Item[] = [];
  for (const entry of history) {
    if (!isRec(entry)) continue;
    if ((entry.type === 'user' || entry.type === 'assistant') && isRec(entry.message)) {
      items = applyEvent(items, entry, ctx);
    } else if (entry.role === 'user' || entry.role === 'assistant') {
      const text = asStr(entry.text) ?? blockText(entry.content);
      if (!text.trim()) continue;
      items.push(
        entry.role === 'user'
          ? { kind: 'user', id: nextId('u'), text }
          : { kind: 'text', id: nextId('a'), text },
      );
    } else if (entry.kind === 'user' || entry.kind === 'assistant') {
      // Server history shape (transcript.mjs): { kind, text }.
      const text = asStr(entry.text) ?? '';
      if (!text.trim()) continue;
      if (entry.kind === 'user' && text.trim() === INTERRUPTED_TEXT) {
        items.push(interruptedNotice());
        continue;
      }
      items.push(
        entry.kind === 'user'
          ? { kind: 'user', id: nextId('u'), text }
          : { kind: 'text', id: nextId('a'), text },
      );
    } else if (entry.kind === 'image') {
      // { kind: 'image', media_type, data } (transcript.mjs)
      const data = asStr(entry.data);
      const mt = asStr(entry.media_type);
      if (data && mt) items.push({ kind: 'image', id: nextId('i'), media_type: mt, data });
    } else if (entry.kind === 'tool-result') {
      // { kind: 'tool-result', toolUseId, text, isError, notice?: 'shipline-block' }
      const text = asStr(entry.text) ?? '';
      const isError = entry.isError === true;
      const outcome = entry.notice === 'shipline-block' ? 'blocked' : undefined;
      const at = items.findIndex((it) => it.kind === 'tool' && it.id === entry.toolUseId);
      const tool = at >= 0 ? items[at] : undefined;
      if (tool && tool.kind === 'tool') items[at] = { ...tool, result: { text, isError }, outcome };
      if (outcome === 'blocked')
        items.push({ kind: 'notice', id: nextId('n'), level: 'blocked', text });
    } else if (entry.kind === 'tool_use' || entry.kind === 'tool-use' || entry.kind === 'tool') {
      items.push({
        kind: 'tool',
        id: asStr(entry.id) ?? nextId('t'),
        name: asStr(entry.name) ?? asStr(entry.tool) ?? 'tool',
        input: entry.input ?? entry.summary,
      });
    }
  }
  return items;
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
