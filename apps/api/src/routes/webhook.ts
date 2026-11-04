import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { handle } from '../lib/async-handler';
import { publishGatesCheck } from '../services/checks.service';
import {
  GhPullRequest,
  handleReviewCommentEvent,
  handleReviewEvent,
  refreshOutdatedComments,
  upsertPullRequest,
} from '../services/pr-sync.service';

const router: Router = Router();

function validSignature(req: Request): boolean {
  if (!env.githubWebhookSecret || !req.rawBody) return false;
  const sig = req.headers['x-hub-signature-256'];
  if (typeof sig !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', env.githubWebhookSecret).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface PullRequestPayload {
  action: string;
  number: number;
  installation?: { id: number };
  repository: { full_name: string };
  pull_request: GhPullRequest;
}

const HANDLED_EVENTS = ['pull_request', 'pull_request_review', 'pull_request_review_comment'];
const PR_ACTIONS = ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review', 'closed'];

router.post(
  '/github',
  handle(async (req: Request, res: Response) => {
    if (!validSignature(req)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    const event = String(req.headers['x-github-event'] ?? '');
    if (!HANDLED_EVENTS.includes(event)) {
      res.json({ ignored: true });
      return;
    }
    const p = req.body as PullRequestPayload;
    const project = await prisma.project.findUnique({ where: { githubRepo: p.repository.full_name } });
    if (!project) {
      res.json({ ignored: 'unregistered repo' });
      return;
    }
    if (p.installation && !project.githubInstallationId) {
      await prisma.project.update({ where: { id: project.id }, data: { githubInstallationId: String(p.installation.id) } });
    }

    if (event === 'pull_request_review') {
      await handleReviewEvent(project, req.body);
      res.json({ accepted: true });
      return;
    }
    if (event === 'pull_request_review_comment') {
      await handleReviewCommentEvent(project, req.body);
      res.json({ accepted: true });
      return;
    }

    if (!PR_ACTIONS.includes(p.action)) {
      res.json({ ignored: p.action });
      return;
    }
    const pr = await upsertPullRequest(project, p.number, p.pull_request);
    // Respond first; GitHub expects a fast reply and the follow-ups are best-effort.
    res.json({ accepted: true });
    const withInstallation = { ...project, githubInstallationId: project.githubInstallationId ?? (p.installation ? String(p.installation.id) : null) };
    if (p.action !== 'closed') {
      publishGatesCheck(withInstallation, pr.id).catch((err) => console.error('Failed to publish gates check:', err));
    }
    if (p.action === 'synchronize') {
      refreshOutdatedComments(withInstallation, pr).catch((err) => console.error('Failed to refresh outdated comments:', err));
    }
  }),
);

export default router;
