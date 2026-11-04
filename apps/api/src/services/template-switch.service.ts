import { Prisma, TemplateSwitch, WorkflowTemplate, WorkflowTemplateVersion } from '@prisma/client';
import {
  TemplateSwitchDTO,
  TemplateSwitchDecisionResultDTO,
  buildStageChangeMessage,
  buildTemplateSwitchDeclinedMessage,
  buildTemplateSwitchMessage,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { requireProjectAccess } from './access.service';
import { resolveChatTemplate } from './template.service';
import { currentRun, loadTicketState, stageTypeOf, syncStageStatuses, toStageContext } from './stage-state.service';
import { requireOwner } from './workflow.service';

type SwitchRow = TemplateSwitch & { toVersion: WorkflowTemplateVersion & { template: WorkflowTemplate } };
const withTarget = { toVersion: { include: { template: true } } } as const;

function toDTO(row: SwitchRow): TemplateSwitchDTO {
  return {
    id: row.id,
    ticketId: row.ticketId,
    toTemplateId: row.toVersion.templateId,
    toTemplateName: row.toVersion.template.name,
    toVersion: row.toVersion.version,
    reason: row.reason,
    decision: row.decision,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

const BRANCH_EXISTS = 'The chat already has its branch (the first file edit created it), so its template can no longer be switched.';

/**
 * Claude proposes switching the chat to another enabled template (for example "this looks like a
 * hotfix"). Allowed only before the branch exists. `template` is a template name or id.
 */
export async function proposeTemplateSwitch(
  ticketId: string,
  userId: string,
  input: { template: string; reason: string },
): Promise<TemplateSwitchDTO> {
  const state = await loadTicketState(ticketId);
  requireOwner(state, userId);
  if (state.branch) throw new HttpError(409, BRANCH_EXISTS, 'BRANCH_EXISTS');
  if (state.status !== 'ACTIVE') throw new HttpError(409, 'Every stage of this chat is finished.', 'TICKET_DONE');

  const wanted = input.template.trim();
  const options = await prisma.projectTemplate.findMany({
    where: { projectId: state.projectId, template: { archivedAt: null } },
    include: { template: true },
  });
  const target = options.find((o) => o.templateId === wanted) ?? options.find((o) => o.template.name.toLowerCase() === wanted.toLowerCase());
  if (!target) {
    throw new HttpError(
      400,
      `"${wanted}" is not a template this project offers. Available: ${options.map((o) => o.template.name).join(', ') || 'none'}.`,
      'UNKNOWN_TEMPLATE',
    );
  }
  if (target.templateId === state.templateVersion.templateId) {
    throw new HttpError(409, `The chat is already on the ${target.template.name} template.`, 'SAME_TEMPLATE');
  }
  const { version } = await resolveChatTemplate(state.projectId, target.templateId);

  const created = await prisma.$transaction(async (tx) => {
    await tx.templateSwitch.updateMany({ where: { ticketId, decision: 'PENDING' }, data: { decision: 'SUPERSEDED', decidedAt: new Date() } });
    const row = await tx.templateSwitch.create({
      data: { ticketId, toVersionId: version.id, reason: input.reason.trim() },
      include: withTarget,
    });
    await audit(
      { type: 'template_switch.proposed', actorId: userId, projectId: state.projectId, ticketId, data: { to: target.template.name, version: version.version, reason: input.reason } },
      tx,
    );
    return row;
  });
  return toDTO(created);
}

export async function listTemplateSwitches(ticketId: string, userId: string): Promise<TemplateSwitchDTO[]> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { projectId: true } });
  if (!ticket) throw new HttpError(404, 'Chat not found');
  await requireProjectAccess(userId, ticket.projectId);
  const rows = await prisma.templateSwitch.findMany({ where: { ticketId }, orderBy: { createdAt: 'desc' }, take: 20, include: withTarget });
  return rows.map(toDTO);
}

/**
 * Confirm or decline. Confirming re-pins the chat to the target template's version: a stage that is
 * DONE carries over when the new template has a stage of the same type (a custom stage: the same
 * key); every other stage starts fresh. The branch must still not exist.
 */
export async function decideTemplateSwitch(
  ticketId: string,
  switchId: string,
  userId: string,
  confirm: boolean,
): Promise<TemplateSwitchDecisionResultDTO> {
  const state = await loadTicketState(ticketId);
  requireOwner(state, userId);
  const sw = await prisma.templateSwitch.findUnique({ where: { id: switchId }, include: withTarget });
  if (!sw || sw.ticketId !== ticketId) throw new HttpError(404, 'Proposal not found');
  if (sw.decision !== 'PENDING') throw new HttpError(409, `This proposal was already ${sw.decision.toLowerCase()}`, 'NOT_PENDING');

  const fromName = state.templateVersion.template.name;
  if (!confirm) {
    const declined = await prisma.$transaction(async (tx) => {
      const row = await tx.templateSwitch.update({
        where: { id: sw.id },
        data: { decision: 'DECLINED', decidedAt: new Date(), decidedById: userId },
        include: withTarget,
      });
      await audit({ type: 'template_switch.declined', actorId: userId, projectId: state.projectId, ticketId }, tx);
      return row;
    });
    const run = currentRun(state.stageRuns);
    return {
      proposal: toDTO(declined),
      template: { id: state.templateVersion.templateId, name: fromName, version: state.templateVersion.version },
      currentStage: run ? toStageContext(run) : null,
      claudeMessage: buildTemplateSwitchDeclinedMessage(state.key, sw.toVersion.template.name, fromName),
    };
  }

  if (state.branch) {
    await prisma.templateSwitch.update({ where: { id: sw.id }, data: { decision: 'SUPERSEDED', decidedAt: new Date() } });
    throw new HttpError(409, BRANCH_EXISTS, 'BRANCH_EXISTS');
  }
  if (sw.toVersion.template.archivedAt) {
    throw new HttpError(409, `The ${sw.toVersion.template.name} template was archived since this was proposed.`, 'TEMPLATE_ARCHIVED');
  }

  const carriedOver: string[] = [];
  const confirmed = await prisma.$transaction(async (tx) => {
    const target = await tx.workflowTemplateVersion.findUniqueOrThrow({
      where: { id: sw.toVersionId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    const available = state.stageRuns.filter((r) => r.status === 'DONE');
    for (const def of target.stages) {
      const existing = await tx.stageRun.findUnique({ where: { ticketId_stageDefId: { ticketId, stageDefId: def.id } } });
      if (existing) {
        // The chat was on this version before: its run is reused, not carried over onto.
        await tx.stageRun.update({ where: { id: existing.id }, data: { status: 'PENDING', completedAt: null, skippedReason: null } });
        continue;
      }
      const type = stageTypeOf(def);
      const match = available.find((r) => (type === 'custom' ? stageTypeOf(r.stageDef) === 'custom' && r.stageDef.key === def.key : stageTypeOf(r.stageDef) === type));
      if (match) {
        available.splice(available.indexOf(match), 1);
        // Re-point the finished run (its artifacts come with it) at the new version's stage.
        await tx.stageRun.update({ where: { id: match.id }, data: { stageDefId: def.id } });
        carriedOver.push(def.name);
      } else {
        await tx.stageRun.create({ data: { ticketId, stageDefId: def.id } });
      }
    }
    await tx.ticket.update({ where: { id: ticketId }, data: { templateVersionId: target.id } });
    await tx.stageTransition.updateMany({ where: { ticketId, decision: 'PENDING' }, data: { decision: 'SUPERSEDED', decidedAt: new Date() } });
    await tx.templateSwitch.updateMany({ where: { ticketId, decision: 'PENDING', id: { not: sw.id } }, data: { decision: 'SUPERSEDED', decidedAt: new Date() } });
    const row = await tx.templateSwitch.update({
      where: { id: sw.id },
      data: { decision: 'CONFIRMED', decidedAt: new Date(), decidedById: userId },
      include: withTarget,
    });
    await syncStageStatuses(tx, ticketId);
    await audit(
      {
        type: 'ticket.template_switched',
        actorId: userId,
        projectId: state.projectId,
        ticketId,
        data: { from: fromName, fromVersion: state.templateVersion.version, to: sw.toVersion.template.name, toVersion: sw.toVersion.version, carriedOver } as Prisma.InputJsonValue,
      },
      tx,
    );
    return row;
  });

  const fresh = await loadTicketState(ticketId);
  const next = currentRun(fresh.stageRuns);
  const stage = next ? toStageContext(next) : null;
  const switchText = buildTemplateSwitchMessage({
    ticketKey: fresh.key,
    fromTemplateName: fromName,
    toTemplateName: sw.toVersion.template.name,
    toVersion: sw.toVersion.version,
    stageNames: fresh.stageRuns.map((r) => `${r.stageDef.name}${r.stageDef.optional ? '*' : ''}`),
    carriedOver,
  });
  return {
    proposal: toDTO(confirmed),
    template: { id: sw.toVersion.templateId, name: sw.toVersion.template.name, version: sw.toVersion.version },
    currentStage: stage,
    claudeMessage: `${switchText}\n\n${buildStageChangeMessage({ ticketKey: fresh.key, fromStageName: null, stage, cause: 'the chat switched templates' })}`,
  };
}
