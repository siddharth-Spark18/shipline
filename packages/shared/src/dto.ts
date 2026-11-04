import type { Role, SessionMode, RoleEditPolicies } from './roles';
import type { ArtifactType, StageStatus, StageType, TransitionDecision, TransitionKind } from './stages';
import type { StageToolPolicy } from './policy';
import type { EffectiveRules } from './guardrails';
import type { CustomAgentDTO } from './agents';

/** Returned by GET /api/local/config — what Shipline Local needs before launching a session. */
export interface LocalConfigDTO {
  minPluginVersion: string | null;
  minClaudeCliVersion: string | null;
  latestPluginVersion: string;
  apiVersion: string;
}

export interface LocalProjectDTO {
  id: string;
  name: string;
  githubRepo: string;
  /** Prefix of this project's chat keys (e.g. "LL" for LL-12). */
  keyPrefix: string;
  /** Branch worktrees are created from and diffs are measured against. */
  baseBranch: string;
  sessionMode: SessionMode;
  roles: Role[];
  isAdmin: boolean;
  minPluginVersion: string | null;
  minClaudeCliVersion: string | null;
  qaTarget: unknown;
  editPolicy: RoleEditPolicies;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface TicketPrDTO {
  number: number;
  state: PullRequestState;
  url: string | null;
  title: string;
  headSha: string;
}

/** One row of the user's chat list (chat switcher, grouped by state in the UI). */
export interface ChatRowDTO {
  ticketId: string;
  /** Per-project key, e.g. LL-12. */
  key: string;
  /** The linked Jira ticket, if any. */
  jiraKey: string | null;
  title: string;
  projectId: string;
  projectName: string;
  /** The template (version) the chat is pinned to. */
  template: { id: string; name: string; version: number };
  status: 'ACTIVE' | 'DONE';
  currentStage: { key: string; name: string; status: StageStatus } | null;
  /** True once a Claude session exists for the chat (it can be resumed). */
  started: boolean;
  /** Null until the first file edit creates the named branch. */
  branch: string | null;
  pr: TicketPrDTO | null;
  newComments: number;
  hasPendingTransition: boolean;
  updatedAt: string;
}

export interface CreateChatRequestDTO {
  projectId: string;
  /** The first message: the chat's title is taken from it. */
  message: string;
  /** A template the project has enabled; the project's default when omitted. */
  templateId?: string;
}

export interface CreateChatResultDTO {
  ticketId: string;
  key: string;
  title: string;
}

export interface StageSummaryDTO {
  key: string;
  name: string;
  type: StageType;
  /** Name of the agent the stage names (plugin or custom), if any. */
  agentName: string | null;
  order: number;
  status: StageStatus;
  optional: boolean;
  requiredForGate: boolean;
  allowedRoles: Role[];
  artifactTypes: ArtifactType[];
  artifactCount: number;
  skippedReason: string | null;
  reopenedCount: number;
}

export interface StageContextDTO {
  key: string;
  name: string;
  type: StageType;
  /** Name of the agent the stage names (plugin or custom), if any. */
  agentName: string | null;
  status: StageStatus;
  allowedRoles: Role[];
  artifactTypes: ArtifactType[];
  toolPolicy: StageToolPolicy;
  instructions: string;
  optional: boolean;
}

export interface UpstreamArtifactDTO {
  stageKey: string;
  stageName: string;
  version: number;
  type: ArtifactType;
  content: string;
}

/** Everything Shipline Local needs to run the one Claude session of a chat. */
export interface TicketSessionContextDTO {
  ticketId: string;
  claudeSessionId: string | null;
  project: LocalProjectDTO;
  ticket: {
    /** Per-project key, e.g. LL-12. */
    key: string;
    /** The linked Jira ticket, if any (its details are the description). */
    jiraKey: string | null;
    title: string;
    description: string;
    url: string | null;
    /** Null until the first file edit creates the named branch. */
    branch: string | null;
    worktreePath: string | null;
    /** The name the branch will get at the first edit. */
    suggestedBranch: string;
  };
  /** The template version the chat is pinned to. */
  template: { id: string; name: string; version: number; latestVersion: number };
  /** null once every stage is finished. */
  currentStage: StageContextDTO | null;
  stages: StageSummaryDTO[];
  /** Other templates the chat could still switch to (empty once the branch exists). */
  switchableTemplates: Array<{ id: string; name: string; description: string }>;
  /** Guardrail rules at every level for this chat's project and current stage (written into the hooks' state file). */
  guardrails: EffectiveRules;
  /** Custom agents named by the pinned version's stages, for `claude --agents`. */
  customAgents: CustomAgentDTO[];
  /** Latest artifact of every DONE stage. */
  doneArtifacts: UpstreamArtifactDTO[];
}

/** One pending/decided stage-transition proposal (audit row + the inline chat card). */
export interface StageTransitionDTO {
  id: string;
  ticketId: string;
  kind: TransitionKind;
  fromStageKey: string;
  fromStageName: string;
  /** For `reopen`: the stage to go back to. */
  targetStageKey: string | null;
  targetStageName: string | null;
  proposedBy: 'claude' | 'user';
  reason: string;
  decision: TransitionDecision;
  createdAt: string;
  decidedAt: string | null;
}

/** Result of confirming/declining a proposal; `claudeMessage` is injected into the chat. */
export interface TransitionDecisionResultDTO {
  transition: StageTransitionDTO;
  currentStage: StageContextDTO | null;
  claudeMessage: string;
}

export type PrCommentKind = 'REVIEW' | 'REVIEW_COMMENT';

export interface PrCommentDTO {
  id: string;
  kind: PrCommentKind;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  /** Review verdict for REVIEW rows: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  reviewState: string | null;
  outdated: boolean;
  htmlUrl: string | null;
  createdAt: string;
  sentToClaudeAt: string | null;
}

export interface TicketPrCommentsDTO {
  pullRequest: TicketPrDTO | null;
  comments: PrCommentDTO[];
  newCount: number;
}

/** One question from Claude's `AskUserQuestion` tool input. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Question text -> chosen label(s) joined with ", ", or the user's own text. */
export type AskUserQuestionAnswers = Record<string, string>;

export interface PendingToolDecisionDTO {
  id: string;
  ticketId: string;
  stageKey: string;
  tool: string;
  inputSummary: string;
  reason: string;
  createdAt: string;
  /** Present when `tool` is `AskUserQuestion`: answer these instead of allow/deny. */
  questions?: AskUserQuestionItem[];
}

/**
 * What the hub's `approve_tool_use` returns. `shiplineBranch` is the hub's signal to Shipline Local
 * (its MCP proxy) to run `git switch -c <name>` in the chat's worktree BEFORE the allowed call
 * runs; the proxy strips it before the answer reaches Claude.
 */
export interface ApproveToolUseResultDTO {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
  shiplineBranch?: string;
}
