import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { JiraIssueDetail, getJiraSession, lookupJiraIssue, searchJiraIssues } from '../lib/jira-client';
import { refreshTicketChecks } from './checks.service';
import { requireOwnerTicket } from './stage-state.service';

// Jira is optional and read-only. These back the `search_jira_issues`, `get_jira_issue` and
// `link_jira_issue` MCP tools: Claude asks about a Jira ticket in its first reply, and they use the
// project's existing org-level Jira connection. Nothing here ever writes to Jira.

/** Jira network failures become a message Claude (and the user) can read. */
async function jiraCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err instanceof Error ? err.message : 'Jira request failed', 'JIRA_ERROR');
  }
}

// OPEN-QUESTION: the Jira tools only reach issues of the chat's own Jira project (Project.jiraProjectKey),
// a Jira issue links to one chat per project, and linking again replaces the earlier link.
async function loadChatProject(ticketId: string, userId: string) {
  const ticket = await requireOwnerTicket(ticketId, userId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: ticket.projectId } });
  return { ticket, project };
}

const summarize = (i: JiraIssueDetail) => ({ key: i.key, summary: i.summary, status: i.status, url: i.url });

/** Issues in the chat's Jira project that match the text (or the key). */
export async function searchIssuesForChat(ticketId: string, userId: string, query: string) {
  const { project } = await loadChatProject(ticketId, userId);
  const session = await getJiraSession();
  const issues = await jiraCall(() => searchJiraIssues(session, project.jiraProjectKey, query));
  return { jiraProject: project.jiraProjectKey, issues: issues.map(summarize) };
}

function requireInProject(key: string, jiraProjectKey: string): string {
  const normalized = key.trim().toUpperCase();
  if (!normalized.startsWith(`${jiraProjectKey.toUpperCase()}-`)) {
    throw new HttpError(400, `${normalized} is not in this project's Jira project (${jiraProjectKey})`, 'WRONG_JIRA_PROJECT');
  }
  return normalized;
}

/** Full details of one issue (description included) so Claude can pull it into its context. */
export async function getIssueForChat(ticketId: string, userId: string, key: string) {
  const { project } = await loadChatProject(ticketId, userId);
  const session = await getJiraSession();
  const lookup = await jiraCall(() => lookupJiraIssue(session, requireInProject(key, project.jiraProjectKey)));
  if (!lookup.found) throw new HttpError(404, `${key} was not found in Jira`, 'JIRA_NOT_FOUND');
  return lookup.issue;
}

/**
 * Links a Jira issue to the chat and pulls its details into the chat's context. If the named branch
 * already exists it keeps its name; the Jira key then goes into the PR title (and `shipline/gates`
 * matches the PR by either key).
 */
export async function linkIssueToChat(ticketId: string, userId: string, key: string) {
  const { ticket, project } = await loadChatProject(ticketId, userId);
  const session = await getJiraSession();
  const lookup = await jiraCall(() => lookupJiraIssue(session, requireInProject(key, project.jiraProjectKey)));
  if (!lookup.found) throw new HttpError(404, `${key} was not found in Jira`, 'JIRA_NOT_FOUND');
  if (lookup.keyChanged) {
    throw new HttpError(409, `${key} has moved to ${lookup.issue.key}; link that key instead`, 'JIRA_MOVED');
  }
  const issue = lookup.issue;
  const taken = await prisma.ticket.findUnique({
    where: { projectId_jiraKey: { projectId: project.id, jiraKey: issue.key } },
  });
  if (taken && taken.id !== ticket.id) {
    throw new HttpError(409, `${issue.key} is already linked to chat ${taken.key}`, 'JIRA_ALREADY_LINKED');
  }
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      jiraKey: issue.key,
      jiraSummary: issue.summary,
      description: issue.description,
      jiraUrl: issue.url,
      jiraStatus: issue.status,
    },
  });
  await audit({ type: 'chat.jira_linked', actorId: userId, projectId: project.id, ticketId, data: { jiraKey: issue.key } });
  await refreshTicketChecks(ticketId);
  return {
    linked: true,
    chatKey: ticket.key,
    branch: ticket.branch,
    note: ticket.branch
      ? `The branch ${ticket.branch} keeps its name. Put ${issue.key} in the PR title.`
      : `The branch will be named ${issue.key}-<slug> at your first file edit.`,
    issue,
  };
}
