import { NextFunction, Request, Response, Router } from 'express';
import { CustomAgentInput, GuardrailRuleInput, ImportTemplateRequestDTO, PLUGIN_AGENTS, SaveTemplateRequestDTO, TemplateDraftDTO } from '@shipline/shared';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { auth } from '../middleware/auth';
import { requireGlobalAdmin } from '../services/access.service';
import { createCustomAgent, deleteCustomAgent, listCustomAgents, updateCustomAgent } from '../services/agent.service';
import { createRule, deleteRule, listOrgRules, updateRule } from '../services/guardrail.service';
import {
  createTemplate,
  deleteTemplate,
  exportTemplate,
  getTemplate,
  getVersion,
  importTemplate,
  listTemplates,
  saveTemplateVersion,
  setTemplateArchived,
} from '../services/template.service';

// Org admin module: the workflow template library, custom agents and the org guardrail baseline.
// Every route needs `User.isAdmin`; the services check it again and write the audit log.
const router: Router = Router();
router.use(auth);
router.use((req: Request, res: Response, next: NextFunction) => {
  requireGlobalAdmin(req.user!.userId).then(
    () => next(),
    (err: unknown) => {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message, code: err.code });
      else next(err);
    },
  );
});

// --- Workflow templates ---

router.get(
  '/templates',
  handle(async (_req, res) => {
    res.json(await listTemplates());
  }),
);

router.post(
  '/templates',
  handle(async (req, res) => {
    res.status(201).json(await createTemplate(req.user!.userId, req.body as TemplateDraftDTO));
  }),
);

// Import must be declared before `/templates/:id`.
router.post(
  '/templates/import',
  handle(async (req, res) => {
    const b = req.body as ImportTemplateRequestDTO;
    res.status(201).json(await importTemplate(req.user!.userId, b.data, !!b.createMissingAgents));
  }),
);

router.get(
  '/templates/:id',
  handle(async (req, res) => {
    res.json(await getTemplate(req.params.id));
  }),
);

router.get(
  '/templates/:id/versions/:version',
  handle(async (req, res) => {
    res.json(await getVersion(req.params.id, Number(req.params.version)));
  }),
);

// Saving creates a new immutable version.
router.put(
  '/templates/:id',
  handle(async (req, res) => {
    res.json(await saveTemplateVersion(req.user!.userId, req.params.id, req.body as SaveTemplateRequestDTO));
  }),
);

router.post(
  '/templates/:id/archive',
  handle(async (req, res) => {
    res.json(await setTemplateArchived(req.user!.userId, req.params.id, true));
  }),
);

router.post(
  '/templates/:id/restore',
  handle(async (req, res) => {
    res.json(await setTemplateArchived(req.user!.userId, req.params.id, false));
  }),
);

router.delete(
  '/templates/:id',
  handle(async (req, res) => {
    await deleteTemplate(req.user!.userId, req.params.id);
    res.status(204).end();
  }),
);

router.get(
  '/templates/:id/export',
  handle(async (req, res) => {
    res.json(await exportTemplate(req.params.id));
  }),
);

// --- Custom agents (and the plugin's bundled ones, for the stage agent picker) ---

router.get(
  '/agents',
  handle(async (_req, res) => {
    res.json({ custom: await listCustomAgents(), plugin: PLUGIN_AGENTS });
  }),
);

router.post(
  '/agents',
  handle(async (req, res) => {
    res.status(201).json(await createCustomAgent(req.user!.userId, req.body as CustomAgentInput));
  }),
);

router.put(
  '/agents/:id',
  handle(async (req, res) => {
    res.json(await updateCustomAgent(req.user!.userId, req.params.id, req.body as Omit<CustomAgentInput, 'name'>));
  }),
);

router.delete(
  '/agents/:id',
  handle(async (req, res) => {
    await deleteCustomAgent(req.user!.userId, req.params.id);
    res.status(204).end();
  }),
);

// --- Org guardrails ---

router.get(
  '/guardrails',
  handle(async (_req, res) => {
    res.json(await listOrgRules());
  }),
);

router.post(
  '/guardrails',
  handle(async (req, res) => {
    res.status(201).json(await createRule(req.user!.userId, { scope: 'ORG' }, req.body as GuardrailRuleInput));
  }),
);

router.put(
  '/guardrails/:id',
  handle(async (req, res) => {
    res.json(await updateRule(req.user!.userId, null, req.params.id, req.body as GuardrailRuleInput));
  }),
);

router.delete(
  '/guardrails/:id',
  handle(async (req, res) => {
    await deleteRule(req.user!.userId, null, req.params.id);
    res.status(204).end();
  }),
);

export default router;
