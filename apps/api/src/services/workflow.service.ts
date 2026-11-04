import { Artifact, ArtifactType, Prisma, StageTransition, Ticket, TransitionKind } from '@prisma/client';
import {
  MERGE_STAGE_TYPES,
  StageTransitionDTO,
  TRANSITION_KINDS,
  TransitionDecisionResultDTO,
  buildDeclinedMessage,
  buildStageChangeMessage,
  meetsMinVersion,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { putArtifactContent } from '../lib/artifact-storage';
import { requireProjectAccess } from './access.service';
import { refreshTicketChecks } from './checks.service';
import { commitDoneArtifact } from './artifact-commit.service';
import {
  RunWithDef,
  TicketState,
  currentRun,
  loadTicketState,
  stageTypeOf,
  syncStageStatuses,
  toStageContext,
} from './stage-state.service';

/** The chat's owner, or a 403. Only the person who started a chat can run it (admins can view). */
export function requireOwner(ticket: Pick<Ticket, 'ownerId'>, userId: string): void {
  if (ticket.ownerId !== userId) {
    throw new HttpError(403, 'This chat belongs to someone else. Only its owner can run it.', 'NOT_OWNER');
  }
}

/** The current stage, or a descriptive error once every stage is finished. */
function requireWorkableStage(state: TicketState): RunWithDef {
  const run = currentRun(state.stageRuns);
  if (!run) throw new HttpError(409, 'Every stage of this chat is finished', 'TICKET_DONE');
  return run;
}

export interface SubmitInput {
  type: ArtifactType;
  content: string;
  pluginVersion?: string | null;
  appVersion?: string | null;
  clientKind?: string | null;
}

function validateArtifact(type: ArtifactType, content: string): void {
  if (!content.trim()) throw new HttpError(400, 'Artifact content is empty');
  if (type === 'FIGMA_LINK' || type === 'PR_LINK') {
    // OPEN-QUESTION #8: Figma artifacts are link-only in v1.
    try {
      const url = new URL(content.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
    } catch {
      throw new HttpError(400, `${type} artifact must be an http(s) URL`);
    }
  }
}

/**
 * Attaches a new artifact version to the ticket's CURRENT stage. It does not change the stage's
 * status: completing the stage is a separate, user-confirmed transition.
 */
export async function submitArtifact(
  ticketId: string,
  userId: string,
  input: SubmitInput,
  expectStageRunId?: string,
): Promise<Artifact> {
  const state = await loadTicketState(ticketId);
  requireOwner(state, userId);
  const run = requireWorkableStage(state);
  if (expectStageRunId && expectStageRunId !== run.id) {
    throw new HttpError(409, `${run.stageDef.name} is the current stage; it is not the stage you submitted to`, 'NOT_CURRENT_STAGE');
  }
  const project = state.project;
  if (!meetsMinVersion(input.pluginVersion, project.minPluginVersion)) {
    throw new HttpError(
      426,
      `Shipline plugin ${input.pluginVersion ?? '(none)'} is below the required minimum ${project.minPluginVersion}. Update Shipline Local or the plugin.`,
      'VERSION_TOO_OLD',
    );
  }
  if (!run.stageDef.artifactTypes.includes(input.type)) {
    throw new HttpError(400, `This stage accepts: ${run.stageDef.artifactTypes.join(', ')}`, 'BAD_ARTIFACT_TYPE');
  }
  validateArtifact(input.type, input.content);
  const stored = putArtifactContent(input.content);

  return prisma.$transaction(async (tx) => {
    const last = await tx.artifact.findFirst({ where: { stageRunId: run.id }, orderBy: { version: 'desc' } });
    const created = await tx.artifact.create({
      data: {
        stageRunId: run.id,
        version: (last?.version ?? 0) + 1,
        type: input.type,
        content: stored.content,
        storageRef: stored.storageRef,
        submittedById: userId,
        pluginVersion: input.pluginVersion ?? null,
        appVersion: input.appVersion ?? null,
        clientKind: input.clientKind ?? null,
      },
    });
    await audit(
      { type: 'artifact.submitted', actorId: userId, projectId: project.id, ticketId, stageRunId: run.id, data: { stage: run.stageDef.key, version: created.version, pluginVersion: input.pluginVersion ?? null, appVersion: input.appVersion ?? null } },
      tx,
    );
    return created;
  });
}

// --- Stage transitions ---

const KIND_TO_DB: Record<(typeof TRANSITION_KINDS)[number], TransitionKind> = {
  complete: 'COMPLETE',
  skip: 'SKIP',
  reopen: 'REOPEN',
};
const KIND_FROM_DB = { COMPLETE: 'complete', SKIP: 'skip', REOPEN: 'reopen' } as const;

type TransitionWithRefs = StageTransition & { stageRun: RunWithDef };

function toTransitionDTO(t: TransitionWithRefs, state: TicketState): StageTransitionDTO {
  const target = t.targetStageKey ? state.stageRuns.find((r) => r.stageDef.key === t.targetStageKey) : null;
  return {
    id: t.id,
    ticketId: t.ticketId,
    kind: KIND_FROM_DB[t.kind],
    fromStageKey: t.stageRun.stageDef.key,
    fromStageName: t.stageRun.stageDef.name,
    targetStageKey: t.targetStageKey,
    targetStageName: target?.stageDef.name ?? null,
    proposedBy: t.proposedBy === 'CLAUDE' ? 'claude' : 'user',
    reason: t.reason,
    decision: t.decision,
    createdAt: t.createdAt.toISOString(),
    decidedAt: t.decidedAt?.toISOString() ?? null,
  };
}

const withStage = { stageRun: { include: { stageDef: true } } } as const;

/** Validates a proposal against the ticket's current state; throws a message Claude can act on. */
async function validateTransition(
  state: TicketState,
  run: RunWithDef,
  kind: TransitionKind,
  targetStageKey: string | null,
): Promise<void> {
  if (kind === 'COMPLETE') {
    if (stageTypeOf(run.stageDef) === 'resolve_comments') {
      throw new HttpError(
        409,
        `${run.stageDef.name} completes automatically when the pull request is merged; it cannot be completed manually.`,
        'COMPLETES_ON_MERGE',
      );
    }
    const count = await prisma.artifact.count({ where: { stageRunId: run.id } });
    if (count === 0) {
      throw new HttpError(
        409,
        `${run.stageDef.name} has no artifact yet. Call submit_artifact (${run.stageDef.artifactTypes.join(' or ')}) first, then propose completing the stage again.`,
        'ARTIFACT_MISSING',
      );
    }
  } else if (kind === 'SKIP') {
    if (!run.stageDef.optional) {
      throw new HttpError(409, `${run.stageDef.name} is not optional and cannot be skipped.`, 'NOT_OPTIONAL');
    }
  } else {
    const target = state.stageRuns.find((r) => r.stageDef.key === targetStageKey);
    if (!target) throw new HttpError(400, 'targetStageKey must name a stage of this ticket', 'BAD_TARGET');
    if (target.stageDef.order >= run.stageDef.order) {
      throw new HttpError(409, 'Reopen must go back to an earlier stage.', 'BAD_TARGET');
    }
    if (target.status !== 'DONE' && target.status !== 'SKIPPED') {
      throw new HttpError(409, `${target.stageDef.name} has not been finished, so there is nothing to reopen.`, 'BAD_TARGET');
    }
  }
}

/**
 * Records a proposal. Only one proposal can be pending per ticket: a new one replaces the old.
 * `proposedBy: 'claude'` comes from the MCP tool; the chat owner then confirms or declines it.
 */
export async function proposeTransition(
  ticketId: string,
  userId: string,
  input: { kind: (typeof TRANSITION_KINDS)[number]; reason: string; targetStageKey?: string | null; proposedBy: 'claude' | 'user' },
): Promise<StageTransitionDTO> {
  const state = await loadTicketState(ticketId);
  requireOwner(state, userId);
  const run = requireWorkableStage(state);
  const kind = KIND_TO_DB[input.kind];
  const targetStageKey = kind === 'REOPEN' ? (input.targetStageKey ?? null) : null;
  await validateTransition(state, run, kind, targetStageKey);

  const created = await prisma.$transaction(async (tx) => {
    await tx.stageTransition.updateMany({
      where: { ticketId, decision: 'PENDING' },
      data: { decision: 'SUPERSEDED', decidedAt: new Date() },
    });
    const t = await tx.stageTransition.create({
      data: {
        ticketId,
        stageRunId: run.id,
        kind,
        targetStageKey,
        proposedBy: input.proposedBy === 'claude' ? 'CLAUDE' : 'USER',
        reason: input.reason.trim(),
      },
      include: withStage,
    });
    await audit(
      { type: 'transition.proposed', actorId: userId, projectId: state.projectId, ticketId, stageRunId: run.id, data: { kind: input.kind, targetStageKey, proposedBy: input.proposedBy, reason: input.reason } },
      tx,
    );
    return t;
  });
  return toTransitionDTO(created, state);
}

export async function listTransitions(ticketId: string, userId: string): Promise<StageTransitionDTO[]> {
  const state = await loadTicketState(ticketId);
  await requireProjectAccess(userId, state.projectId);
  const rows = await prisma.stageTransition.findMany({
    where: { ticketId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: withStage,
  });
  return rows.map((t) => toTransitionDTO(t, state));
}

/** Applies a confirmed transition to the stage rows inside a transaction. */
async function applyTransition(
  tx: Prisma.TransactionClient,
  state: TicketState,
  run: RunWithDef,
  t: StageTransition,
): Promise<void> {
  const now = new Date();
  if (t.kind === 'COMPLETE') {
    await tx.stageRun.update({ where: { id: run.id }, data: { status: 'DONE', completedAt: now } });
  } else if (t.kind === 'SKIP') {
    await tx.stageRun.update({
      where: { id: run.id },
      data: { status: 'SKIPPED', completedAt: now, skippedReason: t.reason || null },
    });
  } else {
    const target = state.stageRuns.find((r) => r.stageDef.key === t.targetStageKey)!;
    // The target restarts; every later stage goes back to PENDING (their artifacts keep their versions).
    await tx.stageRun.update({
      where: { id: target.id },
      data: { status: 'PENDING', completedAt: null, skippedReason: null, reopenedCount: { increment: 1 } },
    });
    for (const later of state.stageRuns.filter((r) => r.stageDef.order > target.stageDef.order)) {
      await tx.stageRun.update({
        where: { id: later.id },
        data: { status: 'PENDING', completedAt: null, skippedReason: null },
      });
    }
    await tx.ticket.update({ where: { id: state.id }, data: { status: 'ACTIVE' } });
  }
  await syncStageStatuses(tx, state.id);
}

/**
 * Confirm ("Confirm") or decline ("Not yet") a pending proposal. On confirm the server advances the
 * stage; the returned `claudeMessage` is what the browser posts into the chat so Claude learns the
 * new stage and its policy inside the same conversation.
 */
export async function decideTransition(
  ticketId: string,
  transitionId: string,
  userId: string,
  confirm: boolean,
): Promise<TransitionDecisionResultDTO> {
  const state = await loadTicketState(ticketId);
  requireOwner(state, userId);
  const t = await prisma.stageTransition.findUnique({ where: { id: transitionId }, include: withStage });
  if (!t || t.ticketId !== ticketId) throw new HttpError(404, 'Proposal not found');
  if (t.decision !== 'PENDING') throw new HttpError(409, `This proposal was already ${t.decision.toLowerCase()}`, 'NOT_PENDING');

  const run = currentRun(state.stageRuns);
  if (confirm && (!run || run.id !== t.stageRunId)) {
    await prisma.stageTransition.update({ where: { id: t.id }, data: { decision: 'SUPERSEDED', decidedAt: new Date() } });
    throw new HttpError(409, 'The ticket moved on since this was proposed', 'STALE_PROPOSAL');
  }
  if (confirm && run) await validateTransition(state, run, t.kind, t.targetStageKey);

  if (!confirm) {
    const declined = await prisma.$transaction(async (tx) => {
      const u = await tx.stageTransition.update({
        where: { id: t.id },
        data: { decision: 'DECLINED', decidedAt: new Date(), decidedById: userId },
        include: withStage,
      });
      await audit({ type: 'transition.declined', actorId: userId, projectId: state.projectId, ticketId, stageRunId: t.stageRunId, data: { kind: t.kind } }, tx);
      return u;
    });
    const kindWord = KIND_FROM_DB[t.kind];
    return {
      transition: toTransitionDTO(declined, state),
      currentStage: run ? toStageContext(run) : null,
      claudeMessage: buildDeclinedMessage(state.key, kindWord, t.stageRun.stageDef.name),
    };
  }

  const confirmed = await prisma.$transaction(async (tx) => {
    const u = await tx.stageTransition.update({
      where: { id: t.id },
      data: { decision: 'CONFIRMED', decidedAt: new Date(), decidedById: userId },
      include: withStage,
    });
    await applyTransition(tx, state, run!, t);
    await audit(
      { type: `stage.${KIND_FROM_DB[t.kind]}`, actorId: userId, projectId: state.projectId, ticketId, stageRunId: t.stageRunId, data: { stage: run!.stageDef.key, targetStageKey: t.targetStageKey, reason: t.reason, proposedBy: t.proposedBy } },
      tx,
    );
    return u;
  });

  if (t.kind === 'COMPLETE') {
    const artifact = await prisma.artifact.findFirst({ where: { stageRunId: run!.id }, orderBy: { version: 'desc' } });
    if (artifact) await commitDoneArtifact(state.project, state.jiraKey ?? state.key, run!.stageDef, artifact);
  }
  await refreshTicketChecks(ticketId);

  const fresh = await loadTicketState(ticketId);
  const next = currentRun(fresh.stageRuns);
  const stage = next ? toStageContext(next) : null;
  return {
    transition: toTransitionDTO(confirmed, fresh),
    currentStage: stage,
    claudeMessage: buildStageChangeMessage({
      ticketKey: fresh.key,
      fromStageName: run!.stageDef.name,
      stage,
      cause: `the user confirmed your proposal to ${KIND_FROM_DB[t.kind]} ${run!.stageDef.name}`,
    }),
  };
}

/** Called by the GitHub webhook when the ticket's PR is merged: its Raise PR and Resolve comments stages (by type) end. */
export async function completeOnMerge(ticketId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const state = await loadTicketState(ticketId, tx);
    const now = new Date();
    // OPEN-QUESTION #12: a merge finishes the ticket even if earlier stages were bypassed by an
    // admin override; stages from Raise PR onward are marked DONE, others are left as they were.
    for (const run of state.stageRuns) {
      if (!MERGE_STAGE_TYPES.includes(stageTypeOf(run.stageDef))) continue;
      if (run.status === 'DONE' || run.status === 'SKIPPED') continue;
      await tx.stageRun.update({ where: { id: run.id }, data: { status: 'DONE', completedAt: now } });
    }
    await tx.stageTransition.updateMany({
      where: { ticketId, decision: 'PENDING' },
      data: { decision: 'SUPERSEDED', decidedAt: now },
    });
    await tx.ticket.update({ where: { id: ticketId }, data: { status: 'DONE', prState: 'MERGED' } });
    await audit({ type: 'ticket.merged', projectId: state.projectId, ticketId }, tx);
  });
}

export async function recordClaudeSession(ticketId: string, userId: string, claudeSessionId: string): Promise<void> {
  const ticket = await loadTicketState(ticketId);
  requireOwner(ticket, userId);
  await prisma.ticket.update({ where: { id: ticketId }, data: { claudeSessionId } });
}

/**
 * Shipline Local reports the chat's worktree (and the named branch once the first edit created it).
 * `branch` stays null while the worktree is detached; a known branch is never cleared.
 */
export async function recordWorkspace(
  ticketId: string,
  userId: string,
  workspace: { branch: string | null; worktreePath: string },
): Promise<void> {
  const ticket = await loadTicketState(ticketId);
  requireOwner(ticket, userId);
  const branch = workspace.branch ?? ticket.branch;
  await prisma.ticket.update({ where: { id: ticketId }, data: { branch, worktreePath: workspace.worktreePath } });
  if (branch && ticket.branch !== branch) {
    await audit({ type: 'ticket.branch_created', actorId: userId, projectId: ticket.projectId, ticketId, data: { branch } });
    // The PR check matches by branch name too: re-evaluate any PR already tracked for this chat.
    await refreshTicketChecks(ticketId);
  }
}

export async function createOverride(
  ticketId: string,
  adminId: string,
  kind: 'GATES' | 'HOTFIX',
  reason: string,
) {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required for an admin override');
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const access = await requireProjectAccess(adminId, ticket.projectId);
  if (!access.isAdmin) throw new HttpError(403, 'Only an admin can override gates');

  const override = await prisma.$transaction(async (tx) => {
    const o = await tx.override.create({ data: { ticketId, adminId, kind, reason } });
    await audit({ type: 'ticket.override', actorId: adminId, projectId: ticket.projectId, ticketId, data: { kind, reason } }, tx);
    return o;
  });
  await refreshTicketChecks(ticketId);
  return override;
}
