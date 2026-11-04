import { EditPolicy, GuardrailRule, GuardrailRuleInput, ProjectTemplateDTO, Role, RoleEditPolicies, SaveProjectTemplatesRequestDTO, StageStatus } from '@shipline/shared';

export const projectKeys = {
  all: () => ['projects'] as const,
  detail: (id: string) => ['projects', id] as const,
  board: (id: string) => ['projects', id, 'board'] as const,
  githubWarnings: (id: string) => ['projects', id, 'github-warnings'] as const,
  templates: (id: string) => ['projects', id, 'templates'] as const,
  guardrails: (id: string) => ['projects', id, 'guardrails'] as const,
};

export interface QaTarget {
  kind: 'preview_url' | 'local_run' | 'staging';
  url?: string;
  command?: string;
  notes?: string;
}

export interface Project {
  id: string;
  name: string;
  githubRepo: string;
  jiraProjectKey: string;
  /** Prefix of the project's chat keys (LL -> LL-12). */
  keyPrefix: string;
  commitArtifactsToRepo: boolean;
  artifactRepoPath: string;
  artifactBranch: string | null;
  qaTarget: QaTarget | null;
  minPluginVersion: string | null;
  minClaudeCliVersion: string | null;
  sessionMode: 'CHAT' | 'TERMINAL';
  baseBranch: string;
  editPolicy: RoleEditPolicies;
}

export interface ProjectMemberRow {
  userId: string;
  name: string;
  email: string;
  githubLogin: string | null;
  roles: Role[];
  isAdmin: boolean;
}

export interface ProjectDetail extends Project {
  members: ProjectMemberRow[];
  myAccess: { roles: Role[]; isAdmin: boolean };
}

export interface CreateProjectInput {
  name: string;
  githubRepo: string;
  jiraProjectKey: string;
  keyPrefix: string;
}

export type UpdateProjectInput = Partial<
  Omit<Project, 'id' | 'githubRepo' | 'editPolicy'> & { editPolicy: Record<Role, EditPolicy> }
>;

export interface UpsertMemberInput {
  email: string;
  roles: Role[];
  isAdmin: boolean;
}

export interface BoardChat {
  id: string;
  key: string;
  jiraKey: string | null;
  title: string;
  status: 'ACTIVE' | 'DONE';
  template: { id: string; name: string; version: number };
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | null;
  branch: string | null;
  owner: { id: string; name: string };
  currentStage: { key: string; name: string; status: StageStatus } | null;
}

export interface GithubWarning {
  login: string;
  name: string | null;
  message: string;
}

export interface GithubWarningsResponse {
  available: boolean;
  warnings: GithubWarning[];
}

export type ProjectTemplate = ProjectTemplateDTO;
export type SaveProjectTemplatesInput = SaveProjectTemplatesRequestDTO;

export interface ProjectGuardrails {
  /** The org baseline, read-only here. */
  inherited: GuardrailRule[];
  project: GuardrailRule[];
  roles: Record<Role, GuardrailRule[]>;
}

export interface CreateProjectRuleInput {
  scope: 'PROJECT' | 'ROLE';
  role?: Role;
  rule: GuardrailRuleInput;
}
