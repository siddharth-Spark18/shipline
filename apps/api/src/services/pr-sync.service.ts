import { Project, PullRequest } from '@prisma/client';
import { PrCommentDTO, TicketPrCommentsDTO } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { ghRequest, githubAppConfigured } from '../lib/github-app';
import { requireProjectAccess } from './access.service';
import { findTicketForPullRequest } from './checks.service';
import { pickPullRequest, toTicketPr } from './context.service';
import { completeOnMerge } from './workflow.service';

export interface GhPullRequest {
  title: string;
  html_url?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  head: { sha: string; ref: string };
}

// Review payloads carry a slimmer PR object: `merged` may be absent, `merged_at` is the reliable signal.
const prState = (pr: GhPullRequest): 'OPEN' | 'CLOSED' | 'MERGED' =>
  pr.merged || pr.merged_at ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';

/**
 * Creates/updates the tracked PR from any webhook payload that carries it, links it to the chat
 * named in the branch or title, and mirrors number/state onto the ticket. A merge ends the ticket.
 */
export async function upsertPullRequest(project: Project, number: number, gh: GhPullRequest): Promise<PullRequest> {
  const previous = await prisma.pullRequest.findUnique({ where: { projectId_number: { projectId: project.id, number } } });
  // A merged PR never goes back (late review events must not reopen it).
  const state = previous?.state === 'MERGED' ? 'MERGED' : prState(gh);
  const data = {
    headSha: gh.head.sha,
    branch: gh.head.ref,
    title: gh.title,
    state,
    htmlUrl: gh.html_url ?? null,
    ...(state === 'MERGED' && previous?.state !== 'MERGED' ? { mergedAt: new Date() } : {}),
  };
  const pr = await prisma.pullRequest.upsert({
    where: { projectId_number: { projectId: project.id, number } },
    create: { projectId: project.id, number, ...data },
    update: data,
  });

  const ticket = await findTicketForPullRequest(project.id, gh.head.ref, gh.title);
  if (ticket) {
    if (pr.ticketId !== ticket.id) await prisma.pullRequest.update({ where: { id: pr.id }, data: { ticketId: ticket.id } });
    const alreadyMerged = ticket.prState === 'MERGED';
    if (!alreadyMerged) await prisma.ticket.update({ where: { id: ticket.id }, data: { prNumber: number, prState: state } });
    if (state === 'MERGED' && !alreadyMerged) await completeOnMerge(ticket.id);
  }
  return { ...pr, ticketId: ticket?.id ?? pr.ticketId };
}

interface ReviewPayload {
  action: string;
  review: {
    id: number;
    user?: { login: string } | null;
    body?: string | null;
    state: string;
    html_url?: string;
    commit_id?: string;
  };
  pull_request: GhPullRequest & { number: number };
}

export async function handleReviewEvent(project: Project, p: ReviewPayload): Promise<void> {
  const pr = await upsertPullRequest(project, p.pull_request.number, p.pull_request);
  const state = p.review.state.toUpperCase();
  const body = (p.review.body ?? '').trim();
  // A comment-only review without a body is just the container of inline comments (stored separately).
  if (state === 'COMMENTED' && !body) return;
  const data = {
    author: p.review.user?.login ?? 'unknown',
    body,
    reviewState: p.action === 'dismissed' ? 'DISMISSED' : state,
    htmlUrl: p.review.html_url ?? null,
    commitId: p.review.commit_id ?? null,
  };
  await prisma.prComment.upsert({
    where: { pullRequestId_kind_githubId: { pullRequestId: pr.id, kind: 'REVIEW', githubId: String(p.review.id) } },
    create: { pullRequestId: pr.id, kind: 'REVIEW', githubId: String(p.review.id), ...data },
    update: data,
  });
}

interface ReviewCommentPayload {
  action: string;
  comment: {
    id: number;
    user?: { login: string } | null;
    body: string;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    position?: number | null;
    html_url?: string;
    commit_id?: string;
  };
  pull_request: GhPullRequest & { number: number };
}

export async function handleReviewCommentEvent(project: Project, p: ReviewCommentPayload): Promise<void> {
  const pr = await upsertPullRequest(project, p.pull_request.number, p.pull_request);
  const where = { pullRequestId_kind_githubId: { pullRequestId: pr.id, kind: 'REVIEW_COMMENT' as const, githubId: String(p.comment.id) } };
  if (p.action === 'deleted') {
    await prisma.prComment.deleteMany({ where: { pullRequestId: pr.id, kind: 'REVIEW_COMMENT', githubId: String(p.comment.id) } });
    return;
  }
  const data = {
    author: p.comment.user?.login ?? 'unknown',
    body: p.comment.body,
    path: p.comment.path ?? null,
    line: p.comment.line ?? p.comment.original_line ?? null,
    // GitHub sets `position` to null once a push made the comment's diff position obsolete.
    outdated: p.comment.position === null,
    htmlUrl: p.comment.html_url ?? null,
    commitId: p.comment.commit_id ?? null,
  };
  await prisma.prComment.upsert({
    where,
    create: { pullRequestId: pr.id, kind: 'REVIEW_COMMENT', githubId: String(p.comment.id), ...data },
    update: data,
  });
}

/**
 * After a push (`synchronize`), asks GitHub which inline comments are now outdated. Best effort:
 * webhooks alone do not announce that an existing comment became outdated.
 */
export async function refreshOutdatedComments(project: Project, pr: PullRequest): Promise<void> {
  if (!githubAppConfigured()) return;
  const { data } = await ghRequest<Array<{ id: number; position: number | null }>>(
    project,
    `/repos/${project.githubRepo}/pulls/${pr.number}/comments?per_page=100`,
  );
  for (const c of data ?? []) {
    await prisma.prComment.updateMany({
      where: { pullRequestId: pr.id, kind: 'REVIEW_COMMENT', githubId: String(c.id) },
      data: { outdated: c.position === null },
    });
  }
}

const toCommentDTO = (c: {
  id: string;
  kind: 'REVIEW' | 'REVIEW_COMMENT';
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  reviewState: string | null;
  outdated: boolean;
  htmlUrl: string | null;
  createdAt: Date;
  sentToClaudeAt: Date | null;
}): PrCommentDTO => ({
  id: c.id,
  kind: c.kind,
  author: c.author,
  body: c.body,
  path: c.path,
  line: c.line,
  reviewState: c.reviewState,
  outdated: c.outdated,
  htmlUrl: c.htmlUrl,
  createdAt: c.createdAt.toISOString(),
  sentToClaudeAt: c.sentToClaudeAt?.toISOString() ?? null,
});

async function loadTicketForComments(ticketId: string, userId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { pullRequests: { orderBy: { updatedAt: 'desc' } } } });
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  await requireProjectAccess(userId, ticket.projectId);
  return ticket;
}

export async function listPrComments(ticketId: string, userId: string): Promise<TicketPrCommentsDTO> {
  const ticket = await loadTicketForComments(ticketId, userId);
  const pr = pickPullRequest(ticket.pullRequests, ticket.prNumber);
  if (!pr) return { pullRequest: null, comments: [], newCount: 0 };
  const rows = await prisma.prComment.findMany({ where: { pullRequestId: pr.id }, orderBy: { createdAt: 'asc' } });
  return {
    pullRequest: toTicketPr(pr),
    comments: rows.map(toCommentDTO),
    newCount: rows.filter((r) => !r.sentToClaudeAt).length,
  };
}

/** Records that these comments were posted into the chat ("Send to Claude"). */
export async function markCommentsSent(ticketId: string, userId: string, ids: string[]): Promise<void> {
  const ticket = await loadTicketForComments(ticketId, userId);
  if (ticket.ownerId !== userId) throw new HttpError(403, 'This chat belongs to someone else. Only its owner can run it.', 'NOT_OWNER');
  const { count } = await prisma.prComment.updateMany({
    where: { id: { in: ids }, pullRequest: { ticketId }, sentToClaudeAt: null },
    data: { sentToClaudeAt: new Date() },
  });
  await audit({ type: 'pr_comments.sent', actorId: userId, projectId: ticket.projectId, ticketId, data: { count } });
}
