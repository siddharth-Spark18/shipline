import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContentBlock, SessionMessage, StreamEvent } from '@shipline/shared';

/** Where Claude Code keeps conversation transcripts (`<config>/projects/<encoded cwd>/<id>.jsonl`). */
const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

const MARKER = '[Shipline] ';

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: string | ContentBlock[] };
}

function findTranscript(worktreePath: string, sessionId: string): string | null {
  const file = `${sessionId}.jsonl`;
  // Claude Code encodes the cwd by replacing every non-alphanumeric character with '-'.
  const direct = path.join(PROJECTS_DIR, worktreePath.replace(/[^a-zA-Z0-9]/g, '-'), file);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const candidate = path.join(PROJECTS_DIR, dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No Claude projects dir: nothing to restore.
  }
  return null;
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Rebuilds the chat history the browser shows from Claude Code's own transcript of a resumed
 * conversation. The local service only keeps history in memory, so without this a restart (or a
 * chat/terminal switch) shows an empty chat even though Claude remembers everything.
 */
export function loadTranscriptHistory(worktreePath: string, sessionId: string, limit: number): SessionMessage[] {
  const file = findTranscript(worktreePath, sessionId);
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: SessionMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta || !entry.message?.content) continue;
    const content = entry.message.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      out.push({ kind: 'event', event: { type: 'assistant', message: entry.message } as unknown as StreamEvent });
    } else if (entry.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
        out.push({ kind: 'event', event: { type: 'user', message: entry.message } as unknown as StreamEvent });
        continue;
      }
      const text = textOf(content).trim();
      if (!text) continue;
      // Shipline's own stage messages go back in as markers; everything else is something the user
      // typed. A chat's first turn is "<what the user typed>\n\n[Shipline] ..." (see announceStage).
      const at = text.startsWith(MARKER) ? 0 : text.indexOf(`\n\n${MARKER}`);
      const typed = at < 0 ? text : text.slice(0, at).trim();
      if (typed) out.push({ kind: 'user-message', text: typed });
      if (at >= 0) out.push({ kind: 'stage-change', stageKey: null, stageName: null, text: text.slice(at).trim() });
    }
  }
  return out.slice(-limit);
}
