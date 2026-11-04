import { Router } from 'express';
import { LocalConfigDTO } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { handle } from '../lib/async-handler';
import { auth } from '../middleware/auth';
import { toLocalProject } from '../services/project-dto';

const router: Router = Router();
router.use(auth);

router.get('/config', (_req, res) => {
  const body: LocalConfigDTO = {
    minPluginVersion: null,
    minClaudeCliVersion: null,
    latestPluginVersion: env.latestPluginVersion,
    apiVersion: env.apiVersion,
  };
  res.json(body);
});

router.get(
  '/projects',
  handle(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { project: true } } },
    });
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    if (user.isAdmin) {
      const all = await prisma.project.findMany();
      res.json(
        all.map((p) => {
          const m = user.memberships.find((x) => x.projectId === p.id);
          return toLocalProject(p, m?.roles ?? [], true);
        }),
      );
      return;
    }
    res.json(user.memberships.map((m) => toLocalProject(m.project, m.roles, m.isAdmin)));
  }),
);

export default router;
