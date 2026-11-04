import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { Prisma, Role, SessionMode } from '@prisma/client';
import { DEFAULT_ROLE_EDIT_POLICIES, EDIT_POLICIES, GuardrailRuleInput, KEY_PREFIX_PATTERN, ROLES, SaveProjectTemplatesRequestDTO, normalizeKeyPrefix } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { auth } from '../middleware/auth';
import { requireGlobalAdmin, requireProjectAccess, requireProjectAdmin } from '../services/access.service';
import { buildBoard } from '../services/ticket-view.service';
import { projectEditPolicies } from '../services/policy-config';
import { listCollaborators, githubAppConfigured } from '../lib/github-app';
import { createRule, deleteRule, listProjectGuardrails, updateRule } from '../services/guardrail.service';
import { enableBuiltInsForProject, listProjectTemplates, saveProjectTemplates } from '../services/template.service';

const router: Router = Router();
router.use(auth);

function validate(req: Parameters<typeof validationResult>[0]): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new HttpError(400, errors.array()[0].msg as string);
}

const projectView = (p: Prisma.ProjectGetPayload<object>) => ({
  id: p.id,
  name: p.name,
  githubRepo: p.githubRepo,
  jiraProjectKey: p.jiraProjectKey,
  keyPrefix: p.keyPrefix,
  commitArtifactsToRepo: p.commitArtifactsToRepo,
  artifactRepoPath: p.artifactRepoPath,
  artifactBranch: p.artifactBranch,
  qaTarget: p.qaTarget,
  minPluginVersion: p.minPluginVersion,
  minClaudeCliVersion: p.minClaudeCliVersion,
  sessionMode: p.sessionMode,
  baseBranch: p.baseBranch,
  editPolicy: projectEditPolicies(p),
});

router.get(
  '/',
  handle(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) throw new HttpError(401, 'User not found');
    const projects = await prisma.project.findMany({
      where: user.isAdmin ? {} : { members: { some: { userId: user.id } } },
      orderBy: { name: 'asc' },
    });
    res.json(projects.map(projectView));
  }),
);

router.post(
  '/',
  [
    body('name').notEmpty(),
    body('githubRepo').matches(/^[\w.-]+\/[\w.-]+$/).withMessage('githubRepo must be owner/name'),
    body('jiraProjectKey').notEmpty(),
    body('keyPrefix').customSanitizer((v) => (typeof v === 'string' ? normalizeKeyPrefix(v) : v)).matches(KEY_PREFIX_PATTERN).withMessage('keyPrefix must be 2-10 letters or digits, starting with a letter (e.g. LL)'),
  ],
  handle(async (req, res) => {
    validate(req);
    await requireGlobalAdmin(req.user!.userId);
    const b = req.body as { name: string; githubRepo: string; jiraProjectKey: string; keyPrefix: string };
    const project = await prisma.project.create({
      data: {
        name: b.name,
        githubRepo: b.githubRepo,
        jiraProjectKey: b.jiraProjectKey.toUpperCase(),
        keyPrefix: b.keyPrefix,
        editPolicy: DEFAULT_ROLE_EDIT_POLICIES,
        members: { create: { userId: req.user!.userId, roles: [], isAdmin: true } },
      },
    });
    // A new project offers the built-in templates (Feature as the default) until its admin changes that.
    await enableBuiltInsForProject(project.id);
    await audit({ type: 'project.created', actorId: req.user!.userId, projectId: project.id });
    res.status(201).json(projectView(project));
  }),
);

router.get(
  '/:id',
  handle(async (req, res) => {
    const access = await requireProjectAccess(req.user!.userId, req.params.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { members: { include: { user: true } } },
    });
    if (!project) throw new HttpError(404, 'Project not found');
    res.json({
      ...projectView(project),
      members: project.members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        githubLogin: m.user.githubLogin,
        roles: m.roles,
        isAdmin: m.isAdmin,
      })),
      myAccess: { roles: access.roles, isAdmin: access.isAdmin },
    });
  }),
);

router.patch(
  '/:id',
  handle(async (req, res) => {
    await requireProjectAdmin(req.user!.userId, req.params.id);
    const b = req.body as Record<string, unknown>;
    const data: Prisma.ProjectUpdateInput = {};
    if (typeof b.name === 'string') data.name = b.name;
    if (typeof b.jiraProjectKey === 'string') data.jiraProjectKey = b.jiraProjectKey.toUpperCase();
    if (typeof b.keyPrefix === 'string') {
      // Only affects chats created from now on: existing keys (LL-12) never change.
      const prefix = normalizeKeyPrefix(b.keyPrefix);
      if (!KEY_PREFIX_PATTERN.test(prefix)) throw new HttpError(400, 'keyPrefix must be 2-10 letters or digits, starting with a letter (e.g. LL)');
      data.keyPrefix = prefix;
    }
    if (typeof b.commitArtifactsToRepo === 'boolean') data.commitArtifactsToRepo = b.commitArtifactsToRepo;
    if (typeof b.artifactRepoPath === 'string') data.artifactRepoPath = b.artifactRepoPath;
    if (b.artifactBranch === null || typeof b.artifactBranch === 'string') data.artifactBranch = (b.artifactBranch as string | null) || null;
    if (b.qaTarget !== undefined) data.qaTarget = b.qaTarget === null ? Prisma.DbNull : (b.qaTarget as Prisma.InputJsonValue);
    if (b.minPluginVersion === null || typeof b.minPluginVersion === 'string') data.minPluginVersion = (b.minPluginVersion as string | null) || null;
    if (b.minClaudeCliVersion === null || typeof b.minClaudeCliVersion === 'string') data.minClaudeCliVersion = (b.minClaudeCliVersion as string | null) || null;
    if (b.sessionMode === 'CHAT' || b.sessionMode === 'TERMINAL') data.sessionMode = b.sessionMode as SessionMode;
    if (typeof b.baseBranch === 'string' && b.baseBranch.trim()) data.baseBranch = b.baseBranch.trim();
    if (b.editPolicy && typeof b.editPolicy === 'object') {
      const merged = { ...DEFAULT_ROLE_EDIT_POLICIES };
      const incoming = b.editPolicy as Record<string, string>;
      for (const role of ROLES) {
        const v = incoming[role];
        if (v && (EDIT_POLICIES as readonly string[]).includes(v)) merged[role] = v as (typeof EDIT_POLICIES)[number];
      }
      data.editPolicy = merged;
    }
    const project = await prisma.project.update({ where: { id: req.params.id }, data });
    await audit({ type: 'project.updated', actorId: req.user!.userId, projectId: project.id, data: { fields: Object.keys(b) } });
    // The per-role code-edit default is the role level's default edit rule: log it as a rule change.
    if (data.editPolicy) await audit({ type: 'guardrail.role_edit_default_updated', actorId: req.user!.userId, projectId: project.id, data: { editPolicy: data.editPolicy as Prisma.InputJsonValue } });
    res.json(projectView(project));
  }),
);

router.put(
  '/:id/members',
  [body('email').isEmail(), body('roles').isArray()],
  handle(async (req, res) => {
    validate(req);
    await requireProjectAdmin(req.user!.userId, req.params.id);
    const b = req.body as { email: string; roles: string[]; isAdmin?: boolean };
    const email = b.email.toLowerCase();
    const roles = b.roles.filter((r): r is Role => ROLES.includes(r as Role));
    // The user row may not exist yet; Google sign-in later attaches to it by email.
    const user = await prisma.user.upsert({ where: { email }, create: { email, name: email }, update: {} });
    const member = await prisma.projectMember.upsert({
      where: { userId_projectId: { userId: user.id, projectId: req.params.id } },
      create: { userId: user.id, projectId: req.params.id, roles, isAdmin: !!b.isAdmin },
      update: { roles, isAdmin: !!b.isAdmin },
    });
    await audit({ type: 'member.upserted', actorId: req.user!.userId, projectId: req.params.id, data: { email, roles, isAdmin: !!b.isAdmin } });
    res.json({ userId: member.userId, roles: member.roles, isAdmin: member.isAdmin });
  }),
);

router.delete(
  '/:id/members/:userId',
  handle(async (req, res) => {
    await requireProjectAdmin(req.user!.userId, req.params.id);
    await prisma.projectMember.delete({
      where: { userId_projectId: { userId: req.params.userId, projectId: req.params.id } },
    });
    await audit({ type: 'member.removed', actorId: req.user!.userId, projectId: req.params.id, data: { userId: req.params.userId } });
    res.status(204).end();
  }),
);

/**
 * Warns when GitHub repo permissions don't match Shipline roles (e.g. a designer with write
 * access). Warning only: Shipline never changes GitHub permissions.
 */
router.get(
  '/:id/github-warnings',
  handle(async (req, res) => {
    await requireProjectAccess(req.user!.userId, req.params.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { members: { include: { user: true } } },
    });
    if (!project) throw new HttpError(404, 'Project not found');
    if (!githubAppConfigured()) {
      res.json({ available: false, warnings: [] });
      return;
    }
    const collaborators = await listCollaborators(project);
    const warnings: Array<{ login: string; name: string | null; message: string }> = [];
    for (const c of collaborators) {
      const canWrite = c.permissions.admin || c.permissions.maintain || c.permissions.push;
      const member = project.members.find((m) => m.user.githubLogin?.toLowerCase() === c.login.toLowerCase());
      if (!member) {
        if (canWrite) warnings.push({ login: c.login, name: null, message: 'Has write access but is not linked to a Shipline member.' });
        continue;
      }
      if (canWrite && !member.roles.includes('DEVELOPER') && !member.isAdmin) {
        warnings.push({
          login: c.login,
          name: member.user.name,
          message: `Has write access on GitHub but is not a Developer (${member.roles.join(', ') || 'no role'}).`,
        });
      }
    }
    const unlinked = project.members
      .filter((m) => !m.user.githubLogin)
      .map((m) => ({ login: '', name: m.user.name, message: 'Has not linked a GitHub account; permissions cannot be compared.' }));
    res.json({ available: true, warnings: [...warnings, ...unlinked] });
  }),
);

// --- Workflow templates the project offers for new chats ---

router.get(
  '/:id/templates',
  handle(async (req, res) => {
    res.json(await listProjectTemplates(req.user!.userId, req.params.id));
  }),
);

router.put(
  '/:id/templates',
  handle(async (req, res) => {
    const b = req.body as Partial<SaveProjectTemplatesRequestDTO>;
    if (!Array.isArray(b.enabledTemplateIds)) throw new HttpError(400, 'enabledTemplateIds must be an array');
    await saveProjectTemplates(req.user!.userId, req.params.id, { enabledTemplateIds: b.enabledTemplateIds, defaultTemplateId: b.defaultTemplateId ?? null });
    res.status(204).end();
  }),
);

// --- Guardrails: project rules and per-role rules (project admins write; members read), plus the org baseline read-only ---

router.get(
  '/:id/guardrails',
  handle(async (req, res) => {
    await requireProjectAccess(req.user!.userId, req.params.id);
    res.json(await listProjectGuardrails(req.params.id));
  }),
);

router.post(
  '/:id/guardrails',
  handle(async (req, res) => {
    const b = req.body as { scope?: string; role?: string; rule?: GuardrailRuleInput };
    if (!b.rule) throw new HttpError(400, 'rule is required');
    const actor = req.user!.userId;
    if (b.scope === 'ROLE') {
      if (!b.role || !ROLES.includes(b.role as (typeof ROLES)[number])) throw new HttpError(400, 'role is required for a role rule');
      res.status(201).json(await createRule(actor, { scope: 'ROLE', projectId: req.params.id, role: b.role as Role }, b.rule));
    } else {
      res.status(201).json(await createRule(actor, { scope: 'PROJECT', projectId: req.params.id }, b.rule));
    }
  }),
);

router.put(
  '/:id/guardrails/:ruleId',
  handle(async (req, res) => {
    res.json(await updateRule(req.user!.userId, req.params.id, req.params.ruleId, req.body as GuardrailRuleInput));
  }),
);

router.delete(
  '/:id/guardrails/:ruleId',
  handle(async (req, res) => {
    await deleteRule(req.user!.userId, req.params.id, req.params.ruleId);
    res.status(204).end();
  }),
);

// Every chat of the project (admins and members can view them; only owners can run them).
router.get(
  '/:id/chats',
  handle(async (req, res) => {
    await requireProjectAccess(req.user!.userId, req.params.id);
    res.json(await buildBoard(req.params.id));
  }),
);

export default router;
