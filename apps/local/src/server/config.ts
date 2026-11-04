import fs from 'fs';
import { CONFIG_DIR, CONFIG_FILE } from './paths';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

export type SessionModeName = 'chat' | 'terminal';

/** Where a chat's worktree lives on this machine (the hub only stores a copy for display). */
export interface WorkspaceInfo {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  /** Null while the worktree is detached (no file edit yet). */
  branch: string | null;
  baseBranch: string;
}

/**
 * Local app state. The tokens here are Shipline OAuth tokens only. Claude credentials are never
 * read, stored or relayed: Claude Code keeps its own login.
 */
export interface LocalConfig {
  apiUrl: string;
  /** The hub web app. It is the only browser origin allowed to call this service (strict CORS). */
  hubUrl: string;
  tokens: StoredTokens | null;
  /** sha256 of every pairing token issued to a browser; the tokens themselves live in the browser. */
  pairedTokenHashes: string[];
  /** projectId -> absolute path of the working copy */
  projectPaths: Record<string, string>;
  /** projectId -> user's own override of the project's default session mode */
  sessionModes: Record<string, SessionModeName>;
  /** ticketId -> worktree */
  workspaces: Record<string, WorkspaceInfo>;
  /** ticketId -> stage key Claude was last told about (to inject a message on resume if it moved on) */
  announcedStages: Record<string, string | null>;
}

function defaults(): LocalConfig {
  return {
    apiUrl: process.env.SHIPLINE_API_URL ?? 'http://localhost:3000',
    hubUrl: (process.env.SHIPLINE_CLIENT_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    tokens: null,
    pairedTokenHashes: [],
    projectPaths: {},
    sessionModes: {},
    workspaces: {},
    announcedStages: {},
  };
}

let cache: LocalConfig | null = null;

export function getConfig(): LocalConfig {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<LocalConfig>;
    cache = { ...defaults(), ...raw };
  } catch {
    cache = defaults();
  }
  if (process.env.SHIPLINE_API_URL) cache.apiUrl = process.env.SHIPLINE_API_URL;
  if (process.env.SHIPLINE_CLIENT_URL) cache.hubUrl = process.env.SHIPLINE_CLIENT_URL.replace(/\/$/, '');
  return cache;
}

export function saveConfig(patch: Partial<LocalConfig>): LocalConfig {
  const next = { ...getConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}
