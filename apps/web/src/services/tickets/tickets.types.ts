import {
  ChatRowDTO,
  CreateChatRequestDTO,
  CreateChatResultDTO,
  PrCommentDTO,
  Role,
  StageContextDTO,
  StageSummaryDTO,
  StageTransitionDTO,
  TicketPrCommentsDTO,
  TemplateSwitchDTO,
  TemplateSwitchDecisionResultDTO,
  TicketPrDTO,
  TransitionDecisionResultDTO,
} from '@shipline/shared';

export const ticketKeys = {
  chats: () => ['chats'] as const,
  detail: (id: string) => ['tickets', id] as const,
  audit: (id: string) => ['tickets', id, 'audit'] as const,
  toolDecisions: (id: string) => ['tickets', id, 'tool-decisions'] as const,
  transitions: (id: string) => ['tickets', id, 'transitions'] as const,
  templateSwitches: (id: string) => ['tickets', id, 'template-switches'] as const,
  prComments: (id: string) => ['tickets', id, 'pr-comments'] as const,
};

export type ChatRow = ChatRowDTO;
export type CreateChatInput = CreateChatRequestDTO;
export type CreateChatResult = CreateChatResultDTO;
export type PrComment = PrCommentDTO;
export type TicketPrComments = TicketPrCommentsDTO;
export type StageTransition = StageTransitionDTO;
export type TransitionDecisionResult = TransitionDecisionResultDTO;
export type TemplateSwitch = TemplateSwitchDTO;
export type TemplateSwitchDecisionResult = TemplateSwitchDecisionResultDTO;

export interface PersonRef {
  id: string;
  name: string;
}

export interface ArtifactMeta {
  version: number;
  type: 'MARKDOWN' | 'HTML' | 'FIGMA_LINK' | 'QA_REPORT' | 'PR_LINK';
  submittedBy: PersonRef;
  createdAt: string;
  pluginVersion: string | null;
  appVersion: string | null;
  committedPath: string | null;
}

export interface StageView extends StageSummaryDTO {
  id: string;
  artifacts: ArtifactMeta[];
}

export interface TicketDetail {
  id: string;
  /** Per-project key, e.g. LL-12. */
  key: string;
  /** The linked Jira ticket, if any. */
  jiraKey: string | null;
  title: string;
  jiraSummary: string | null;
  description: string;
  jiraUrl: string | null;
  jiraStatus: string | null;
  status: 'ACTIVE' | 'DONE';
  /** The template version the chat is pinned to; `latestVersion` is what new chats get. */
  template: { id: string; name: string; version: number; latestVersion: number; archived: boolean };
  project: { id: string; name: string; githubRepo: string; baseBranch: string; keyPrefix: string };
  owner: PersonRef & { githubLogin: string | null };
  isOwner: boolean;
  /** Null until the first file edit creates the named branch. */
  branch: string | null;
  worktreePath: string | null;
  started: boolean;
  currentStage: StageContextDTO | null;
  stages: StageView[];
  gates: { pass: boolean; overridden: boolean; lines: string[] };
  overrides: Array<{ id: string; kind: string; reason: string; admin: PersonRef; createdAt: string }>;
  pr: TicketPrDTO | null;
  newComments: number;
  pendingTransition: StageTransitionDTO | null;
  myAccess: { roles: Role[]; isAdmin: boolean };
}

export interface AuditEventRow {
  id: string;
  type: string;
  data: Record<string, unknown>;
  actor: PersonRef | null;
  createdAt: string;
}

export interface ToolDecisionRow {
  id: string;
  stage: string;
  tool: string;
  inputSummary: string;
  decision: 'ALLOW' | 'DENY' | 'PENDING';
  decidedBy: 'POLICY' | 'USER' | 'TIMEOUT';
  reason: string;
  user: PersonRef;
  pluginVersion: string | null;
  appVersion: string | null;
  createdAt: string;
}

export interface OverrideInput {
  reason: string;
  kind: 'GATES' | 'HOTFIX';
}

export interface RenameChatInput {
  title: string;
}

export interface DecideTransitionInput {
  transitionId: string;
  confirm: boolean;
}

export interface DecideTemplateSwitchInput {
  switchId: string;
  confirm: boolean;
}
