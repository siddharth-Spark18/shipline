import type { SessionMode } from './roles';
import type { PendingToolDecisionDTO } from './dto';
import type { StreamEvent } from './stream-json';

// DTOs of the Shipline Local browser API (127.0.0.1:4777), shared with the hub web app.

/** Unauthenticated probe: is the service up, and is this browser paired? */
export interface LocalHelloDTO {
  service: 'shipline-local';
  appVersion: string;
  pluginVersion: string;
}

export interface LocalPairRequestDTO {
  code: string;
}

export interface LocalPairResponseDTO {
  token: string;
}

export interface ClaudeHealthDTO {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  meetsMinVersion: boolean;
  minVersion: string | null;
  guidance: string | null;
}

export interface LocalStatusDTO {
  /** Whether the local service itself is signed in to the Shipline hub. */
  signedIn: boolean;
  apiUrl: string;
  appVersion: string;
  pluginVersion: string;
  claude: ClaudeHealthDTO;
  ghInstalled: boolean;
}

export interface LocalProjectSetupDTO {
  id: string;
  name: string;
  githubRepo: string;
  sessionMode: SessionMode;
  localPath: string | null;
  localSessionMode: SessionMode | null;
}

/** running: Claude is working a turn. waiting: a prompt or proposal needs the user. idle: neither. */
export type SessionState = 'running' | 'waiting' | 'idle';

export interface SessionRowDTO {
  ticketId: string;
  ticketKey: string;
  mode: SessionMode;
  state: SessionState;
  worktreePath: string;
  /** Null while the worktree is still detached (no file edit yet). */
  branch: string | null;
}

/** Messages pushed to the browser over the session WebSocket. */
export type SessionMessage =
  | { kind: 'event'; event: StreamEvent }
  | { kind: 'user-message'; text: string }
  | {
      kind: 'stage-change';
      stageKey: string | null;
      stageName: string | null;
      text: string;
      /** Set when a confirmed transition caused the change: drives the inline completion card. */
      transition?: { kind: 'complete' | 'skip' | 'reopen'; fromStageName: string };
    }
  /** A tool call denied by policy (e.g. a role limit); shown as a denied tool chip. */
  | { kind: 'tool-denied'; toolUseId: string | null; tool: string; reason: string }
  /** The named branch was created at the chat's first edit. */
  | { kind: 'branch'; branch: string }
  | { kind: 'tool-prompt'; prompt: PendingToolDecisionDTO }
  | { kind: 'tool-prompt-resolved'; id: string }
  | { kind: 'pty'; data: string }
  | { kind: 'usage-limit'; message: string }
  | { kind: 'fatal'; fatal: { kind: string; message: string; suggestTerminal: boolean } }
  | { kind: 'state'; state: SessionState }
  | { kind: 'diff-changed' }
  | { kind: 'exit'; code: number | null };

// --- Diff ---

export type DiffMode = 'branch' | 'uncommitted';
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFileDTO {
  path: string;
  /** Previous path for renames. */
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffSummaryDTO {
  mode: DiffMode;
  /** What the diff is measured against: the merge-base sha (branch) or HEAD (uncommitted). */
  base: string;
  baseBranch: string;
  files: DiffFileDTO[];
  additions: number;
  deletions: number;
}

export interface DiffLineDTO {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunkDTO {
  header: string;
  lines: DiffLineDTO[];
}

export interface DiffFileDetailDTO {
  path: string;
  binary: boolean;
  hunks: DiffHunkDTO[];
  /** True when the per-file line cap cut the patch; re-request with `full=1`. */
  truncated: boolean;
  totalLines: number;
}

// --- Assets ---

export type AssetKind = 'markdown' | 'html' | 'image' | 'text' | 'other';

export interface AssetMetaDTO {
  /** Path relative to the worktree. */
  path: string;
  name: string;
  kind: AssetKind;
  size: number;
}

export interface AssetContentDTO extends AssetMetaDTO {
  mime: string;
  /** utf8 text for markdown/html/text. */
  content: string | null;
  /** base64 for images. */
  base64: string | null;
  /** Absolute path, shown for kinds the viewer cannot render ("open in editor"). */
  absolutePath: string;
}

/**
 * Pure parser for the body of `git diff` output of ONE file (everything from the first `@@`).
 * Lines before the first hunk (headers) are ignored.
 */
export function parseUnifiedDiff(patch: string): DiffHunkDTO[] {
  const hunks: DiffHunkDTO[] = [];
  let current: DiffHunkDTO | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) current.lines.push({ type: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw.startsWith('-')) current.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw.startsWith(' ')) current.lines.push({ type: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return hunks;
}
