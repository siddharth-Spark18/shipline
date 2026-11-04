import {
  ASK_USER_QUESTION_TOOL,
  ApproveToolUseResultDTO,
  AskUserQuestionAnswers,
  AskUserQuestionItem,
  branchNameFor,
  decideToolUse,
  effectiveEditPolicy,
  isFirstEditCall,
  PendingToolDecisionDTO,
  STAGE_READ_ONLY_TOOLS,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { effectiveRulesFor } from './guardrail.service';
import { projectEditPolicies, stageToolPolicy } from './policy-config';
import { currentRun, loadTicketState, ownerRoles } from './stage-state.service';

/**
 * OPEN-QUESTION #11 (hosting): "ask" decisions wait in this process's memory for the user's
 * answer from Shipline Local. That is correct for a single API instance; a multi-instance
 * deployment needs a shared channel (Postgres LISTEN/NOTIFY or Redis) here.
 */
interface UserAnswer {
  decision: 'ALLOW' | 'DENY';
  /** Only for AskUserQuestion: returned to Claude as `updatedInput.answers`. */
  answers?: AskUserQuestionAnswers;
}

const waiters = new Map<string, (answer: UserAnswer) => void>();
/** Full tool input of each parked request (only a summary is persisted), same lifetime as `waiters`. */
const pendingInputs = new Map<string, Record<string, unknown>>();

const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export type ToolResponse = ApproveToolUseResultDTO &
  ({ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string });

/**
 * The named branch is created just before the chat's first edit: when an allowed call is an Edit,
 * Write, NotebookEdit or a Bash call off the read-only list and the chat has no branch yet, the
 * answer carries `shiplineBranch`. Shipline Local (its MCP proxy) runs `git switch -c` in the
 * worktree before Claude gets the allow, and strips the field.
 */
async function withBranchSignal(
  ticketId: string,
  tool: string,
  input: Record<string, unknown>,
  allow: ToolResponse,
): Promise<ToolResponse> {
  if (allow.behavior !== 'allow' || !isFirstEditCall(tool, input)) return allow;
  // Re-read: another call may have created the branch while this one waited for the user.
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.branch) return allow;
  return { ...allow, shiplineBranch: branchNameFor({ key: ticket.key, jiraKey: ticket.jiraKey, title: ticket.title }) };
}

function summarize(tool: string, input: Record<string, unknown>): string {
  const key = ['command', 'file_path', 'path', 'url', 'pattern'].find((k) => typeof input[k] === 'string');
  const text = key ? String(input[key]) : JSON.stringify(input);
  return `${tool}: ${text}`.slice(0, 400);
}

/**
 * Decides one tool-use request for a ticket. The stage whose policy applies is the ticket's
 * CURRENT stage at call time, so one long-lived Claude session needs no per-stage launch flags.
 */
export async function decideToolRequest(args: {
  ticketId: string;
  userId: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  pluginVersion?: string | null;
  appVersion?: string | null;
}): Promise<ToolResponse> {
  const state = await loadTicketState(args.ticketId);
  // With every stage finished there is no policy to read; log against the last stage.
  const run = currentRun(state.stageRuns) ?? state.stageRuns[state.stageRuns.length - 1];
  if (!run) throw new HttpError(404, 'Ticket has no stages');

  const base = {
    stageRunId: run.id,
    userId: args.userId,
    tool: args.tool,
    toolUseId: args.toolUseId ?? null,
    inputSummary: summarize(args.tool, args.input),
    pluginVersion: args.pluginVersion ?? null,
    appVersion: args.appVersion ?? null,
  };

  if (state.ownerId !== args.userId || run.status !== 'IN_PROGRESS') {
    const reason = 'This chat is not yours, or all of its stages are finished; tool use is not permitted.';
    await prisma.toolDecision.create({
      data: { ...base, decision: 'DENY', decidedBy: 'POLICY', reason, decidedAt: new Date() },
    });
    return { behavior: 'deny', message: reason };
  }

  const roles = await ownerRoles(state);
  // Org, project and role rules are read live (cached per project, dropped on change); the stage's
  // rules come from the chat's pinned template version. Strictest wins inside decideToolUse.
  const rules = await effectiveRulesFor(state.projectId, run.stageDef);
  const result = decideToolUse({
    tool: args.tool,
    input: args.input,
    actorRoles: roles,
    roleEditPolicy: effectiveEditPolicy(roles, projectEditPolicies(state.project)),
    stagePolicy: stageToolPolicy(run.stageDef),
    rules,
    worktreeRoot: state.worktreePath,
  });

  if (result.behavior !== 'ask') {
    // OPEN-QUESTION: reads and web lookups go through here so rules can apply to them (see
    // sessionLaunchPolicy); an allowed one is not written to ToolDecision (one row per Read would
    // swamp the table). Denials and asks are always logged.
    const quietAllow = result.behavior === 'allow' && !result.rule && STAGE_READ_ONLY_TOOLS.includes(args.tool);
    if (!quietAllow) {
      await prisma.toolDecision.create({
        data: {
          ...base,
          decision: result.behavior === 'allow' ? 'ALLOW' : 'DENY',
          decidedBy: 'POLICY',
          reason: result.reason,
          decidedAt: new Date(),
        },
      });
    }
    return result.behavior === 'allow'
      ? withBranchSignal(args.ticketId, args.tool, args.input, { behavior: 'allow', updatedInput: args.input })
      : { behavior: 'deny', message: result.reason };
  }

  // Policy says "ask": park the request until the user answers in the hub's chat UI.
  const pending = await prisma.toolDecision.create({
    data: { ...base, decision: 'PENDING', decidedBy: 'USER', reason: result.reason },
  });
  pendingInputs.set(pending.id, args.input);
  const answer = await new Promise<UserAnswer | 'TIMEOUT'>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(pending.id);
      pendingInputs.delete(pending.id);
      resolve('TIMEOUT');
    }, ASK_TIMEOUT_MS);
    waiters.set(pending.id, (a) => {
      clearTimeout(timer);
      waiters.delete(pending.id);
      pendingInputs.delete(pending.id);
      resolve(a);
    });
  });

  if (answer === 'TIMEOUT') {
    await prisma.toolDecision.update({
      where: { id: pending.id },
      data: { decision: 'DENY', decidedBy: 'TIMEOUT', decidedAt: new Date(), reason: 'No answer in time.' },
    });
    return { behavior: 'deny', message: 'No confirmation received; request denied.' };
  }
  if (answer.decision === 'DENY') {
    const message =
      args.tool === ASK_USER_QUESTION_TOOL
        ? 'The user skipped these questions. Continue with your best judgement or ask in plain text.'
        : 'The user denied this action.';
    return { behavior: 'deny', message };
  }
  // AskUserQuestion: Claude Code expects the original questions plus `answers` (question text -> label).
  const updatedInput = answer.answers ? { ...args.input, answers: answer.answers } : args.input;
  return withBranchSignal(args.ticketId, args.tool, updatedInput, { behavior: 'allow', updatedInput });
}

function questionsOf(input: Record<string, unknown> | undefined): AskUserQuestionItem[] | undefined {
  return Array.isArray(input?.questions) ? (input.questions as AskUserQuestionItem[]) : undefined;
}

export async function listPendingToolDecisions(
  ticketId: string,
  userId: string,
): Promise<PendingToolDecisionDTO[]> {
  const rows = await prisma.toolDecision.findMany({
    where: { stageRun: { ticketId }, userId, decision: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    include: { stageRun: { include: { stageDef: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    ticketId,
    stageKey: r.stageRun.stageDef.key,
    tool: r.tool,
    inputSummary: r.inputSummary,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    questions: r.tool === ASK_USER_QUESTION_TOOL ? questionsOf(pendingInputs.get(r.id)) : undefined,
  }));
}

export async function resolveToolDecision(
  id: string,
  userId: string,
  allow: boolean,
  answers?: AskUserQuestionAnswers,
): Promise<void> {
  const row = await prisma.toolDecision.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'Tool decision not found');
  if (row.userId !== userId) throw new HttpError(403, 'Not your tool request');
  if (row.decision !== 'PENDING') throw new HttpError(409, 'Already decided');
  if (allow && row.tool === ASK_USER_QUESTION_TOOL && !answers) {
    throw new HttpError(400, 'Answers are required for a question');
  }
  await prisma.toolDecision.update({
    where: { id },
    data: { decision: allow ? 'ALLOW' : 'DENY', decidedBy: 'USER', decidedAt: new Date() },
  });
  waiters.get(id)?.({ decision: allow ? 'ALLOW' : 'DENY', answers: allow ? answers : undefined });
}
