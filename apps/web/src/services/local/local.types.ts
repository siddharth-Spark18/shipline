import {
  AssetContentDTO,
  AssetMetaDTO,
  DiffFileDetailDTO,
  DiffMode,
  DiffSummaryDTO,
  LocalHelloDTO,
  LocalProjectSetupDTO,
  LocalStatusDTO,
  SessionRowDTO,
} from '@shipline/shared';

export const localKeys = {
  hello: () => ['local', 'hello'] as const,
  status: () => ['local', 'status'] as const,
  projects: () => ['local', 'projects'] as const,
  sessions: () => ['local', 'sessions'] as const,
  diff: (ticketId: string, mode: DiffMode) => ['local', 'diff', ticketId, mode] as const,
  diffFile: (ticketId: string, mode: DiffMode, path: string, full: boolean) =>
    ['local', 'diff', ticketId, mode, 'file', path, full] as const,
  assetMeta: (ticketId: string, path: string) => ['local', 'asset-meta', ticketId, path] as const,
  asset: (ticketId: string, path: string) => ['local', 'asset', ticketId, path] as const,
};

export type LocalHello = LocalHelloDTO;
export type LocalStatus = LocalStatusDTO;
export type LocalProject = LocalProjectSetupDTO;
export type SessionRow = SessionRowDTO;
export type DiffSummary = DiffSummaryDTO;
export type DiffFileDetail = DiffFileDetailDTO;
export type AssetMeta = AssetMetaDTO;
export type AssetContent = AssetContentDTO;

export type SessionModeName = 'chat' | 'terminal';

/** unreachable: nothing answers on 127.0.0.1. needs-pairing: up, but this browser has no valid token. */
export type LocalConnectionState = 'checking' | 'unreachable' | 'needs-pairing' | 'ready';

export interface StartSessionInput {
  ticketId: string;
  mode?: SessionModeName;
  /** The new-chat screen's message: delivered to Claude as the chat's first turn. */
  firstMessage?: string;
}

export interface SendMessageInput {
  ticketId: string;
  text: string;
  /** Posts the text as a stage-change marker instead of a person's message. */
  marker?: {
    stageKey: string | null;
    stageName: string | null;
    /** Set for a confirmed transition: the chat shows an inline completion card. */
    transition?: { kind: 'complete' | 'skip' | 'reopen'; fromStageName: string };
  };
}

export interface SetPathInput {
  projectId: string;
  path: string;
}

export interface CloneInput {
  projectId: string;
  path: string;
  githubRepo: string;
}

export interface SetModeInput {
  projectId: string;
  mode: SessionModeName | null;
}

export interface ResolvePromptInput {
  ticketId: string;
  id: string;
  allow: boolean;
  /** AskUserQuestion only: question text -> chosen label(s) or the user's own text. */
  answers?: Record<string, string>;
}

export interface DiffFileInput {
  ticketId: string;
  mode: DiffMode;
  path: string;
  oldPath: string | null;
  full: boolean;
}
