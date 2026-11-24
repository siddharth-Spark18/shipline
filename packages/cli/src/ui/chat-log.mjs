// The server-ordered log of one chat: every message block and server event is an entry with a `pos` (its 1-based place
// in the chat) and a `ver` (the log version it was last created or changed at). History from the transcript and the
// live stream-json events share this one shape, so a browser tab only has to fold entries in `pos` order.
// Node 20+, no dependencies.
import crypto from 'node:crypto';
import { toolResultText } from './stream.mjs';

// The last this-many entries stay in memory; older positions are read from the transcript again on demand.
export const MEMORY_ENTRIES = 2000;
export const DEFAULT_PAGE = 200;
const RESULT_TEXT_CAP = 20_000;

export const DENIED_TEXT = 'Denied by the developer in Shipline UI';
export const INTERRUPTED_TEXT = '[Request interrupted by user]';
export const INTERRUPTED_NOTICE = 'Interrupted';
const USAGE_LIMIT = /usage limit|limit reached|rate limit/i;

const isRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asStr = (v) => (typeof v === 'string' ? v : undefined);
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const capText = (s) =>
  s.length > RESULT_TEXT_CAP
    ? `${s.slice(0, RESULT_TEXT_CAP)}\n... (${s.length - RESULT_TEXT_CAP} more characters)`
    : s;

// Entry shapes (all also carry pos and ver):
//   { type: 'user', text, images?: [ref], from?: 'composer' | 'queue' }
//   { type: 'image', ref, media_type }                       history only: an image sent with a user message
//   { type: 'text', text, streaming?: true, done?: boolean, msgId? }
//   { type: 'tool_use', id, name, input }
//   { type: 'tool_result', toolUseId, text, isError, outcome?: 'blocked' | 'denied' }
//   { type: 'notice', level, text }
//   { type: 'compact', text }                                 a compact summary
//   { type: 'result', result: { costUsd?, durationMs?, turns?, inputTokens?, outputTokens?, isError } }
//   { type: 'tools_cancelled', ids }
// A change that only grows a streaming text block goes over SSE as { pos, ver, type: 'text', delta }.

// `history`: entries converted from the transcript (each may carry a `key`, `<uuid>:<block index>`, which live events
// are never added twice for). Their pos is 1..N in order and their ver is their pos.
export function createChatLog({
  history = [],
  epoch = crypto.randomBytes(6).toString('hex'),
} = {}) {
  let entries = []; // the last MEMORY_ENTRIES entries, in pos order
  let first = 1; // pos of entries[0]
  let version = 0;
  let evictedVer = 0; // the highest ver among entries dropped from memory
  const keys = new Set();
  const images = new Map(); // `l:<pos>:<i>` -> { media_type, data }
  const imagesOf = new Map(); // pos -> [refs], dropped with the entry

  function remember(entry) {
    entries.push(entry);
    if (entries.length > MEMORY_ENTRIES) {
      const gone = entries.shift();
      first = gone.pos + 1;
      evictedVer = Math.max(evictedVer, gone.ver);
      for (const ref of imagesOf.get(gone.pos) || []) images.delete(ref);
      imagesOf.delete(gone.pos);
    }
  }

  for (const h of history) {
    const { key, ...entry } = h;
    if (key) keys.add(key);
    version++;
    remember({ ...entry, pos: version, ver: version });
  }
  const historyCount = version;

  const at = (pos) => (pos >= first && pos < first + entries.length ? entries[pos - first] : null);

  const log = {
    epoch,
    historyCount,
    get version() {
      return version;
    },
    get firstPos() {
      return first;
    },
    get lastPos() {
      return first + entries.length - 1;
    },

    hasKey: (key) => keys.has(key),
    addKey: (key) => void keys.add(key),

    // Adds an entry at the end. `images` is [{ media_type, data }] stored with it; the entry gets their refs.
    // Returns the stored entry (never changed by the caller).
    append(entry, { key, images: imgs } = {}) {
      if (key) keys.add(key);
      const pos = (entries.length ? log.lastPos : first - 1) + 1;
      version++;
      const stored = { ...entry, pos, ver: version };
      if (imgs && imgs.length) {
        const refs = imgs.map((img, i) => {
          const ref = `l:${pos}:${i}`;
          images.set(ref, { media_type: img.media_type, data: img.data });
          return ref;
        });
        imagesOf.set(pos, refs);
        stored.images = refs;
      }
      remember(stored);
      return stored;
    },

    // Changes an entry in place (an `undefined` value removes the field) and bumps the version. null when the entry
    // is no longer in memory.
    update(pos, patch) {
      const cur = at(pos);
      if (!cur) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete cur[k];
        else cur[k] = v;
      }
      cur.ver = ++version;
      return cur;
    },

    get: at,
    last: () => (entries.length ? entries[entries.length - 1] : null),
    findLast: (pred) => {
      for (let i = entries.length - 1; i >= 0; i--) if (pred(entries[i])) return entries[i];
      return null;
    },

    // Every entry created or changed after `since`, or null when the client has to refetch (it is ahead of this
    // log, or an entry it would need has left memory).
    since(since) {
      if (!Number.isInteger(since) || since < 0 || since > version) return null;
      if (since < evictedVer) return null;
      return entries.filter((e) => e.ver > since);
    },

    // The last `limit` entries in memory with pos < before (default: all of them).
    slice(before, limit) {
      const end =
        before === undefined
          ? entries.length
          : Math.max(0, Math.min(entries.length, before - first));
      return entries.slice(Math.max(0, end - limit), end);
    },

    // { media_type, data } of an image sent live with a message, or null.
    image: (ref) => images.get(ref) || null,
  };
  return log;
}

// ---------- live events -> entries ----------

// A copy: an entry that changes again in the same step must still carry the ver it had when it was reported.
const wire = (e) => ({ ...e });

function resultSummary(ev) {
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

// Folds a chat's stream-json events and server events into its log. Each method returns the entries it created or
// changed, in the form the SSE message carries them (a streaming text growth is { pos, ver, type: 'text', delta }).
export function createFolder(log) {
  let curMsg = null;
  const streams = new Map(); // `${msgId}:${index}` -> pos, while the partial text has no final message yet
  const toolPos = new Map(); // tool_use id -> pos
  const toolNames = new Map();
  const open = new Set(); // tool_use ids with no tool_result yet

  const notice = (out, level, text) => out.push(wire(log.append({ type: 'notice', level, text })));

  function streamPartial(out, se) {
    if (!isRec(se)) return;
    const index = asNum(se.index) ?? 0;
    switch (se.type) {
      case 'message_start':
        curMsg = isRec(se.message) ? (asStr(se.message.id) ?? null) : null;
        return;
      case 'message_stop':
        curMsg = null;
        return;
      case 'content_block_start': {
        const block = se.content_block;
        if (!isRec(block) || block.type !== 'text' || !curMsg) return;
        const e = log.append({
          type: 'text',
          text: asStr(block.text) ?? '',
          streaming: true,
          done: false,
          msgId: curMsg,
        });
        streams.set(`${curMsg}:${index}`, e.pos);
        out.push(wire(e));
        return;
      }
      case 'content_block_delta': {
        const d = se.delta;
        if (!isRec(d) || d.type !== 'text_delta' || !curMsg) return;
        const pos = streams.get(`${curMsg}:${index}`);
        const cur = pos === undefined ? null : log.get(pos);
        const delta = asStr(d.text) ?? '';
        if (!cur || !delta) return;
        const e = log.update(pos, { text: cur.text + delta });
        out.push({ pos: e.pos, ver: e.ver, type: 'text', delta });
        return;
      }
      case 'content_block_stop': {
        const pos = curMsg ? streams.get(`${curMsg}:${index}`) : undefined;
        const cur = pos === undefined ? null : log.get(pos);
        if (cur && cur.streaming) out.push(wire(log.update(pos, { done: true })));
        return;
      }
      default:
    }
  }

  function assistant(out, ev) {
    const msg = ev.message;
    if (!isRec(msg)) return;
    const msgId = asStr(msg.id);
    const blocks =
      typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, bi) => {
      if (!isRec(block)) return;
      const key = asStr(ev.uuid) ? `${ev.uuid}:${bi}` : null;
      if (key && log.hasKey(key)) return; // already in the log (from the transcript)
      if (block.type === 'text') {
        const text = asStr(block.text) ?? '';
        if (!text.trim()) return;
        // The final text replaces the partial it was streamed as, in place. The `assistant` event for a block can
        // come before that block's content_block_stop, so a partial counts as soon as it has no final text.
        let hit = null;
        for (const [k, pos] of streams) {
          const cur = log.get(pos);
          if (cur && cur.msgId === msgId) {
            hit = [k, pos];
            break;
          }
        }
        if (hit) {
          streams.delete(hit[0]);
          out.push(wire(log.update(hit[1], { text, streaming: undefined, done: undefined })));
        } else out.push(wire(log.append({ type: 'text', text })));
        if (key) log.addKey(key);
      } else if (block.type === 'tool_use') {
        const id = asStr(block.id) ?? `t${log.version + 1}`;
        const entry = {
          type: 'tool_use',
          id,
          name: asStr(block.name) ?? 'tool',
          input: block.input,
        };
        toolNames.set(id, entry.name);
        const pos = toolPos.get(id);
        if (pos !== undefined && log.get(pos)) out.push(wire(log.update(pos, entry)));
        else {
          const e = log.append(entry);
          toolPos.set(id, e.pos);
          out.push(wire(e));
        }
        open.add(id);
        if (key) log.addKey(key);
      }
    });
  }

  function user(out, ev, notices) {
    const msg = ev.message;
    if (!isRec(msg) || ev.isMeta === true) return;
    const content = msg.content;
    const text = typeof content === 'string' ? content : userBlocksText(content);
    // Claude replays the output of a local command (for example `/model`) as a user event: not a message.
    if (ev.isReplay === true && /^\s*<local-command-stdout>/.test(text)) return;
    if (text.trim() === INTERRUPTED_TEXT) {
      notice(out, 'info', INTERRUPTED_NOTICE);
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if (!isRec(block) || block.type !== 'tool_result') return;
      const key = asStr(ev.uuid) ? `${ev.uuid}:${bi}` : null;
      if (key && log.hasKey(key)) return;
      const resultText = toolResultText(block);
      const isError = block.is_error === true;
      const toolUseId = asStr(block.tool_use_id);
      const name = toolUseId ? toolNames.get(toolUseId) : undefined;
      const forThis = (kind) => notices.find((n) => n.kind === kind && n.toolUseId === toolUseId);
      let outcome;
      if (forThis('shipline-block')) outcome = 'blocked';
      else if (forThis('you-denied') || (isError && resultText.includes(DENIED_TEXT)))
        outcome = 'denied';
      const entry = { type: 'tool_result', toolUseId, text: capText(resultText), isError };
      if (outcome) entry.outcome = outcome;
      out.push(wire(log.append(entry)));
      if (key) log.addKey(key);
      if (toolUseId) open.delete(toolUseId);
      if (outcome === 'blocked') notice(out, 'blocked', resultText);
      else if (outcome === 'denied')
        notice(out, 'denied', name ? `You denied ${name}.` : 'You denied this call.');
      else if (isError && resultText.includes('No answer within'))
        notice(out, 'notice', resultText);
    });
  }

  function result(out, ev) {
    const text = asStr(ev.result) ?? '';
    const isError = ev.is_error === true || (asStr(ev.subtype) ?? '').startsWith('error');
    // The usage-limit message is already Claude's own text and the server's banner; any other error text that
    // repeats the last assistant text is not shown twice.
    const lastText = log.findLast((e) => e.type === 'text');
    const repeated = Boolean(lastText) && lastText.text.trim() === text.trim();
    if (isError && text) {
      if (!USAGE_LIMIT.test(text) && !repeated) notice(out, 'info', text);
    } else if (isError) {
      // The result that follows an interrupt has no text and nothing to report beyond the notice before it.
      const prev = log.last();
      const afterInterrupt =
        ev.subtype === 'error_during_execution' &&
        prev &&
        prev.type === 'notice' &&
        prev.text === INTERRUPTED_NOTICE;
      if (!afterInterrupt) notice(out, 'info', `Turn ended: ${asStr(ev.subtype) ?? 'error'}`);
    }
    // Any partial that never got its final message stops being "streaming".
    for (const pos of streams.values()) {
      const cur = log.get(pos);
      if (cur && cur.streaming)
        out.push(wire(log.update(pos, { streaming: undefined, done: undefined })));
    }
    streams.clear();
    out.push(wire(log.append({ type: 'result', result: resultSummary(ev) })));
  }

  const folder = {
    // `notices` is what chat.mjs's annotate() found in the event (hook messages, guard blocks, your denials).
    ingest(ev, notices = []) {
      const out = [];
      for (const n of notices)
        if (n.kind === 'reminder' || n.kind === 'notice') notice(out, n.kind, n.text);
      // Sub-agent traffic (parent_tool_use_id set) stays out of the main timeline.
      const sidechain = ev.parent_tool_use_id != null;
      switch (ev.type) {
        case 'stream_event':
          if (!sidechain) streamPartial(out, ev.event);
          break;
        case 'assistant':
          if (!sidechain) assistant(out, ev);
          break;
        case 'user':
          if (!sidechain) user(out, ev, notices);
          break;
        case 'result':
          result(out, ev);
          out.push(...folder.cancelOpen());
          break;
        default:
      }
      return out;
    },

    // A message the server wrote to claude's stdin (from a tab or the queue).
    echo(text, imgs, from) {
      const e = log.append(
        { type: 'user', text, from },
        { images: imgs && imgs.length ? imgs : undefined },
      );
      return [wire(e)];
    },

    // Marks the tool calls that never got a result as cancelled (turn ended, interrupted, chat stopped or crashed).
    cancelOpen() {
      if (open.size === 0) return [];
      const ids = [...open];
      open.clear();
      return [wire(log.append({ type: 'tools_cancelled', ids }))];
    },
  };
  return folder;
}

function userBlocksText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isRec(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
