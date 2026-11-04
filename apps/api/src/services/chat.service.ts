import { ChatRowDTO, CreateChatResultDTO, formatTicketKey, titleFromMessage } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { requireProjectAccess } from './access.service';
import { pickPullRequest, toTicketPr } from './context.service';
import { resolveChatTemplate } from './template.service';
import { currentRun, requireOwnerTicket, runsOfPinnedVersion, syncStageStatuses } from './stage-state.service';

/**
 * Starts a chat: a work item with a per-project key (`Project.keyPrefix` + a per-project counter,
 * e.g. LL-12), owned by its creator, titled from the first message. Jira is optional and linked
 * later (Claude asks in its first reply). Any project member may start a chat; what a person's
 * role lets them do is limited per tool call, not here.
 */
// OPEN-QUESTION: any project member (or global admin) may start a chat whatever their role; role limits
// apply per tool call. A new chat uses the template the person picked (it must be enabled for the
// project), else the project's default, at its latest version: the chat is pinned to that version.
export async function createChat(
  userId: string,
  input: { projectId: string; message: string; templateId?: string },
): Promise<CreateChatResultDTO> {
  await requireProjectAccess(userId, input.projectId);
  const message = input.message.trim();
  if (!message) throw new HttpError(400, 'Write the first message to start a chat');
  const { template, version } = await resolveChatTemplate(input.projectId, input.templateId);
  const title = titleFromMessage(message);

  return prisma.$transaction(async (tx) => {
    // The increment is atomic, so concurrent chats in a project never share a number.
    const project = await tx.project.update({
      where: { id: input.projectId },
      data: { ticketCounter: { increment: 1 } },
      select: { id: true, keyPrefix: true, ticketCounter: true },
    });
    const key = formatTicketKey(project.keyPrefix, project.ticketCounter);
    const ticket = await tx.ticket.create({
      data: { projectId: project.id, templateVersionId: version.id, key, title, ownerId: userId },
    });
    for (const def of version.stages) await tx.stageRun.create({ data: { ticketId: ticket.id, stageDefId: def.id } });
    await syncStageStatuses(tx, ticket.id);
    await audit({ type: 'chat.created', actorId: userId, projectId: project.id, ticketId: ticket.id, data: { key, template: template.name, templateId: template.id, templateVersion: version.version } }, tx);
    return { ticketId: ticket.id, key, title };
  });
}

/** Chats the user owns, newest activity first. */
export async function listChats(userId: string): Promise<ChatRowDTO[]> {
  const tickets = await prisma.ticket.findMany({
    where: { ownerId: userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      project: true,
      templateVersion: { include: { template: true } },
      stageRuns: { include: { stageDef: true }, orderBy: { stageDef: { order: 'asc' } } },
      pullRequests: {
        orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { comments: { where: { sentToClaudeAt: null } } } } },
      },
      _count: { select: { transitions: { where: { decision: 'PENDING' } } } },
    },
  });
  return tickets.map((t) => {
    const run = currentRun(runsOfPinnedVersion(t.stageRuns, t.templateVersionId));
    const pr = pickPullRequest(t.pullRequests, t.prNumber);
    return {
      ticketId: t.id,
      key: t.key,
      jiraKey: t.jiraKey,
      title: t.title,
      projectId: t.projectId,
      projectName: t.project.name,
      template: { id: t.templateVersion.templateId, name: t.templateVersion.template.name, version: t.templateVersion.version },
      status: t.status,
      currentStage: run ? { key: run.stageDef.key, name: run.stageDef.name, status: run.status } : null,
      started: !!t.claudeSessionId,
      branch: t.branch,
      pr: toTicketPr(pr),
      newComments: pr?._count.comments ?? 0,
      hasPendingTransition: t._count.transitions > 0,
      updatedAt: t.updatedAt.toISOString(),
    };
  });
}

export async function renameChat(ticketId: string, userId: string, title: string): Promise<void> {
  const ticket = await requireOwnerTicket(ticketId, userId);
  const next = title.trim();
  if (!next) throw new HttpError(400, 'A title is required');
  await prisma.ticket.update({ where: { id: ticketId }, data: { title: next.slice(0, 200) } });
  await audit({ type: 'chat.renamed', actorId: userId, projectId: ticket.projectId, ticketId, data: { title: next } });
}
