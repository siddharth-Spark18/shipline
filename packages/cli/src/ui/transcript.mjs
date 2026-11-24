// Reads Claude's own session file so a reopened chat shows its history, terminal turns included, as chat-log entries.
// Ported from the v1 hub (removed). Node 20+, no dependencies.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { encodePath } from '../store.mjs';
import { DENIED_TEXT, INTERRUPTED_NOTICE, INTERRUPTED_TEXT, capText } from './chat-log.mjs';
import { guardDenial, toolResultText } from './stream.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_LIMIT = 200;
const READ_CHUNK = 64 * 1024;

// Read on every call so CLAUDE_CONFIG_DIR changes (tests) take effect.
const projectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// <projects>/<repo path with every non-alphanumeric character replaced by "-">/<id>.jsonl, then a scan of
// projects/*/ for <id>.jsonl.
export function findTranscript(root, sessionId) {
  if (!SESSION_ID.test(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  const dir = projectsDir();
  const direct = path.join(dir, encodePath(root), file);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(dir)) {
      const candidate = path.join(dir, d, file);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No Claude projects dir: nothing to show.
  }
  return null;
}

// Changes when the session file does (size and mtime), or '' when there is none. A cached log built from the
// file is reused while this stays the same.
export function transcriptSignature(root, sessionId) {
  const file = findTranscript(root, sessionId);
  if (!file) return '';
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

// The lines of a file, one at a time, read in chunks (a session file can be large).
function* fileLines(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n === 0) break;
      rest += decoder.write(buf.subarray(0, n));
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        yield rest.slice(0, i);
        rest = rest.slice(i + 1);
      }
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function summarize(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const s = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? '';
  const text = typeof s === 'string' && s ? s : '';
  return `${name}${text ? `: ${text}` : ''}`.slice(0, SUMMARY_LIMIT);
}

const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-stdout>([^]*?)(?:<\/local-command-stdout>)?\s*$/;

// How Claude Code records a slash command: `<command-message>name</command-message>\n<command-name>/name</command-name>
// \n<command-args>args</command-args>`. Shown as what the user typed (`/name args`).
function commandText(text) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!name) return text;
  const args = /<command-args>([^]*?)<\/command-args>/.exec(text);
  const cmd = name[1].trim();
  return `${cmd.startsWith('/') ? cmd : `/${cmd}`} ${args ? args[1].trim() : ''}`.trim();
}

// One user message's text -> the entries it stands for.
function userTextEntries(text, out) {
  const t = text.trim();
  if (!t) return;
  const stdout = LOCAL_COMMAND_OUTPUT.exec(text);
  if (stdout) {
    if (stdout[1].trim()) out.push({ type: 'notice', level: 'info', text: stdout[1].trim() });
    return;
  }
  if (t === INTERRUPTED_TEXT) out.push({ type: 'notice', level: 'info', text: INTERRUPTED_NOTICE });
  else out.push({ type: 'user', text: commandText(t) });
}

const isBase64Image = (b) =>
  b &&
  b.type === 'image' &&
  b.source &&
  b.source.type === 'base64' &&
  typeof b.source.data === 'string';

// The chat as log entries (without pos and ver), in file order. Entries made from a line that has a `uuid` carry
// `key: '<uuid>:<block index>'`.
//   { entries: [...] }, an empty list when the file doesn't exist yet, or { unavailable: true } when the file has lines
//   but none of them parse.
// Tool calls that never got a result are reported in a last `tools_cancelled` entry: all of them, unless the chat is
// `running` and `busy` (it is mid-turn), when only the ones from the current turn (after the last user message) stay open.
export function readEntries(root, sessionId, { running = false, busy = false } = {}) {
  const file = findTranscript(root, sessionId);
  if (!file) return { entries: [] };
  const out = [];
  const toolIndex = new Map(); // tool_use id -> index in `out`
  const resolved = new Set();
  let lastUser = -1;
  let lines = 0;
  let parsed = 0;
  try {
    for (const line of fileLines(file)) {
      if (!line.trim()) continue;
      lines++;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || typeof e !== 'object') continue;
      parsed++;
      if (e.isSidechain || e.isMeta || !e.message || !e.message.content) continue;
      const uuid = typeof e.uuid === 'string' ? e.uuid : null;
      const content = e.message.content;
      const push = (entry, bi) => {
        const at =
          out.push(uuid && bi !== undefined ? { ...entry, key: `${uuid}:${bi}` } : entry) - 1;
        if (entry.type === 'user') lastUser = at;
        return at;
      };
      if (e.type === 'assistant' && Array.isArray(content)) {
        content.forEach((b, bi) => {
          if (!b) return;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim())
            push({ type: 'text', text: b.text }, bi);
          else if (b.type === 'tool_use') {
            const at = push(
              { type: 'tool_use', id: b.id, name: b.name, input: summarize(b.name, b.input) },
              bi,
            );
            if (typeof b.id === 'string') toolIndex.set(b.id, at);
          }
        });
      } else if (e.type === 'user') {
        if (e.isCompactSummary === true) {
          const text = textOf(content).trim();
          if (text) push({ type: 'compact', text });
          continue;
        }
        let images = 0;
        if (Array.isArray(content)) {
          content.forEach((b, bi) => {
            if (b && b.type === 'tool_result') {
              const text = toolResultText(b);
              const isError = b.is_error === true;
              const blocked = Boolean(guardDenial(b));
              const denied = !blocked && isError && text.includes(DENIED_TEXT);
              const entry = {
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                text: capText(text),
                isError,
              };
              if (blocked) entry.outcome = 'blocked';
              else if (denied) entry.outcome = 'denied';
              push(entry, bi);
              if (typeof b.tool_use_id === 'string') resolved.add(b.tool_use_id);
              if (blocked) push({ type: 'notice', level: 'blocked', text });
            } else if (isBase64Image(b)) {
              push({
                type: 'image',
                ref: uuid ? `t:${uuid}:${images}` : null,
                media_type: b.source.media_type,
              });
              images++;
            }
          });
        }
        const texts = [];
        userTextEntries(textOf(content), texts);
        for (const t of texts) push(t);
      }
    }
  } catch {
    return { unavailable: true };
  }
  if (lines > 0 && parsed === 0) return { unavailable: true };
  const cancelled = [];
  for (const [id, at] of toolIndex) {
    if (resolved.has(id)) continue;
    if (running && busy && at > lastUser) continue;
    cancelled.push(id);
  }
  if (cancelled.length) out.push({ type: 'tools_cancelled', ids: cancelled });
  return { entries: out };
}

// { media_type, data } of the `index`-th image of the transcript line whose uuid is `uuid`, or null.
export function readTranscriptImage(root, sessionId, uuid, index) {
  const file = findTranscript(root, sessionId);
  if (!file || !uuid) return null;
  try {
    for (const line of fileLines(file)) {
      if (!line.includes(uuid)) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || e.uuid !== uuid || !e.message || !Array.isArray(e.message.content)) continue;
      const imgs = e.message.content.filter(isBase64Image);
      const img = imgs[index];
      return img ? { media_type: img.source.media_type, data: img.source.data } : null;
    }
  } catch {
    // Unreadable: no image.
  }
  return null;
}
