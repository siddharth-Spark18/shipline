import { Router, Request } from 'express';
import { ArtifactType } from '@prisma/client';
import { ARTIFACT_TYPES, HEADER_APP_VERSION, HEADER_CLIENT, HEADER_PLUGIN_VERSION } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { getArtifactContent } from '../lib/artifact-storage';
import { auth } from '../middleware/auth';
import { requireProjectAccess } from '../services/access.service';
import { submitArtifact } from '../services/workflow.service';
import { resolveToolDecision } from '../services/tool-decision.service';

// Stage runs are now just status rows; what remains here is their artifacts. Claiming, approving,
// assigning and skipping through REST are gone (continuous flow: the chat's owner runs it).
const router: Router = Router();
router.use(auth);

const header = (req: Request, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
};

router.post('/:id/artifacts', handle(async (req, res) => {
  const b = req.body as { type?: string; content?: string };
  if (!b.type || !ARTIFACT_TYPES.includes(b.type as ArtifactType) || typeof b.content !== 'string') {
    throw new HttpError(400, 'type and content are required');
  }
  const run = await prisma.stageRun.findUnique({ where: { id: req.params.id } });
  if (!run) throw new HttpError(404, 'Stage run not found');
  const artifact = await submitArtifact(
    run.ticketId,
    req.user!.userId,
    {
      type: b.type as ArtifactType,
      content: b.content,
      pluginVersion: header(req, HEADER_PLUGIN_VERSION),
      appVersion: header(req, HEADER_APP_VERSION),
      clientKind: header(req, HEADER_CLIENT) ?? 'rest',
    },
    run.id,
  );
  res.status(201).json({ version: artifact.version });
}));

router.get('/:id/artifacts/:version', handle(async (req, res) => {
  const run = await prisma.stageRun.findUnique({ where: { id: req.params.id }, include: { ticket: true } });
  if (!run) throw new HttpError(404, 'Stage run not found');
  await requireProjectAccess(req.user!.userId, run.ticket.projectId);
  const artifact = await prisma.artifact.findUnique({
    where: { stageRunId_version: { stageRunId: run.id, version: Number(req.params.version) } },
  });
  if (!artifact) throw new HttpError(404, 'Artifact not found');
  res.json({ version: artifact.version, type: artifact.type, content: getArtifactContent(artifact), createdAt: artifact.createdAt });
}));

function parseAnswers(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'answers must be an object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v !== 'string')) throw new HttpError(400, 'answers values must be strings');
  return Object.fromEntries(entries) as Record<string, string>;
}

export const toolDecisionRouter: Router = Router();
toolDecisionRouter.use(auth);
toolDecisionRouter.post('/:id/resolve', handle(async (req, res) => {
  const { allow, answers } = req.body as { allow?: boolean; answers?: unknown };
  await resolveToolDecision(req.params.id, req.user!.userId, !!allow, parseAnswers(answers));
  res.status(204).end();
}));

export default router;
