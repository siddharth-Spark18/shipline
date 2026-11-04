import { prisma } from '../lib/prisma';
import { requireProjectAccess } from './access.service';
import { evaluateGates } from './gates.service';
import { pickPullRequest, toTicketPr } from './context.service';
import { currentRun, loadTicketState, runsOfPinnedVersion, toStageContext, toStageSummary } from './stage-state.service';
import { listTransitions } from './workflow.service';

/** Chat detail for the workspace (header, stage popover, status bar) and admin views. */
export async function buildTicketDetail(ticketId: string, userId: string) {
  const state = await loadTicketState(ticketId);
  const access = await requireProjectAccess(userId, state.projectId);
  const [ticket, gates, transitions] = await Promise.all([
    prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: {
        templateVersion: { include: { template: true } },
        owner: { select: { id: true, name: true, githubLogin: true } },
        overrides: { include: { admin: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
        stageRuns: {
          include: { artifacts: { orderBy: { version: 'asc' }, include: { submittedBy: { select: { id: true, name: true } } } } },
        },
        pullRequests: {
          orderBy: { updatedAt: 'desc' },
          include: { _count: { select: { comments: { where: { sentToClaudeAt: null } } } } },
        },
      },
    }),
    evaluateGates(ticketId),
    listTransitions(ticketId, userId),
  ]);
  const latestVersion = await prisma.workflowTemplateVersion.findFirst({
    where: { templateId: ticket.templateVersion.templateId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const artifactsByRun = new Map(ticket.stageRuns.map((r) => [r.id, r.artifacts]));
  const run = currentRun(state.stageRuns);
  const pr = pickPullRequest(ticket.pullRequests, ticket.prNumber);

  return {
    id: ticket.id,
    key: ticket.key,
    jiraKey: ticket.jiraKey,
    title: ticket.title,
    jiraSummary: ticket.jiraSummary,
    description: ticket.description,
    jiraUrl: ticket.jiraUrl,
    jiraStatus: ticket.jiraStatus,
    status: ticket.status,
    template: {
      id: ticket.templateVersion.templateId,
      name: ticket.templateVersion.template.name,
      version: ticket.templateVersion.version,
      latestVersion: latestVersion?.version ?? ticket.templateVersion.version,
      archived: !!ticket.templateVersion.template.archivedAt,
    },
    project: { id: state.project.id, name: state.project.name, githubRepo: state.project.githubRepo, baseBranch: state.project.baseBranch, keyPrefix: state.project.keyPrefix },
    owner: ticket.owner,
    isOwner: ticket.ownerId === userId,
    branch: ticket.branch,
    worktreePath: ticket.worktreePath,
    started: !!ticket.claudeSessionId,
    currentStage: run ? toStageContext(run) : null,
    stages: state.stageRuns.map((r) => ({
      ...toStageSummary(r, artifactsByRun.get(r.id)?.length ?? 0),
      id: r.id,
      artifacts: (artifactsByRun.get(r.id) ?? []).map((a) => ({
        version: a.version,
        type: a.type,
        submittedBy: a.submittedBy,
        createdAt: a.createdAt,
        pluginVersion: a.pluginVersion,
        appVersion: a.appVersion,
        committedPath: a.committedPath,
      })),
    })),
    gates,
    overrides: ticket.overrides.map((o) => ({
      id: o.id,
      kind: o.kind,
      reason: o.reason,
      admin: o.admin,
      createdAt: o.createdAt,
    })),
    pr: toTicketPr(pr),
    newComments: pr?._count.comments ?? 0,
    pendingTransition: transitions.find((t) => t.decision === 'PENDING') ?? null,
    myAccess: { roles: access.roles, isAdmin: access.isAdmin },
  };
}

/** Every chat of a project (admins and members can view; only owners can run). */
export async function buildBoard(projectId: string) {
  const tickets = await prisma.ticket.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
    include: {
      templateVersion: { include: { template: true } },
      owner: { select: { id: true, name: true } },
      stageRuns: { orderBy: { stageDef: { order: 'asc' } }, include: { stageDef: true } },
    },
  });
  return tickets.map((t) => {
    const current = runsOfPinnedVersion(t.stageRuns, t.templateVersionId).find((r) => !['DONE', 'SKIPPED'].includes(r.status)) ?? null;
    return {
      id: t.id,
      key: t.key,
      jiraKey: t.jiraKey,
      title: t.title,
      status: t.status,
      template: { id: t.templateVersion.templateId, name: t.templateVersion.template.name, version: t.templateVersion.version },
      prState: t.prState,
      branch: t.branch,
      owner: t.owner,
      currentStage: current ? { key: current.stageDef.key, name: current.stageDef.name, status: current.status } : null,
    };
  });
}
