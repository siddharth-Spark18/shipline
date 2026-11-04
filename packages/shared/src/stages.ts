import type { Role } from './roles';
import type { GuardrailRuleInput } from './guardrails';
import { STAGE_READ_ONLY_TOOLS, type StageToolPolicy } from './policy';

export const STAGE_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** A finished stage no longer blocks the ones after it. */
export const FINISHED_STAGE_STATUSES: readonly StageStatus[] = ['DONE', 'SKIPPED'];

export const isStageFinished = (status: StageStatus): boolean => FINISHED_STAGE_STATUSES.includes(status);

export const ARTIFACT_TYPES = ['MARKDOWN', 'HTML', 'FIGMA_LINK', 'QA_REPORT', 'PR_LINK'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const TRANSITION_KINDS = ['complete', 'skip', 'reopen'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export const TRANSITION_DECISIONS = ['PENDING', 'CONFIRMED', 'DECLINED', 'SUPERSEDED'] as const;
export type TransitionDecision = (typeof TRANSITION_DECISIONS)[number];

/**
 * Stage types are what the server and the local service treat specially (replacing the old hardcoded
 * stage keys). A built-in type keeps its behaviour wherever it sits in a template (at most one per
 * template); `custom` is instructions, guardrails and an artifact only.
 */
export const STAGE_TYPES = [
  'research',
  'plan',
  'wireframes',
  'build',
  'qa',
  'self_review',
  'raise_pr',
  'resolve_comments',
  'custom',
] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const BUILT_IN_STAGE_TYPES: readonly StageType[] = STAGE_TYPES.filter((t) => t !== 'custom');

export const STAGE_TYPE_LABELS: Record<StageType, string> = {
  research: 'Research',
  plan: 'Plan',
  wireframes: 'Wireframes',
  build: 'Build',
  qa: 'QA',
  self_review: 'Self-review',
  raise_pr: 'Raise PR',
  resolve_comments: 'Resolve PR comments',
  custom: 'Custom',
};

export const isStageType = (value: string): value is StageType => (STAGE_TYPES as readonly string[]).includes(value);

export interface StageTemplateDef {
  /** Unique within a template version. Built-in types use their type as the key; the key never changes across versions. */
  key: string;
  name: string;
  type: StageType;
  /**
   * Roles this stage is designed for (shown in the template view). It is informational: a stage is
   * never blocked for a role. What a role may do is decided per tool call (see `decideToolUse`),
   * which denies only the one call, with a reason.
   */
  allowedRoles: Role[];
  optional: boolean;
  /** Allowed artifact types for this stage; first entry is the default. */
  artifactTypes: ArtifactType[];
  /** Must be DONE or SKIPPED for the `shipline/gates` check to pass. */
  requiredForGate: boolean;
  toolPolicy: StageToolPolicy;
  /** Instruction injected into the chat when the stage starts. */
  instructions: string;
  /** `plugin:<agent name>` or `custom:<custom agent id>`; null when the stage names no agent. */
  agentRef: string | null;
  /** Guardrail rules that apply while this stage is current (stage level). */
  rules: GuardrailRuleInput[];
}

export interface WorkflowTemplateDef {
  name: string;
  description: string;
  stages: StageTemplateDef[];
}

const readOnly = (): StageToolPolicy => ({
  allowCodeEdit: false,
  allowedTools: STAGE_READ_ONLY_TOOLS,
  disallowedTools: [],
  permissionMode: 'default',
  bash: 'deny',
});

const working = (): StageToolPolicy => ({
  allowCodeEdit: true,
  allowedTools: STAGE_READ_ONLY_TOOLS,
  disallowedTools: [],
  permissionMode: 'default',
  bash: 'inherit',
});

// OPEN-QUESTION #12: which roles each stage is designed for is a judgment call (the plan only fixes
// "a Designer can do Research, Plan and Wireframes; Build and later are developer stages"). QA is
// open to Developers too because the chat owner runs QA (manually or via the QA agent) in the flow.
const PRODUCT_ROLES: Role[] = ['PM', 'DESIGNER', 'DEVELOPER'];
const DEV_ONLY: Role[] = ['DEVELOPER'];

type StageDefaults = Omit<StageTemplateDef, 'key' | 'type'>;

/** What a stage of each type starts with (the built-in templates, and "Add stage" in the editor). */
export const STAGE_DEFAULTS: Record<StageType, () => StageDefaults> = {
  research: () => ({
    name: 'Research',
    allowedRoles: PRODUCT_ROLES,
    optional: true,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: false,
    toolPolicy: readOnly(),
    instructions: 'Research the problem space and the codebase. Produce a research note.',
    agentRef: null,
    rules: [],
  }),
  plan: () => ({
    name: 'Plan',
    allowedRoles: PRODUCT_ROLES,
    optional: false,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: true,
    toolPolicy: readOnly(),
    instructions: 'Produce an implementation plan: scope, surface area, edge cases, verification.',
    agentRef: null,
    rules: [],
  }),
  wireframes: () => ({
    name: 'Wireframes',
    allowedRoles: PRODUCT_ROLES,
    optional: true,
    artifactTypes: ['HTML', 'FIGMA_LINK'],
    requiredForGate: false,
    toolPolicy: readOnly(),
    instructions: 'Produce wireframes as a self-contained HTML mockup or a Figma link. Do not edit repository code.',
    agentRef: null,
    rules: [],
  }),
  build: () => ({
    name: 'Build',
    allowedRoles: DEV_ONLY,
    optional: false,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: true,
    toolPolicy: working(),
    instructions:
      "Implement the plan in this chat's worktree. The named branch is created automatically at your first file edit. Submit a summary of the change (branch, files, notes) as the artifact.",
    agentRef: null,
    rules: [],
  }),
  qa: () => ({
    name: 'QA',
    allowedRoles: ['QA', 'DEVELOPER'],
    optional: false,
    artifactTypes: ['QA_REPORT'],
    requiredForGate: true,
    toolPolicy: { ...readOnly(), bash: 'ask' },
    instructions:
      'Ask the user whether they will test manually (they report results in chat) or the QA agent should test against the plan. The QA report is the artifact.',
    agentRef: null,
    rules: [],
  }),
  self_review: () => ({
    name: 'Self-review',
    allowedRoles: DEV_ONLY,
    optional: false,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: true,
    toolPolicy: working(),
    instructions: 'Review the branch diff against the plan with the reviewer agent, then fix the findings. The review report is the artifact.',
    agentRef: null,
    rules: [],
  }),
  raise_pr: () => ({
    name: 'Raise PR',
    allowedRoles: DEV_ONLY,
    optional: false,
    artifactTypes: ['PR_LINK'],
    requiredForGate: false,
    toolPolicy: working(),
    instructions:
      "Commit and push with the user's git credentials and open the pull request with `gh pr create` (the PR title must include the ticket key: the linked Jira key if there is one, otherwise the Shipline key). Submit the PR URL as the artifact.",
    agentRef: null,
    rules: [],
  }),
  resolve_comments: () => ({
    name: 'Resolve PR comments',
    allowedRoles: DEV_ONLY,
    optional: false,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: false,
    toolPolicy: working(),
    instructions:
      'Address review comments the user sends you: fix, commit and push. The stage completes automatically when the PR is merged.',
    agentRef: null,
    rules: [],
  }),
  custom: () => ({
    name: 'Custom stage',
    allowedRoles: ['PM', 'DESIGNER', 'DEVELOPER', 'QA'],
    optional: false,
    artifactTypes: ['MARKDOWN'],
    requiredForGate: false,
    toolPolicy: readOnly(),
    instructions: '',
    agentRef: null,
    rules: [],
  }),
};

/** A new stage of the given type. Built-in types use the type as the key; custom ones get `key`. */
export function defaultStage(type: StageType, key?: string): StageTemplateDef {
  return { key: key ?? type, type, ...STAGE_DEFAULTS[type]() };
}

const stageOf = (type: StageType, overrides: Partial<StageTemplateDef> = {}): StageTemplateDef => ({
  ...defaultStage(type),
  ...overrides,
});

// Seed data only: the built-in templates are created from these once (see apps/api/prisma/seed.ts)
// and are edited as ordinary templates in Admin afterwards.
export const FEATURE_TEMPLATE: WorkflowTemplateDef = {
  name: 'Feature',
  description: 'Research, plan, wireframes, build, QA, self-review and a pull request.',
  stages: [
    stageOf('research'),
    stageOf('plan'),
    stageOf('wireframes'),
    stageOf('build'),
    stageOf('qa'),
    stageOf('self_review'),
    stageOf('raise_pr'),
    stageOf('resolve_comments'),
  ],
};

// Hotfix: QA happens afterwards, outside the gate.
export const HOTFIX_TEMPLATE: WorkflowTemplateDef = {
  name: 'Hotfix',
  description: 'Build the minimal fix, self-review and raise the PR. QA happens afterwards.',
  stages: [
    stageOf('build', { instructions: "Implement the minimal fix in this chat's worktree." }),
    stageOf('self_review'),
    stageOf('raise_pr'),
    stageOf('resolve_comments'),
  ],
};

export const DEFAULT_TEMPLATES: WorkflowTemplateDef[] = [FEATURE_TEMPLATE, HOTFIX_TEMPLATE];

/** True when at least one of the person's roles may perform the stage. */
export function rolesCanPerformStage(allowedRoles: readonly Role[], roles: readonly Role[]): boolean {
  return roles.some((r) => allowedRoles.includes(r));
}

/** Stage types that end with the pull request: a merge finishes them. */
export const MERGE_STAGE_TYPES: readonly StageType[] = ['raise_pr', 'resolve_comments'];
