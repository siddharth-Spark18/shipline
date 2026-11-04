import { ROLE_PLURAL_LABELS, type EditPolicy, type Role, type RoleEditPolicies } from './roles';
import {
  type EffectiveRules,
  type RuleLevel,
  bashPatternMatches,
  describeRule,
  evaluateRules,
  splitBashCommands,
} from './guardrails';

export type PermissionMode = 'default' | 'plan' | 'acceptEdits';

export interface StageToolPolicy {
  /** If false, code-editing tools are denied regardless of the role's project edit policy. */
  allowCodeEdit: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /** How Bash is treated: follow the role's edit policy, or force a decision. */
  bash: 'inherit' | EditPolicy;
}

export type ToolBehavior = 'allow' | 'deny' | 'ask';

export interface ToolDecisionInput {
  tool: string;
  input: Record<string, unknown>;
  /** The roles the acting person (the chat's owner) holds in the project. */
  actorRoles: Role[];
  /** The person's effective edit policy (see `effectiveEditPolicy`). */
  roleEditPolicy: EditPolicy;
  /** Policy of the ticket's CURRENT stage, read at call time. */
  stagePolicy: StageToolPolicy;
  /** Guardrail rules at every level (org, project, role, stage). Strictest wins; see `evaluateRules`. */
  rules?: EffectiveRules;
  /** The chat's worktree root: file paths inside it are matched relative to it. */
  worktreeRoot?: string | null;
}

export interface ToolDecisionResult {
  behavior: ToolBehavior;
  /** For a rule decision this names the rule and its level ("Org rule: Never touch env files"). */
  reason: string;
  /** Set when a guardrail rule decided the call. */
  rule?: { id: string; level: RuleLevel };
}

export const CODE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Claude's clarifying-question tool: always routed to the person, who answers it. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

const SHIPLINE_MCP_PREFIX = 'mcp__shipline__';

/** Commands that cannot modify the working tree; allowed even for roles without edit rights. */
const READ_ONLY_BASH = /^\s*(ls|cat|head|tail|pwd|echo|wc|grep|rg|find|git\s+(status|log|diff|show|branch|rev-parse|ls-files)|node\s+--version|npm\s+(ls|view)|pnpm\s+(ls|why))(\s|$)/;

const SHELL_CHAINING = /[;&|><`]|\$\(/;

/** True for a Bash command on the read-only list (cannot modify the working tree). */
export function isReadOnlyBash(command: string): boolean {
  return READ_ONLY_BASH.test(command) && !SHELL_CHAINING.test(command);
}

/**
 * Whether allowing this tool call counts as the chat's "first edit": an Edit, Write, MultiEdit or
 * NotebookEdit, or a Bash call that is not on the read-only list. The hub uses it to ask Shipline
 * Local to create the named branch before the call runs.
 * OPEN-QUESTION: Bash commands that write files without editing source (e.g. `npm install`
 * changing the lockfile) count as the first edit, as the plan states.
 */
export function isFirstEditCall(tool: string, input: Record<string, unknown>): boolean {
  if (CODE_EDIT_TOOLS.includes(tool)) return true;
  if (tool !== 'Bash') return false;
  const command = typeof input.command === 'string' ? input.command : '';
  return !isReadOnlyBash(command);
}

/** "Designers", "Developers/PMs", or a neutral phrase when the person holds no role. */
function roleSubject(roles: readonly Role[]): string {
  return roles.length > 0 ? roles.map((r) => ROLE_PLURAL_LABELS[r]).join('/') : 'People without a project role';
}

const POLICY_RANK: Record<EditPolicy, number> = { deny: 0, ask: 1, allow: 2 };

/**
 * A person may hold several roles; the most permissive role policy applies. No role means no edit
 * rights (e.g. an admin who is not a member with a role).
 */
export function effectiveEditPolicy(roles: readonly Role[], policies: RoleEditPolicies): EditPolicy {
  let best: EditPolicy = 'deny';
  for (const role of roles) {
    if (POLICY_RANK[policies[role]] > POLICY_RANK[best]) best = policies[role];
  }
  return best;
}

/**
 * Pure policy decision for a single tool-use request. The server runs this for every
 * `approve_tool_use` call (hard enforcement of tool permissions), reading the ticket's current
 * stage at call time so launch flags never need to change per stage.
 *
 * Order: the stage's disallowed tools, Shipline's own tools and the question tool; then the
 * guardrail rules (strictest wins: a rule deny is final, a rule ask turns an allow into an ask);
 * then the stage and role policy. A rule `allow` only relaxes an "ask" that the stage or role policy
 * would have given: it can never override a deny.
 * OPEN-QUESTION: an allow rule does not make anything permitted that the stage/role policy denies
 * (lower levels can only tighten); it exists so a trusted command, tool or path stops prompting.
 */
export function decideToolUse(req: ToolDecisionInput): ToolDecisionResult {
  const { tool, input, stagePolicy, actorRoles } = req;

  if (matchesAny(tool, input, stagePolicy.disallowedTools)) {
    return { behavior: 'deny', reason: `Tool ${tool} is disallowed in this stage.` };
  }

  if (tool.startsWith(SHIPLINE_MCP_PREFIX)) {
    return { behavior: 'allow', reason: 'Shipline connector tool.' };
  }

  if (tool === ASK_USER_QUESTION_TOOL) {
    return { behavior: 'ask', reason: 'Claude has a question for you.' };
  }

  const verdict = req.rules ? evaluateRules(req.rules, { tool, input, root: req.worktreeRoot }, actorRoles) : null;
  const ruleRef = verdict ? { id: verdict.rule.id, level: verdict.rule.level } : undefined;
  if (verdict?.effect === 'deny') {
    return { behavior: 'deny', reason: describeRule(verdict.rule), rule: ruleRef };
  }

  const base = decideByPolicy(req);
  if (verdict?.effect === 'ask' && base.behavior === 'allow') {
    return { behavior: 'ask', reason: describeRule(verdict.rule), rule: ruleRef };
  }
  if (verdict?.effect === 'allow' && base.behavior === 'ask') {
    return { behavior: 'allow', reason: describeRule(verdict.rule), rule: ruleRef };
  }
  return base;
}

/** Stage policy plus the role's code-edit default: what applies when no guardrail rule says otherwise. */
function decideByPolicy(req: ToolDecisionInput): ToolDecisionResult {
  const { tool, input, stagePolicy, roleEditPolicy, actorRoles } = req;
  const subject = roleSubject(actorRoles);

  if (CODE_EDIT_TOOLS.includes(tool)) {
    if (!stagePolicy.allowCodeEdit) {
      return { behavior: 'deny', reason: 'Code edits are not permitted in this stage.' };
    }
    return applyEditPolicy(roleEditPolicy, subject, 'edit code');
  }

  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (isReadOnlyBash(command)) {
      return { behavior: 'allow', reason: 'Read-only shell command.' };
    }
    if (matchesAny(tool, input, stagePolicy.allowedTools)) {
      return { behavior: 'allow', reason: 'Command allowed by stage policy.' };
    }
    const mode = stagePolicy.bash === 'inherit' ? roleEditPolicy : stagePolicy.bash;
    if (!stagePolicy.allowCodeEdit && mode === 'allow') {
      return { behavior: 'ask', reason: 'Shell commands need confirmation in this stage.' };
    }
    return applyEditPolicy(mode, subject, 'run shell commands that change files');
  }

  if (matchesAny(tool, input, stagePolicy.allowedTools)) {
    return { behavior: 'allow', reason: 'Allowed by stage policy.' };
  }

  return { behavior: 'ask', reason: `No policy covers ${tool}; confirmation required.` };
}

// Role limits deny one call with a reason the chat shows on a denied tool chip
// (e.g. "Designers can't edit code"); they never block a whole stage.
function applyEditPolicy(policy: EditPolicy, subject: string, what: string): ToolDecisionResult {
  if (policy === 'allow') return { behavior: 'allow', reason: `${subject} may ${what}.` };
  if (policy === 'ask') return { behavior: 'ask', reason: `${subject} must confirm to ${what}.` };
  return { behavior: 'deny', reason: `${subject} can't ${what}.` };
}

// Patterns follow Claude Code's `Tool` / `Tool(prefix:*)` shape; only the tool name and a
// Bash command prefix are interpreted. A Bash pattern matches only when every sub-command of the
// command matches it (so `Bash(npm test:*)` does not let `npm test && rm -rf x` through).
function matchesAny(tool: string, input: Record<string, unknown>, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const m = /^([^(]+)(?:\((.*)\))?$/.exec(pattern);
    if (!m) return false;
    if (m[1] !== tool) return false;
    if (m[2] === undefined) return true;
    if (tool !== 'Bash') return true;
    const command = typeof input.command === 'string' ? input.command : '';
    const subs = splitBashCommands(command);
    return subs.length > 0 && subs.every((c) => bashPatternMatches(`Bash(${m[2]})`, c));
  });
}

/** Tools every stage may use without asking. */
export const STAGE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];

export interface LaunchPolicyFlags {
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /**
   * Tools Claude Code would run without asking (reads, web) that must still reach `approve_tool_use`
   * so guardrail rules can decide them server-side. Chat mode writes them as `permissions.ask` in the
   * session settings; the stage policy then allows them when no rule objects.
   */
  alwaysAsk: string[];
}

/**
 * Launch-time flags for `claude`. One Claude session spans the whole ticket, so these are the same
 * for every stage: the Shipline connector is pre-allowed, and everything else (reads and web tools
 * included, so read and tool rules can apply) goes through `--permission-prompt-tool`
 * (`approve_tool_use`), where the server applies the guardrail rules and the current stage's policy.
 * OPEN-QUESTION: routing Read/Glob/Grep through the permission prompt tool relies on `permissions.ask`
 * overriding Claude Code's built-in "reads need no permission"; verify against the installed CLI.
 */
export function sessionLaunchPolicy(): LaunchPolicyFlags {
  return {
    allowedTools: ['TodoWrite', 'mcp__shipline'],
    disallowedTools: [],
    permissionMode: 'default',
    alwaysAsk: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  };
}
