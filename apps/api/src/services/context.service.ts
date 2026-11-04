import {
  PullRequestState,
  TicketPrDTO,
  TicketSessionContextDTO,
  UpstreamArtifactDTO,
  branchNameFor,
} from '@shipline/shared';
import { PullRequest } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { getArtifactContent } from '../lib/artifact-storage';
import { requireProjectAccess } from './access.service';
import { toLocalProject } from './project-dto';
import { customAgentsForVersion } from './agent.service';
import { effectiveRulesFor } from './guardrail.service';
import { switchableTemplates } from './template.service';
import { currentRun, loadTicketState, toStageContext, toStageSummary } from './stage-state.service';

/** Latest artifact of every DONE stage, in stage order (so Claude can read plan/wireframes/QA). */
export async function getDoneArtifacts(ticketId: string): Promise<UpstreamArtifactDTO[]> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { templateVersionId: true } });
  const runs = await prisma.stageRun.findMany({
    where: { ticketId, status: 'DONE', stageDef: { versionId: ticket?.templateVersionId ?? '' } },
    include: { stageDef: true, artifacts: { orderBy: { version: 'desc' }, take: 1 } },
    orderBy: { stageDef: { order: 'asc' } },
  });
  const out: UpstreamArtifactDTO[] = [];
  for (const run of runs) {
    const artifact = run.artifacts[0];
    if (!artifact) continue;
    out.push({
      stageKey: run.stageDef.key,
      stageName: run.stageDef.name,
      version: artifact.version,
      type: artifact.type,
      content: getArtifactContent(artifact),
    });
  }
  return out;
}

export function toTicketPr(pr: PullRequest | null | undefined): TicketPrDTO | null {
  if (!pr) return null;
  return {
    number: pr.number,
    state: pr.state as PullRequestState,
    url: pr.htmlUrl,
    title: pr.title,
    headSha: pr.headSha,
  };
}

/** The ticket's PR: the one the ticket points at, else the most recently updated. */
export function pickPullRequest<T extends PullRequest>(prs: T[], prNumber: number | null): T | null {
  return prs.find((p) => p.number === prNumber) ?? prs[0] ?? null;
}

export async function getSessionContext(ticketId: string, userId: string): Promise<TicketSessionContextDTO> {
  const state = await loadTicketState(ticketId);
  const access = await requireProjectAccess(userId, state.projectId);
  if (state.ownerId !== userId) {
    throw new HttpError(403, 'This chat belongs to someone else. Only its owner can run it.', 'NOT_OWNER');
  }
  const counts = await prisma.artifact.groupBy({
    by: ['stageRunId'],
    where: { stageRun: { ticketId } },
    _count: true,
  });
  const run = currentRun(state.stageRuns);
  const [guardrails, customAgents, latest] = await Promise.all([
    effectiveRulesFor(state.projectId, run?.stageDef ?? null),
    customAgentsForVersion(state.templateVersionId),
    prisma.workflowTemplateVersion.findFirst({
      where: { templateId: state.templateVersion.templateId },
      orderBy: { version: 'desc' },
      select: { version: true },
    }),
  ]);
  return {
    ticketId,
    claudeSessionId: state.claudeSessionId,
    project: toLocalProject(state.project, access.roles, access.isAdmin),
    ticket: {
      key: state.key,
      jiraKey: state.jiraKey,
      title: state.title,
      description: state.description,
      url: state.jiraUrl,
      branch: state.branch,
      worktreePath: state.worktreePath,
      suggestedBranch: branchNameFor({ key: state.key, jiraKey: state.jiraKey, title: state.title }),
    },
    template: {
      id: state.templateVersion.templateId,
      name: state.templateVersion.template.name,
      version: state.templateVersion.version,
      latestVersion: latest?.version ?? state.templateVersion.version,
    },
    currentStage: run ? toStageContext(run) : null,
    stages: state.stageRuns.map((r) => toStageSummary(r, counts.find((c) => c.stageRunId === r.id)?._count ?? 0)),
    switchableTemplates: await switchableTemplates(state.projectId, state.templateVersion.templateId, state.branch),
    guardrails,
    customAgents,
    doneArtifacts: await getDoneArtifacts(ticketId),
  };
}
