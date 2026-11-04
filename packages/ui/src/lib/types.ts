// Types for the UI server API (see "API surface" in .claude/plans/shipline-local-ui.md).
// Keep in step with the table there; the server is implemented against the same table.

// --- Errors ---

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

// --- Status ---

export type VersionState = 'same' | 'repo-older' | 'repo-newer';

/** Shape of `readRepoVersion` in packages/cli/src/interface.mjs. */
export interface VersionInfo {
  package?: string | null;
  interface: number;
  legacy?: boolean;
}

export interface Status {
  uiVersion: string | VersionInfo;
  repoVersion: VersionInfo;
  versionState: VersionState;
  root: string;
}

// --- Diff ---

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Set on removed lines whose trimmed text starts with `#` (textDiff, item 25). */
  comment?: boolean;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

// --- Setup ---

export type SetupKind = 'config' | 'workflow' | 'rules';

export type Enforcement = 'guide' | 'warn' | 'block';
export type StageCondition = 'ui_only';

export interface ToolsBlock {
  tools: string;
  allow_paths?: string[] | null;
  [key: string]: unknown;
}

export interface BashBlock {
  bash: string;
  [key: string]: unknown;
}

export type Block = ToolsBlock | BashBlock;

/** Unknown keys are kept in the object and shown read-only as "other fields (kept)". */
export interface StageModel {
  id: string;
  name?: string | null;
  artifact?: string | null;
  description?: string | null;
  optional?: boolean | null;
  confirm_to_advance?: boolean | null;
  condition?: StageCondition | null;
  agent?: string | null;
  enforcement?: Enforcement | null;
  blocks?: Block[] | null;
  [key: string]: unknown;
}

export interface WorkflowModel {
  id: string;
  name?: string | null;
  description?: string | null;
  branch_type?: string | null;
  stages?: StageModel[] | null;
  [key: string]: unknown;
}

export interface ConfigModel {
  artifact_root?: string | null;
  folder_pattern?: string | null;
  branch_pattern?: string | null;
  tracker?: string | null;
  commands?: {
    test?: string | null;
    lint?: string | null;
    build?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export type SetupModel = ConfigModel | WorkflowModel;

export interface SetupFileOk<M = SetupModel> {
  kind: SetupKind;
  id?: string;
  /** Present for YAML files (config, workflow); absent for rules files. */
  model?: M;
  raw: string;
  hash: string;
  parseError?: undefined;
}

export interface SetupFileBroken {
  kind: SetupKind;
  id?: string;
  raw: string;
  parseError: string;
  model?: undefined;
  hash?: undefined;
}

export type SetupFile<M = SetupModel> = SetupFileOk<M> | SetupFileBroken;

export interface SetupData {
  config: SetupFile<ConfigModel>;
  workflows: SetupFile<WorkflowModel>[];
  rules: SetupFile<never>[];
  agents: string[];
}

export interface SaveEntry {
  kind: SetupKind;
  id?: string;
  /** YAML files. */
  model?: SetupModel;
  /** Rules files. */
  text?: string;
  /** SHA-256 of the file when loaded; null means the file must not exist yet. */
  baseHash: string | null;
}

export interface SaveRequest {
  files: SaveEntry[];
}

/** Warnings carry `severity: 'warning'` (see setup-schema.mjs); everything else is an error. */
export interface ValidationIssue {
  path: string;
  message: string;
  severity?: 'warning';
}

export interface ImpactEntry {
  /** The open task (its folder or slug). */
  task: string | { dir?: string; slug?: string; title?: string };
  added: string[];
  removed: string[];
  reordered: boolean;
}

export interface PreviewFile {
  kind: SetupKind;
  id?: string;
  text: string;
  diff: DiffHunk[];
  removedComments: string[];
  errors: ValidationIssue[];
}

export interface PreviewResponse {
  files: PreviewFile[];
  impact: ImpactEntry[];
}

export interface SaveResponse {
  written: { kind: SetupKind; id?: string; hash: string }[];
}

export type WorkflowAction =
  { action: 'copy'; from: string; id: string } | { action: 'delete'; id: string };

// --- Tasks ---

export type StageStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface TaskStage {
  id: string;
  name: string;
  status: StageStatus;
  reason?: string;
  artifact?: string | null;
}

export interface TaskFile {
  name: string;
  size: number;
  mtime: number | string;
}

export interface Task {
  /** Task folder, relative to the repo root. */
  dir: string;
  slug: string;
  title: string;
  workflow: string;
  branch: string;
  stages: TaskStage[];
  files: TaskFile[];
}

export interface Change {
  path: string;
  oldPath?: string;
  /** One-character `git status --porcelain` codes. */
  index: string;
  worktree: string;
}

export interface TasksData {
  tasks: Task[];
  changes: Change[];
  configError?: string;
}

export type FileMode = 'content' | 'diff';

export type FileResponse =
  | { path: string; content: string }
  | { path: string; hunks: DiffHunk[] }
  | { path: string; binary: true };

// --- Diagnostics ---

/** Redacted by the server. Known fields are listed; anything else is shown as raw JSON. */
export interface Diagnostics {
  uiVersion?: string | VersionInfo;
  repoVersion?: VersionInfo;
  versionState?: VersionState;
  root?: string;
  watchMode?: string;
  watch?: { mode?: string } | string;
  log?: string[];
  logTail?: string[];
  [key: string]: unknown;
}

// --- SSE events ---

export type BannerKind = 'version' | 'fail-open' | 'lost-task' | 'usage-limit' | 'watch';

export interface BannerEvent {
  id: string;
  kind: BannerKind;
  text: string;
}

export interface ChatEvent {
  chatId: string;
  kind: 'event' | 'fatal' | 'ended' | 'task';
  event?: unknown;
  /** kind 'task': the task folder this chat's session got bound to. */
  taskDir?: string;
  reason?: 'parse' | 'exit' | 'resume-failed';
  code?: number | null;
  stderrTail?: string;
  resumeCommand?: string;
}

// --- Chat (Phase 2) ---

/** An entry of sessions.json, as returned by GET /api/chats. */
export interface ChatSummary {
  id: string;
  title: string;
  created: number | string;
  last_active: number | string;
  task_dir: string | null;
  status: 'active' | 'ended';
  /** Assumed optional extra: true while a turn is running (lets a reload keep the composer disabled). */
  busy?: boolean;
}

export interface ChatsResponse {
  chats: ChatSummary[];
}

/**
 * GET /api/chats/<id>. `history` is the server's reading of Claude's session file; its entry shape
 * is not in the API table, so it stays `unknown` and is normalized in pages/chat/timeline.ts.
 */
export interface ChatDetail {
  chat: ChatSummary;
  history: unknown[] | null;
  unavailable?: boolean;
}

export interface PromptAnswer {
  decision: 'allow' | 'deny';
  /** AskUserQuestion: { [question text]: label }, multi-select labels joined by ", ". */
  answers?: Record<string, string>;
}

export interface PromptEvent {
  id: string;
  chatId: string;
  tool: string;
  input: unknown;
  expiresAt: number | string;
}

export interface PromptResolvedEvent {
  id: string;
  outcome: 'allow' | 'deny' | 'timeout';
}
