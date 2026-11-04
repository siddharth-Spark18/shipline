import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { verifyToken } from '../lib/jwt';
import { signState, verifyState } from '../lib/signed-state';
import { handle } from '../lib/async-handler';
import { auth } from '../middleware/auth';
import { requireGlobalAdmin } from '../services/access.service';
import {
  buildJiraAuthUrl,
  exchangeJiraCode,
  jiraConfigured,
  listAccessibleSites,
  saveJiraConnection,
} from '../lib/jira-client';

const router: Router = Router();

router.get(
  '/status',
  auth,
  handle(async (_req, res) => {
    const conn = await prisma.jiraConnection.findUnique({ where: { key: 'default' } });
    res.json({
      configured: jiraConfigured(),
      connected: !!conn,
      siteUrl: conn?.siteUrl ?? null,
      siteName: conn?.siteName ?? null,
    });
  }),
);

// Admin-only: connects the org-wide, read-only Jira connection Claude uses to search and link tickets.
router.get(
  '/connect',
  handle(async (req: Request, res: Response) => {
    const raw = (req.headers.authorization?.slice(7) ?? (req.query.token as string | undefined)) || '';
    let userId: string;
    try {
      userId = verifyToken(raw).userId;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    await requireGlobalAdmin(userId);
    res.redirect(buildJiraAuthUrl(signState({ userId })));
  }),
);

router.get(
  '/callback',
  handle(async (req, res) => {
    const back = (q: string): void => res.redirect(`${env.clientUrl}/admin?${q}`);
    const state = verifyState((req.query.state as string | undefined) ?? '');
    const code = req.query.code as string | undefined;
    if (!state || !code) {
      back('jira=error');
      return;
    }
    await requireGlobalAdmin(state.userId);
    const tokens = await exchangeJiraCode(code);
    const sites = await listAccessibleSites(tokens.access_token);
    if (sites.length === 0) {
      back('jira=no_sites');
      return;
    }
    // v1 connects the first accessible site; multi-site selection is not needed for one team.
    await saveJiraConnection(state.userId, tokens, sites[0]);
    back('jira=connected');
  }),
);

export default router;
