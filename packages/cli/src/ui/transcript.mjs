// Reads Claude's own session file so a reopened chat shows its history, terminal turns included.
// Copied from apps/local/src/server/transcript.ts. Node 20+, no dependencies.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardDenial, toolResultText } from './stream.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 500;
const SUMMARY_LIMIT = 200;

// Read on every call so CLAUDE_CONFIG_DIR changes (tests) take effect.
const projectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// <projects>/<repo path with every non-alphanumeric character replaced by "-">/<id>.jsonl, then a scan of
// projects/*/ for <id>.jsonl.
export function findTranscript(root, sessionId) {
  if (!SESSION_ID.test(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  const dir = projectsDir();
  const direct = path.join(dir, root.replace(/[^a-zA-Z0-9]/g, '-'), file);
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

// History items:
//   { kind: 'user', text }
//   { kind: 'assistant', text }
//   { kind: 'tool-use', id, name, summary }
//   { kind: 'tool-result', toolUseId, text, isError, notice?: 'shipline-block' }
// Returns { history: [...] } (an empty list when the file doesn't exist yet), or { unavailable: true } when the
// file has lines but none of them parse.
export function readHistory(root, sessionId) {
  const file = findTranscript(root, sessionId);
  if (!file) return { history: [] };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { unavailable: true };
  }
  const out = [];
  let lines = 0;
  let parsed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    parsed++;
    if (entry.isSidechain || entry.isMeta || !entry.message || !entry.message.content) continue;
    const content = entry.message.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          out.push({ kind: 'assistant', text: b.text });
        else if (b.type === 'tool_use')
          out.push({ kind: 'tool-use', id: b.id, name: b.name, summary: summarize(b.name, b.input) });
      }
    } else if (entry.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            const item = {
              kind: 'tool-result',
              toolUseId: b.tool_use_id,
              text: toolResultText(b),
              isError: b.is_error === true,
            };
            if (guardDenial(b)) item.notice = 'shipline-block';
            out.push(item);
          }
        }
      }
      const text = textOf(content).trim();
      if (text) out.push({ kind: 'user', text });
    }
  }
  if (lines > 0 && parsed === 0) return { unavailable: true };
  return { history: out.slice(-HISTORY_LIMIT) };
}
