import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { TRANSITION_KINDS } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { auth } from '../middleware/auth';
import { requireProjectAccess } from '../services/access.service';
import { buildTicketDetail } from '../services/ticket-view.service';
import { getSessionContext } from '../services/context.service';
import { renameChat } from '../services/chat.service';
import {
  createOverride,
  decideTransition,
  listTransitions,
  proposeTransition,
  recordClaudeSession,
  recordWorkspace,
} from '../services/workflow.service';
import { listPendingToolDecisions } from '../services/tool-decision.service';
import { decideTemplateSwitch, listTemplateSwitches } from '../services/template-switch.service';
import { listPrComments, markCommentsSent } from '../services/pr-sync.service';

const router: Router = Router();
router.use(auth);

router.get(
  '/:id',
  handle(async (req, res) => {
    res.json(await buildTicketDetail(req.params.id, req.user!.userId));
  }),
);

// The title is set from the first message and editable (owner only).
router.patch(
  '/:id',
  [body('title').isString().notEmpty().withMessage('A title is required')],
  handle(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new HttpError(400, errors.array()[0].msg as string);
    await renameChat(req.params.id, req.user!.userId, (req.body as { title: string }).title);
    res.status(204).end();
  }),
);

// What Shipline Local needs to run the chat's one Claude session (owner only).
router.get(
  '/:id/context',
  handle(async (req, res) => {
    res.json(await getSessionContext(req.params.id, req.user!.userId));
  }),
);

router.put(
  '/:id/session',
  handle(async (req, res) => {
    const { claudeSessionId } = req.body as { claudeSessionId?: string };
    if (!claudeSessionId) throw new HttpError(400, 'claudeSessionId is required');
    await recordClaudeSession(req.params.id, req.user!.userId, claudeSessionId);
    res.status(204).end();
  }),
);

router.put(
  '/:id/workspace',
  handle(async (req, res) => {
    // `branch` is null while the worktree is still detached (no file edit yet).
    const { branch, worktreePath } = req.body as { branch?: string | null; worktreePath?: string };
    if (!worktreePath) throw new HttpError(400, 'worktreePath is required');
    await recordWorkspace(req.params.id, req.user!.userId, { branch: branch || null, worktreePath });
    res.status(204).end();
  }),
);

router.get(
  '/:id/tool-decisions/pending',
  handle(async (req, res) => {
    res.json(await listPendingToolDecisions(req.params.id, req.user!.userId));
  }),
);

// --- Stage transitions: Claude proposes (via MCP), the chat owner confirms or declines ---

router.get(
  '/:id/transitions',
  handle(async (req, res) => {
    res.json(await listTransitions(req.params.id, req.user!.userId));
  }),
);

// A person-made proposal is confirmed immediately (the owner is the one asking).
router.post(
  '/:id/transitions',
  [body('kind').isIn([...TRANSITION_KINDS])],
  handle(async (req, res) => {
    const b = req.body as { kind: (typeof TRANSITION_KINDS)[number]; reason?: string; targetStageKey?: string };
    const proposal = await proposeTransition(req.params.id, req.user!.userId, {
      kind: b.kind,
      reason: b.reason ?? '',
      targetStageKey: b.targetStageKey,
      proposedBy: 'user',
    });
    res.status(201).json(await decideTransition(req.params.id, proposal.id, req.user!.userId, true));
  }),
);

router.post(
  '/:id/transitions/:transitionId/confirm',
  handle(async (req, res) => {
    res.json(await decideTransition(req.params.id, req.params.transitionId, req.user!.userId, true));
  }),
);

router.post(
  '/:id/transitions/:transitionId/decline',
  handle(async (req, res) => {
    res.json(await decideTransition(req.params.id, req.params.transitionId, req.user!.userId, false));
  }),
);

// --- Template switches: Claude proposes (via MCP) before the branch exists, the chat owner confirms or declines ---

router.get(
  '/:id/template-switches',
  handle(async (req, res) => {
    res.json(await listTemplateSwitches(req.params.id, req.user!.userId));
  }),
);

router.post(
  '/:id/template-switches/:switchId/confirm',
  handle(async (req, res) => {
    res.json(await decideTemplateSwitch(req.params.id, req.params.switchId, req.user!.userId, true));
  }),
);

router.post(
  '/:id/template-switches/:switchId/decline',
  handle(async (req, res) => {
    res.json(await decideTemplateSwitch(req.params.id, req.params.switchId, req.user!.userId, false));
  }),
);

// --- PR comments (synced from GitHub webhooks) ---

router.get(
  '/:id/pr-comments',
  handle(async (req, res) => {
    res.json(await listPrComments(req.params.id, req.user!.userId));
  }),
);

router.post(
  '/:id/pr-comments/mark-sent',
  handle(async (req, res) => {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new HttpError(400, 'ids must be an array of strings');
    await markCommentsSent(req.params.id, req.user!.userId, ids as string[]);
    res.status(204).end();
  }),
);

router.get(
  '/:id/audit',
  handle(async (req, res) => {
    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    await requireProjectAccess(req.user!.userId, ticket.projectId);
    const events = await prisma.auditEvent.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, name: true } } },
    });
    res.json(events.map((e) => ({ id: e.id, type: e.type, data: e.data, actor: e.actor, createdAt: e.createdAt })));
  }),
);

router.get(
  '/:id/tool-decisions',
  handle(async (req, res) => {
    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    await requireProjectAccess(req.user!.userId, ticket.projectId);
    const rows = await prisma.toolDecision.findMany({
      where: { stageRun: { ticketId: ticket.id } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true } }, stageRun: { include: { stageDef: true } } },
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        stage: r.stageRun.stageDef.name,
        tool: r.tool,
        inputSummary: r.inputSummary,
        decision: r.decision,
        decidedBy: r.decidedBy,
        reason: r.reason,
        user: r.user,
        pluginVersion: r.pluginVersion,
        appVersion: r.appVersion,
        createdAt: r.createdAt,
      })),
    );
  }),
);

router.post(
  '/:id/override',
  [body('reason').notEmpty().withMessage('A reason is required')],
  handle(async (req, res) => {
    const b = req.body as { reason: string; kind?: 'GATES' | 'HOTFIX' };
    const o = await createOverride(req.params.id, req.user!.userId, b.kind === 'HOTFIX' ? 'HOTFIX' : 'GATES', b.reason);
    res.status(201).json({ id: o.id });
  }),
);

export default router;
