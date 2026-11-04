import { Project, Ticket } from '@prisma/client';
import { extractKeys } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { createGatesCheckRun, githubAppConfigured } from '../lib/github-app';
import { evaluateGates } from './gates.service';

/**
 * Matches a PR to a chat by its key (LL-12) or its linked Jira key, in the branch name first and
 * then the PR title. Keys are unique per project, so the match is scoped to the project.
 */
export async function findTicketForPullRequest(projectId: string, branch: string, title: string): Promise<Ticket | null> {
  for (const key of [...extractKeys(branch), ...extractKeys(title)]) {
    const ticket = await prisma.ticket.findFirst({ where: { projectId, OR: [{ key }, { jiraKey: key }] } });
    if (ticket) return ticket;
  }
  return null;
}

/** Evaluates one tracked PR and publishes the `shipline/gates` check run for its head SHA. */
export async function publishGatesCheck(project: Project, pullRequestId: string): Promise<void> {
  if (!githubAppConfigured()) return;
  const pr = await prisma.pullRequest.findUnique({ where: { id: pullRequestId } });
  if (!pr) return;

  const ticket = await findTicketForPullRequest(project.id, pr.branch, pr.title);

  if (ticket?.id !== pr.ticketId) {
    await prisma.pullRequest.update({ where: { id: pr.id }, data: { ticketId: ticket?.id ?? null } });
  }

  if (!ticket) {
    await createGatesCheckRun(project, pr.headSha, {
      pass: false,
      title: 'No matching Shipline chat',
      summary:
        "Put the chat's key (e.g. LL-12) or its linked Jira key in the branch name or PR title. Shipline names the branch for you at the chat's first edit.",
    });
    return;
  }

  const result = await evaluateGates(ticket.id);
  await createGatesCheckRun(project, pr.headSha, {
    pass: result.pass,
    title: result.pass
      ? result.overridden
        ? `Gates bypassed by admin override (${ticket.key})`
        : `All gates passed (${ticket.key})`
      : `Gates not satisfied (${ticket.key})`,
    summary: [`Chat ${ticket.key}${ticket.jiraKey ? ` (Jira ${ticket.jiraKey})` : ''}: ${ticket.title}`, '', ...result.lines].join('\n'),
  });
}

/** Re-publishes checks for every open PR tracked against a ticket; never throws into callers. */
export async function refreshTicketChecks(ticketId: string): Promise<void> {
  try {
    if (!githubAppConfigured()) return;
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { project: true, pullRequests: true },
    });
    if (!ticket) return;
    for (const pr of ticket.pullRequests) {
      await publishGatesCheck(ticket.project, pr.id);
    }
  } catch (err) {
    console.error(`Failed to refresh gates checks for ticket ${ticketId}:`, err);
  }
}
