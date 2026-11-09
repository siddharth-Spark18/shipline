// Types for the UI server API (see "API surface" in .claude/plans/shipline-local-ui.md).
// Keep in step with the table there; the server is implemented against the same table.

// --- Errors ---

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

// --- Status ---

/** 'pre-1.0': set up with a Shipline before 1.0 (uninstall, then init); the others compare interfaces. */
export type VersionState = 'same' | 'repo-older' | 'repo-newer' | 'pre-1.0';

/** Shape of `readRepoVersion` in packages/cli/src/interface.mjs. */
export interface VersionInfo {
  package?: string | null;
  interface: number;
  legacy?: boolean;
}

export interface Status {
  /** 'install' while no repo is installed (only `root`, `state` and `uiVersion` are then present). */
  mode?: 'repo' | 'install';
  /** Install mode only. */
  state?: InstallState;
  uiVersion: string | VersionInfo;
  repoVersion: VersionInfo;
  versionState: VersionState;
  root: string;
  /** The task store for this repo, outside the repo (under ~/.shipline). */
  storeDir: string;
  /** For a pre-1.0 repo, the guidance `upgrade` also gives (uninstall, then init); null otherwise. */
  versionMessage: string | null;
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

/** Named actions held back until the stage is done, matched on the parsed command. */
export interface ActionsBlock {
  actions: string[];
  [key: string]: unknown;
}

export type Block = ToolsBlock | BashBlock | ActionsBlock;

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
  /** The stage can't finish until `stage.mjs check` has run the configured commands on the current code. */
  checks?: boolean | null;
  /** Headings the artifact must contain, each with some text under it. */
  sections?: string[] | null;
  /** With confirm_to_advance: the stage still asks in `confirmations: light` mode. */
  checkpoint?: boolean | null;
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
  branch_pattern?: string | null;
  tracker?: string | null;
  /** `standard` (the default) asks at every confirm_to_advance stage; `light` only at checkpoint stages. */
  confirmations?: 'standard' | 'light' | null;
  commands?: {
    test?: string | null;
    lint?: string | null;
    build?: string | null;
    [key: string]: unknown;
  } | null;
  /** Names of the repo's own `.claude/skills/<name>`; edited in the Agents & skills section. */
  skills?: string[] | null;
  /** The pull-request check settings; edited in the CI check section. */
  ci?: {
    missing_block?: string | null;
    skip_label?: string | null;
    stale_checks?: string | null;
    [key: string]: unknown;
  } | null;
  /** `done` once /shipline-setup has run; not an editable field. */
  setup?: string | null;
  /** Always-on guardrails, rail id to deny | ask | off; edited in the Guardrails section. */
  rails?: { [rail: string]: string | null | undefined } | null;
  /** Extra commands that count as a deploy or a migration (plain prefixes). */
  rails_commands?: {
    deploy?: string[] | null;
    migrate?: string[] | null;
    [key: string]: unknown;
  } | null;
  /** Globs (relative to the repo root) that need a permission prompt to change. */
  protected_paths?: string[] | null;
  /** The Verify scope check: test, lint and CI files edited and files outside the plan. */
  scope_check?: {
    enabled?: boolean | null;
    sensitive_extra?: string[] | null;
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

/** One of Shipline's own agents. `excluded` + `installed` means the team's own file is kept instead. */
export interface ShiplineAgent {
  name: string;
  installed: boolean;
  excluded: boolean;
  /** SHA-256 of the installed `.claude/agents/<name>.md`, or null when the file is absent. */
  hash: string | null;
}

export interface SetupAgents {
  shipline: ShiplineAgent[];
  /** Names of the repo's own agents. */
  repo: string[];
}

export interface SetupSkills {
  repo: string[];
  selected: string[];
}

export interface SetupData {
  config: SetupFile<ConfigModel>;
  workflows: SetupFile<WorkflowModel>[];
  rules: SetupFile<never>[];
  agents: SetupAgents;
  skills: SetupSkills;
  /** SHA-256 of the raw `.shipline/bin/VERSION` text. */
  versionHash: string;
  ci: SetupCi;
  /** Shipped workflows this repo does not have yet. */
  addableWorkflows: { id: string; name: string; description: string }[];
  /** Whether the repo looks like it has a UI (the default of "Add shipped workflow"'s switch). */
  uiDetected: boolean;
}

/** POST /api/setup/add-workflow. New files only, so `baseHashes` is normally empty; the version hash must match. */
export interface AddWorkflowRequest {
  id: string;
  ui: boolean;
  baseVersionHash: string;
  baseHashes: Record<string, string | null>;
}

/** The pull-request check: its workflow file and config.yml's `ci:` values (defaults filled in). */
export interface SetupCi {
  installed: boolean;
  missing_block: CiMissingBlock;
  skip_label: string;
  /** SHA-256 of `.github/workflows/shipline.yml`, or null when it is absent. */
  workflowHash: string | null;
}

export type CiMissingBlock = 'fail-unless-label' | 'warn' | 'fail';

/** POST /api/setup/ci. `baseHashes` is keyed by `.shipline/config.yml` and `.github/workflows/shipline.yml`; null = absent. */
export interface CiChange {
  install: boolean;
  missing_block: CiMissingBlock;
  skip_label: string;
  baseVersionHash?: string;
  baseHashes: Record<string, string | null>;
}

export interface CiPreviewResponse {
  files: PreviewFile[];
}

/** POST /api/setup/agents. `baseHashes` is keyed by `.claude/agents/<name>.md`; null = must not exist. */
export interface AgentsChange {
  add?: string[];
  remove?: string[];
  baseVersionHash: string;
  baseHashes: Record<string, string | null>;
}

export interface AgentsPreviewResponse {
  files: PreviewFile[];
  version: { before: unknown; after: unknown };
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
  kind: SetupKind | 'agent' | 'ci';
  id?: string;
  /** Null for a removed agent or CI workflow file. */
  text: string | null;
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
  | { action: 'copy'; from: string; id: string }
  | { action: 'delete'; id: string }
  | { action: 'create'; id: string; name: string };

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

/** One command of the latest `stage.mjs check` run. `exit` is null when the command didn't start. */
export interface TaskCheckResult {
  name: string;
  command: string;
  exit: number | null;
  duration_ms: number;
  /** The last lines of the output (at most 40 lines or 4 KB). */
  tail: string;
  /** A failure the developer chose to live with. */
  accepted: boolean;
}

/** The latest check run recorded in the task, or null before the first run. */
export interface TaskChecks {
  ran_at: string | null;
  /** True when the code changed since the run. */
  stale: boolean;
  results: TaskCheckResult[];
  /** What the change touches (recorded by `stage.mjs check` when scope_check is on). */
  scope?: {
    changed: string[] | null;
    sensitive: string[];
    /** Null when unknown (the plan lists no files). */
    outside_plan: string[] | null;
  } | null;
}

export interface Task {
  /** Task folder: the absolute path of its store folder. Treat it as an opaque id. */
  dir: string;
  slug: string;
  title: string;
  workflow: string;
  branch: string;
  stages: TaskStage[];
  files: TaskFile[];
  checks: TaskChecks | null;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Change {
  path: string;
  oldPath?: string;
  /** Untracked files count as `added`. */
  status: ChangeStatus;
  /** Line counts; null for binary files. */
  additions: number | null;
  deletions: number | null;
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

export type BannerKind = 'version' | 'fail-open' | 'lost-task' | 'usage-limit' | 'watch' | 'trust';

export interface BannerEvent {
  id: string;
  kind: BannerKind;
  text: string;
  /** kind 'trust': the repo path Claude Code reported, exactly as it keys it in ~/.claude.json. */
  path?: string;
}

export interface ChatEvent {
  chatId: string;
  kind:
    'event' | 'fatal' | 'ended' | 'task' | 'orphans' | 'orphans-cleared' | 'controls' | 'context';
  event?: unknown;
  /** kind 'controls': the chat's current values, the model list, changes waiting for the turn to end, and an error to toast. */
  controls?: PickedControls;
  models?: ModelOption[];
  pending?: PickedControls | null;
  error?: string;
  /** kind 'context': the latest reading. */
  context?: ContextUsage;
  /** kind 'orphans': the process group that still has members after Stop. */
  pgid?: number;
  /** kind 'task': the task folder this chat's session got bound to. */
  taskDir?: string;
  reason?: 'parse' | 'exit' | 'resume-failed';
  code?: number | null;
  stderrTail?: string;
  resumeCommand?: string;
}

/** An image on the wire: base64 with no `data:` prefix. */
export interface ImageData {
  media_type: string;
  data: string;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** `manual` is what Claude Code calls `default`. */
export type PermissionModeValue = 'manual' | 'acceptEdits' | 'plan' | 'auto';

/** What is chosen so far; a key is missing when it was never picked (Claude's own settings apply). */
export interface PickedControls {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionModeValue;
}

/** One model from Claude's `initialize` response (only these fields are kept by the server). */
export interface ModelOption {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  supportedEffortLevels: EffortLevel[];
  supportsAutoMode: boolean;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  autoCompactThreshold: number;
  isAutoCompactEnabled: boolean;
  percentage: number;
  categories: { name: string; tokens: number }[];
}

/** GET /api/chat/controls. `models` is empty until a chat in this repo has run. */
export interface ChatControls extends PickedControls {
  models: ModelOption[];
  context: ContextUsage | null;
  pending: PickedControls | null;
}

export interface SetControlsResponse {
  controls: PickedControls;
  applied: 'now' | 'after-turn' | 'next-start';
}

/** One entry of GET /api/chat/commands. */
export interface ChatCommand {
  name: string;
  description: string;
  source: 'repo' | 'user' | 'builtin';
  kind: 'command' | 'skill';
}

/** SSE `shell` event: one step of a `!` command run. */
export interface ShellEvent {
  chatId: string;
  runId: string;
  kind: 'start' | 'output' | 'truncated' | 'exit';
  command?: string;
  startedAt?: number | string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  code?: number | null;
  signal?: string | null;
  durationMs?: number;
}

// --- Chat (Phase 2) ---

/** An entry of sessions.json, as returned by GET /api/chats. */
export interface ChatSummary {
  id: string;
  title: string;
  created: number | string;
  last_active: number | string;
  /** The chat's current task (the last one it bound to). */
  task_dir: string | null;
  /** Every task folder the chat has worked on, oldest first. */
  task_dirs?: string[];
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
  /** Whether the repo's tracker can be used in this chat; null when there is nothing to report. */
  ticket?: TicketStatus | null;
  /** The chat's tasks, oldest first, finished ones included. */
  tasks?: Task[];
}

/** Where a repo's tickets live: `none` (the default) skips the ticket stage. */
export type TrackerId = 'none' | 'github' | 'jira';

export type TrackerConnection = 'connected' | 'needs-auth' | 'failed' | 'missing';

export interface TicketStatus {
  tracker: 'jira' | 'github';
  status: TrackerConnection;
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

// --- Install wizard ---

export type InstallState = 'clean' | 'partial' | 'installed';

export interface InstallWorkflow {
  id: string;
  name: string;
  description: string;
  stages: { id: string; name: string; agent: string | null; condition: string | null }[];
}

export interface InstallAgent {
  name: string;
  description: string;
  /** '<workflow>.<stage>' of every shipped stage that names this agent; empty for a standalone agent. */
  usedBy: string[];
}

/** What the wizard sends: every field is required. */
export interface InstallSelection {
  workflows: string[];
  ui: boolean;
  agents: string[];
  clashes: Record<string, 'keep' | 'ours' | 'skip'>;
  stageAgents: Record<string, string | null>;
  skills: string[];
  commands: { test: string; lint: string; build: string };
  tracker: TrackerId;
  /** Optional: missing means standard. */
  confirmations?: 'standard' | 'light';
  /** Optional: missing means on. Off writes every rail as off and no protected paths. */
  guardrails?: 'on' | 'off';
  /** Optional: missing means the default pattern. */
  branchPattern?: string;
  ci: boolean;
}

export interface InstallInfo {
  root: string;
  isGit: boolean;
  state: InstallState;
  found: ('claude-md-block' | 'hooks')[];
  workflows: InstallWorkflow[];
  agents: InstallAgent[];
  repoAgents: string[];
  repoSkills: string[];
  detected: { test: string; lint: string; build: string; sources: Record<string, string> };
  trackerDefault: TrackerId;
  uiDetected: boolean;
  /** The branch pattern used when none is chosen. */
  branchPatternDefault: string;
  /** What `init --yes` would choose. */
  defaults: InstallSelection;
}

export interface InstallPreviewFile {
  path: string;
  action: 'create' | 'overwrite' | 'merge';
  /** For create and overwrite (not given for VERSION, which is computed when written). */
  text?: string;
  /** For merge. */
  diff?: DiffHunk[];
}

export interface InstallBase {
  settings: string | null;
  claudeMd: string | null;
}

export interface InstallPreview {
  files: InstallPreviewFile[];
  excluded: string[];
  collisions: string[];
  base: InstallBase;
}
