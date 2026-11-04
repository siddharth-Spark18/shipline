import { Prisma, Project, Role, StageDefinition, StageRun, Ticket, WorkflowTemplate, WorkflowTemplateVersion } from '@prisma/client';
import { StageContextDTO, StageSummaryDTO, StageType, isStageFinished, isStageType } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { stageToolPolicy } from './policy-config';

export type RunWithDef = StageRun & { stageDef: StageDefinition };
export type TicketState = Ticket & {
  project: Project;
  templateVersion: WorkflowTemplateVersion & { template: WorkflowTemplate };
  /** The stage runs of the template version the chat is pinned to, in stage order. */
  stageRuns: RunWithDef[];
};

/** Runs of the chat's pinned template version. After a template switch, runs of the old version stay as history but no longer count. */
export function runsOfPinnedVersion<T extends { stageDef: { versionId: string } }>(runs: T[], templateVersionId: string): T[] {
  return runs.filter((r) => r.stageDef.versionId === templateVersionId);
}

export async function loadTicketState(
  ticketId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<TicketState> {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    include: { project: true, templateVersion: { include: { template: true } } },
  });
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const stageRuns = await tx.stageRun.findMany({
    where: { ticketId, stageDef: { versionId: ticket.templateVersionId } },
    include: { stageDef: true },
    orderBy: { stageDef: { order: 'asc' } },
  });
  return { ...ticket, stageRuns };
}

export const stageTypeOf = (def: Pick<StageDefinition, 'type'>): StageType => (isStageType(def.type) ? def.type : 'custom');

/** The chat, or a 404; a 403 unless the user owns it. */
export async function requireOwnerTicket(ticketId: string, userId: string): Promise<Ticket> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new HttpError(404, 'Chat not found');
  if (ticket.ownerId !== userId) {
    throw new HttpError(403, 'This chat belongs to someone else. Only its owner can run it.', 'NOT_OWNER');
  }
  return ticket;
}

/** The first stage that is not DONE/SKIPPED. Stages are strictly ordered. */
export function currentRun(runs: RunWithDef[]): RunWithDef | null {
  return runs.find((r) => !isStageFinished(r.status)) ?? null;
}

/** The owner's roles in the chat's project (empty when they are not a member). */
export async function ownerRoles(
  ticket: Pick<Ticket, 'ownerId' | 'projectId'>,
  tx: Prisma.TransactionClient = prisma,
): Promise<Role[]> {
  const member = await tx.projectMember.findUnique({
    where: { userId_projectId: { userId: ticket.ownerId, projectId: ticket.projectId } },
  });
  return member?.roles ?? [];
}

/**
 * Recomputes every unfinished stage's status: the current stage is IN_PROGRESS, later ones PENDING.
 * A stage is never blocked for a role: role limits deny single tool calls instead. Also settles the
 * ticket's own status. Call after anything that changes which stages are finished.
 */
export async function syncStageStatuses(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
  const ticket = await loadTicketState(ticketId, tx);
  // A merged PR ends the ticket regardless of stage statuses (e.g. after an admin override).
  if (ticket.prState === 'MERGED') return;
  const current = currentRun(ticket.stageRuns);
  for (const run of ticket.stageRuns) {
    if (isStageFinished(run.status)) continue;
    const next = run.id === current?.id ? 'IN_PROGRESS' : 'PENDING';
    if (next !== run.status) await tx.stageRun.update({ where: { id: run.id }, data: { status: next } });
  }
  const status = current ? 'ACTIVE' : 'DONE';
  if (status !== ticket.status) await tx.ticket.update({ where: { id: ticketId }, data: { status } });
}

export function toStageContext(run: RunWithDef): StageContextDTO {
  return {
    key: run.stageDef.key,
    name: run.stageDef.name,
    type: stageTypeOf(run.stageDef),
    agentName: run.stageDef.agentName,
    status: run.status,
    allowedRoles: run.stageDef.allowedRoles,
    artifactTypes: run.stageDef.artifactTypes,
    toolPolicy: stageToolPolicy(run.stageDef),
    instructions: run.stageDef.instructions,
    optional: run.stageDef.optional,
  };
}

export function toStageSummary(run: RunWithDef, artifactCount: number): StageSummaryDTO {
  return {
    key: run.stageDef.key,
    name: run.stageDef.name,
    type: stageTypeOf(run.stageDef),
    agentName: run.stageDef.agentName,
    order: run.stageDef.order,
    status: run.status,
    optional: run.stageDef.optional,
    requiredForGate: run.stageDef.requiredForGate,
    allowedRoles: run.stageDef.allowedRoles,
    artifactTypes: run.stageDef.artifactTypes,
    artifactCount,
    skippedReason: run.skippedReason,
    reopenedCount: run.reopenedCount,
  };
}
