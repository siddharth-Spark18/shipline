import crypto from 'crypto';
import { Prisma, StageDefinition, WorkflowTemplate, WorkflowTemplateVersion } from '@prisma/client';
import {
  CustomAgentInput,
  DEFAULT_TEMPLATES,
  ExportedStageDTO,
  GuardrailRuleInput,
  ProjectTemplateDTO,
  SaveProjectTemplatesRequestDTO,
  StageDraftDTO,
  StageTemplateDef,
  StageToolPolicy,
  STAGE_READ_ONLY_TOOLS,
  STAGE_TYPES,
  TEMPLATE_EXPORT_FORMAT,
  TemplateDetailDTO,
  TemplateDraftDTO,
  TemplateExportDTO,
  TemplateSummaryDTO,
  TemplateVersionDTO,
  customAgentRef,
  isStageType,
  normalizeRuleInput,
  parseAgentRef,
  pluginAgentRef,
  PLUGIN_AGENTS,
  stageKeyFor,
  validateAgentInput,
  validateTemplate,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { requireGlobalAdmin, requireProjectAccess, requireProjectAdmin } from './access.service';

type Tx = Prisma.TransactionClient;
type VersionFull = WorkflowTemplateVersion & { stages: StageDefinition[]; createdBy: { id: string; name: string } | null };

// --- Mapping ---

export function toStageDef(row: StageDefinition): StageTemplateDef {
  return {
    key: row.key,
    name: row.name,
    type: isStageType(row.type) ? row.type : 'custom',
    allowedRoles: row.allowedRoles,
    optional: row.optional,
    artifactTypes: row.artifactTypes,
    requiredForGate: row.requiredForGate,
    toolPolicy: row.toolPolicy as unknown as StageToolPolicy,
    instructions: row.instructions,
    agentRef: row.agentRef,
    rules: Array.isArray(row.stageRules) ? (row.stageRules as unknown as GuardrailRuleInput[]) : [],
  };
}

function toVersionDTO(v: VersionFull): TemplateVersionDTO {
  return {
    id: v.id,
    version: v.version,
    name: v.name,
    description: v.description,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    stages: [...v.stages].sort((a, b) => a.order - b.order).map(toStageDef),
  };
}

const versionInclude = {
  stages: { orderBy: { order: 'asc' } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkflowTemplateVersionInclude;

async function summarize(t: WorkflowTemplate): Promise<TemplateSummaryDTO> {
  const [latest, chatCount, activeChatCount, projectCount] = await Promise.all([
    prisma.workflowTemplateVersion.findFirst({
      where: { templateId: t.id },
      orderBy: { version: 'desc' },
      include: { _count: { select: { stages: true } } },
    }),
    prisma.ticket.count({ where: { templateVersion: { templateId: t.id } } }),
    prisma.ticket.count({ where: { templateVersion: { templateId: t.id }, status: 'ACTIVE' } }),
    prisma.projectTemplate.count({ where: { templateId: t.id } }),
  ]);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    builtIn: t.builtIn,
    archived: !!t.archivedAt,
    latestVersion: latest?.version ?? 0,
    stageCount: latest?._count.stages ?? 0,
    chatCount,
    activeChatCount,
    projectCount,
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function requireTemplate(id: string): Promise<WorkflowTemplate> {
  const t = await prisma.workflowTemplate.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'Template not found');
  return t;
}

export async function latestVersionOf(templateId: string): Promise<VersionFull> {
  const v = await prisma.workflowTemplateVersion.findFirst({
    where: { templateId },
    orderBy: { version: 'desc' },
    include: versionInclude,
  });
  if (!v) throw new HttpError(404, 'Template has no versions');
  return v;
}

// --- Reads ---

export async function listTemplates(): Promise<TemplateSummaryDTO[]> {
  const rows = await prisma.workflowTemplate.findMany({ orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }] });
  return Promise.all(rows.map(summarize));
}

export async function getTemplate(id: string): Promise<TemplateDetailDTO> {
  const t = await requireTemplate(id);
  const [summary, latest, versions] = await Promise.all([
    summarize(t),
    latestVersionOf(id),
    prisma.workflowTemplateVersion.findMany({
      where: { templateId: id },
      orderBy: { version: 'desc' },
      include: { createdBy: { select: { id: true, name: true } }, _count: { select: { stages: true } } },
    }),
  ]);
  return {
    ...summary,
    latest: toVersionDTO(latest),
    versions: versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      stageCount: v._count.stages,
    })),
  };
}

export async function getVersion(templateId: string, version: number): Promise<TemplateVersionDTO> {
  const v = await prisma.workflowTemplateVersion.findUnique({
    where: { templateId_version: { templateId, version } },
    include: versionInclude,
  });
  if (!v) throw new HttpError(404, 'Version not found');
  return toVersionDTO(v);
}

// --- Writes ---

function toolPolicyOf(p: StageToolPolicy): StageToolPolicy {
  return {
    allowCodeEdit: !!p.allowCodeEdit,
    allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools : STAGE_READ_ONLY_TOOLS,
    disallowedTools: Array.isArray(p.disallowedTools) ? p.disallowedTools : [],
    permissionMode: 'default',
    bash: p.bash,
  };
}

/** Custom agents by id, for validating stage agent refs and snapshotting their names. */
async function agentNamesById(extra?: Map<string, string>): Promise<Map<string, string>> {
  const rows = await prisma.customAgent.findMany({ select: { id: true, name: true } });
  const map = new Map(rows.map((r) => [r.id, r.name]));
  for (const [id, name] of extra ?? []) map.set(id, name);
  return map;
}

function agentNameOf(ref: string | null, names: Map<string, string>): string | null {
  const parsed = parseAgentRef(ref);
  if (!parsed) return null;
  return parsed.kind === 'plugin' ? parsed.name : (names.get(parsed.id) ?? null);
}

function assertValid(draft: TemplateDraftDTO, names: Map<string, string>): void {
  const issues = validateTemplate(draft, { knownCustomAgentIds: new Set(names.keys()) });
  if (issues.length > 0) {
    throw new HttpError(400, issues.map((i) => i.message).join(' '), 'TEMPLATE_INVALID');
  }
}

async function writeVersion(
  tx: Tx,
  templateId: string,
  version: number,
  draft: TemplateDraftDTO,
  actorId: string | null,
  names: Map<string, string>,
): Promise<WorkflowTemplateVersion> {
  const v = await tx.workflowTemplateVersion.create({
    data: { templateId, version, name: draft.name.trim(), description: draft.description.trim(), createdById: actorId },
  });
  const taken = new Set<string>();
  for (const [i, s] of draft.stages.entries()) {
    const key = stageKeyFor(s, taken);
    taken.add(key);
    await tx.stageDefinition.create({
      data: {
        versionId: v.id,
        order: i + 1,
        key,
        name: s.name.trim(),
        type: s.type,
        allowedRoles: s.allowedRoles,
        optional: s.optional,
        artifactTypes: s.artifactTypes,
        requiredForGate: s.requiredForGate,
        toolPolicy: toolPolicyOf(s.toolPolicy) as unknown as Prisma.InputJsonValue,
        instructions: s.instructions.trim(),
        agentRef: s.agentRef,
        agentName: agentNameOf(s.agentRef, names),
        stageRules: s.rules.map(normalizeRuleInput) as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return v;
}

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const clash = await prisma.workflowTemplate.findUnique({ where: { name: name.trim() } });
  if (clash && clash.id !== exceptId) throw new HttpError(409, `A template named "${name.trim()}" already exists.`, 'TEMPLATE_NAME_TAKEN');
}

export async function createTemplate(actorId: string, draft: TemplateDraftDTO): Promise<TemplateDetailDTO> {
  await requireGlobalAdmin(actorId);
  const names = await agentNamesById();
  assertValid(draft, names);
  await assertNameFree(draft.name);
  const created = await prisma.$transaction(async (tx) => {
    const t = await tx.workflowTemplate.create({ data: { name: draft.name.trim(), description: draft.description.trim() } });
    const v = await writeVersion(tx, t.id, 1, draft, actorId, names);
    await audit({ type: 'template.created', actorId, data: { templateId: t.id, name: t.name } }, tx);
    await audit({ type: 'template.version_created', actorId, data: { templateId: t.id, name: t.name, version: v.version, stages: draft.stages.length } }, tx);
    return t;
  });
  return getTemplate(created.id);
}

/**
 * Saving creates a new immutable version. The editor sends the version it was opened on; if someone
 * saved a newer one meanwhile the save is rejected ("reload to see the newer version").
 */
export async function saveTemplateVersion(
  actorId: string,
  templateId: string,
  input: { baseVersion: number; draft: TemplateDraftDTO },
): Promise<TemplateDetailDTO> {
  await requireGlobalAdmin(actorId);
  const template = await requireTemplate(templateId);
  if (template.archivedAt) throw new HttpError(409, 'This template is archived. Restore it before editing.', 'TEMPLATE_ARCHIVED');
  const names = await agentNamesById();
  assertValid(input.draft, names);
  await assertNameFree(input.draft.name, templateId);
  const stale = new HttpError(409, 'Someone saved a newer version of this template. Reload to see it, then apply your changes again.', 'STALE_TEMPLATE');
  try {
    await prisma.$transaction(async (tx) => {
      const latest = await tx.workflowTemplateVersion.findFirst({ where: { templateId }, orderBy: { version: 'desc' } });
      if (!latest || latest.version !== input.baseVersion) throw stale;
      const next = latest.version + 1;
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: { name: input.draft.name.trim(), description: input.draft.description.trim() },
      });
      await writeVersion(tx, templateId, next, input.draft, actorId, names);
      await audit(
        { type: 'template.version_created', actorId, data: { templateId, name: input.draft.name.trim(), version: next, previousVersion: latest.version, stages: input.draft.stages.length } },
        tx,
      );
    });
  } catch (err) {
    // Two saves racing for the same number hit the unique (templateId, version) index.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw stale;
    throw err;
  }
  return getTemplate(templateId);
}

export async function setTemplateArchived(actorId: string, id: string, archived: boolean): Promise<TemplateSummaryDTO> {
  await requireGlobalAdmin(actorId);
  const t = await requireTemplate(id);
  const updated = await prisma.workflowTemplate.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
  await audit({ type: archived ? 'template.archived' : 'template.restored', actorId, data: { templateId: id, name: t.name } });
  return summarize(updated);
}

/** Only a template that no chat uses on any version can be deleted; otherwise archive it. */
export async function deleteTemplate(actorId: string, id: string): Promise<void> {
  await requireGlobalAdmin(actorId);
  const t = await requireTemplate(id);
  const chats = await prisma.ticket.count({ where: { templateVersion: { templateId: id } } });
  if (chats > 0) {
    throw new HttpError(409, `${chats} chat${chats === 1 ? ' uses' : 's use'} this template, so it can only be archived.`, 'TEMPLATE_IN_USE');
  }
  await prisma.$transaction(async (tx) => {
    await tx.templateSwitch.deleteMany({ where: { toVersion: { templateId: id } } });
    await tx.workflowTemplate.delete({ where: { id } });
    await audit({ type: 'template.deleted', actorId, data: { templateId: id, name: t.name } }, tx);
  });
}

// --- Export / import ---

export async function exportTemplate(id: string): Promise<TemplateExportDTO> {
  const t = await requireTemplate(id);
  const latest = toVersionDTO(await latestVersionOf(id));
  const customIds = latest.stages.flatMap((s) => {
    const p = parseAgentRef(s.agentRef);
    return p?.kind === 'custom' ? [p.id] : [];
  });
  const agents = await prisma.customAgent.findMany({ where: { id: { in: customIds } } });
  const byId = new Map(agents.map((a) => [a.id, a]));
  const stages: ExportedStageDTO[] = latest.stages.map(({ agentRef, ...rest }) => {
    const p = parseAgentRef(agentRef);
    let agent: ExportedStageDTO['agent'] = null;
    if (p?.kind === 'plugin') agent = { kind: 'plugin', name: p.name };
    else if (p?.kind === 'custom') {
      const a = byId.get(p.id);
      if (a) agent = { kind: 'custom', name: a.name };
    }
    return { ...rest, agent };
  });
  return {
    format: TEMPLATE_EXPORT_FORMAT,
    formatVersion: 1,
    name: t.name,
    description: t.description,
    stages,
    customAgents: agents.map((a) => ({ name: a.name, description: a.description, prompt: a.prompt, tools: a.tools, model: a.model })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (message: string): HttpError => new HttpError(400, `Import failed: ${message}`, 'IMPORT_INVALID');

/** Parses an exported file into a draft. Unknown stage types or agents are rejected with a message. */
function parseExport(data: unknown): { name: string; description: string; stages: ExportedStageDTO[]; customAgents: CustomAgentInput[] } {
  if (!isObj(data) || data.format !== TEMPLATE_EXPORT_FORMAT) throw bad('this is not a Shipline workflow template file.');
  const d = data as Record<string, unknown>;
  if (d.formatVersion !== 1) throw bad('unsupported file version.');
  if (typeof d.name !== 'string' || !d.name.trim()) throw bad('the template has no name.');
  if (!Array.isArray(d.stages)) throw bad('the template has no stages list.');
  const stages: ExportedStageDTO[] = d.stages.map((raw, i) => {
    if (!isObj(raw)) throw bad(`stage ${i + 1} is not an object.`);
    const label = typeof raw.name === 'string' && raw.name ? `"${raw.name}"` : `stage ${i + 1}`;
    if (typeof raw.type !== 'string' || !isStageType(raw.type)) {
      throw bad(`${label} has an unknown stage type "${String(raw.type)}" (known: ${STAGE_TYPES.join(', ')}).`);
    }
    if (typeof raw.name !== 'string' || typeof raw.instructions !== 'string') throw bad(`${label} is missing its name or instructions.`);
    if (!Array.isArray(raw.artifactTypes) || !isObj(raw.toolPolicy)) throw bad(`${label} is missing artifact types or its tool policy.`);
    const agent = raw.agent;
    if (agent !== null && agent !== undefined) {
      if (!isObj(agent) || (agent.kind !== 'plugin' && agent.kind !== 'custom') || typeof agent.name !== 'string') throw bad(`${label} has an invalid agent.`);
      if (agent.kind === 'plugin' && !PLUGIN_AGENTS.some((a) => a.name === agent.name)) throw bad(`${label} names the plugin agent "${agent.name}", which this Shipline does not bundle.`);
    }
    return {
      key: typeof raw.key === 'string' ? raw.key : '',
      name: raw.name,
      type: raw.type,
      allowedRoles: Array.isArray(raw.allowedRoles) ? (raw.allowedRoles as ExportedStageDTO['allowedRoles']) : [],
      optional: !!raw.optional,
      artifactTypes: raw.artifactTypes as ExportedStageDTO['artifactTypes'],
      requiredForGate: !!raw.requiredForGate,
      toolPolicy: raw.toolPolicy as unknown as StageToolPolicy,
      instructions: raw.instructions,
      rules: Array.isArray(raw.rules) ? (raw.rules as GuardrailRuleInput[]) : [],
      agent: (agent as ExportedStageDTO['agent']) ?? null,
    };
  });
  const customAgents = Array.isArray(d.customAgents)
    ? d.customAgents.filter(isObj).map((a) => ({
        name: String(a.name ?? ''),
        description: String(a.description ?? ''),
        prompt: String(a.prompt ?? ''),
        tools: Array.isArray(a.tools) ? a.tools.map(String) : [],
        model: typeof a.model === 'string' && a.model ? a.model : null,
      }))
    : [];
  return { name: d.name as string, description: typeof d.description === 'string' ? d.description : '', stages, customAgents };
}

/**
 * Imports a template file: a new template, or a new version of the same-named one. A custom agent a
 * stage names must already exist, or be defined in the file and `createMissingAgents` set (the
 * 409 AGENTS_MISSING answer is how the UI offers that).
 */
export async function importTemplate(
  actorId: string,
  data: unknown,
  createMissingAgents: boolean,
): Promise<{ template: TemplateSummaryDTO; outcome: 'created' | 'new-version'; createdAgents: string[] }> {
  await requireGlobalAdmin(actorId);
  const file = parseExport(data);

  const existingAgents = await prisma.customAgent.findMany({ select: { id: true, name: true } });
  const byName = new Map(existingAgents.map((a) => [a.name, a.id]));
  const toCreate: Array<CustomAgentInput & { id: string }> = [];
  const missing: string[] = [];
  const draftStages: StageDraftDTO[] = file.stages.map((s) => {
    const { agent, ...rest } = s;
    let agentRef: string | null = null;
    if (agent?.kind === 'plugin') agentRef = pluginAgentRef(agent.name);
    else if (agent?.kind === 'custom') {
      let id = byName.get(agent.name) ?? toCreate.find((c) => c.name === agent.name)?.id;
      if (!id) {
        const def = file.customAgents.find((c) => c.name === agent.name);
        if (!def) throw bad(`stage "${s.name}" uses the custom agent "${agent.name}", which does not exist here and is not defined in the file.`);
        const problem = validateAgentInput(def, true);
        if (problem) throw bad(`the file's custom agent "${agent.name}" is not valid: ${problem}`);
        id = crypto.randomUUID();
        toCreate.push({ ...def, id });
        missing.push(agent.name);
      }
      agentRef = customAgentRef(id);
    }
    return { ...rest, key: rest.key || undefined, agentRef };
  });
  if (missing.length > 0 && !createMissingAgents) {
    throw new HttpError(
      409,
      `The custom agent${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist yet. Create ${missing.length === 1 ? 'it' : 'them'} from the definition in the file?`,
      'AGENTS_MISSING',
    );
  }

  const draft: TemplateDraftDTO = { name: file.name, description: file.description, stages: draftStages };
  const names = await agentNamesById(new Map(toCreate.map((c) => [c.id, c.name])));
  assertValid(draft, names);

  const existing = await prisma.workflowTemplate.findUnique({ where: { name: draft.name.trim() } });
  if (existing?.archivedAt) throw new HttpError(409, `The template "${existing.name}" is archived. Restore it before importing a new version.`, 'TEMPLATE_ARCHIVED');

  const result = await prisma.$transaction(async (tx) => {
    for (const a of toCreate) {
      await tx.customAgent.create({ data: { id: a.id, name: a.name, description: a.description, prompt: a.prompt, tools: a.tools, model: a.model, createdById: actorId } });
      await audit({ type: 'agent.created', actorId, data: { agentId: a.id, name: a.name, via: 'import' } }, tx);
    }
    let templateId: string;
    let version: number;
    let outcome: 'created' | 'new-version';
    if (existing) {
      const latest = await tx.workflowTemplateVersion.findFirstOrThrow({ where: { templateId: existing.id }, orderBy: { version: 'desc' } });
      version = latest.version + 1;
      templateId = existing.id;
      outcome = 'new-version';
      await tx.workflowTemplate.update({ where: { id: existing.id }, data: { description: draft.description.trim() } });
    } else {
      const t = await tx.workflowTemplate.create({ data: { name: draft.name.trim(), description: draft.description.trim() } });
      templateId = t.id;
      version = 1;
      outcome = 'created';
    }
    await writeVersion(tx, templateId, version, draft, actorId, names);
    await audit({ type: 'template.imported', actorId, data: { templateId, name: draft.name.trim(), version, outcome } }, tx);
    await audit({ type: 'template.version_created', actorId, data: { templateId, name: draft.name.trim(), version, stages: draft.stages.length, via: 'import' } }, tx);
    return { templateId, outcome };
  });
  const template = await summarize(await requireTemplate(result.templateId));
  return { template, outcome: result.outcome, createdAgents: toCreate.map((c) => c.name) };
}

// --- Built-ins ---

/** Creates the built-in Feature and Hotfix templates (version 1) when no template of that name exists. Idempotent. */
export async function seedBuiltInTemplates(): Promise<string[]> {
  const created: string[] = [];
  for (const tpl of DEFAULT_TEMPLATES) {
    if (await prisma.workflowTemplate.findUnique({ where: { name: tpl.name } })) continue;
    await prisma.$transaction(async (tx) => {
      const t = await tx.workflowTemplate.create({ data: { name: tpl.name, description: tpl.description, builtIn: true } });
      await writeVersion(tx, t.id, 1, { name: tpl.name, description: tpl.description, stages: tpl.stages }, null, new Map());
    });
    created.push(tpl.name);
  }
  return created;
}

/**
 * Enables every non-archived built-in template on the project when it has none enabled (a new
 * project, or the seed), with Feature as the default.
 */
export async function enableBuiltInsForProject(projectId: string): Promise<void> {
  if ((await prisma.projectTemplate.count({ where: { projectId } })) > 0) return;
  const builtIns = await prisma.workflowTemplate.findMany({ where: { builtIn: true, archivedAt: null }, orderBy: { name: 'asc' } });
  if (builtIns.length === 0) return;
  const preferred = builtIns.find((t) => t.name === DEFAULT_TEMPLATES[0].name) ?? builtIns[0];
  await prisma.projectTemplate.createMany({
    data: builtIns.map((t) => ({ projectId, templateId: t.id, isDefault: t.id === preferred.id })),
  });
}

// --- Per project ---

export async function listProjectTemplates(userId: string, projectId: string): Promise<ProjectTemplateDTO[]> {
  await requireProjectAccess(userId, projectId);
  const [templates, enabled] = await Promise.all([
    prisma.workflowTemplate.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.projectTemplate.findMany({ where: { projectId } }),
  ]);
  return Promise.all(
    templates.map(async (t) => {
      const latest = toVersionDTO(await latestVersionOf(t.id));
      const row = enabled.find((e) => e.templateId === t.id);
      return {
        templateId: t.id,
        name: t.name,
        description: t.description,
        latestVersion: latest.version,
        stages: latest.stages.map((s) => ({ name: s.name, optional: s.optional, type: s.type })),
        enabled: !!row,
        isDefault: !!row?.isDefault,
      };
    }),
  );
}

export async function saveProjectTemplates(userId: string, projectId: string, input: SaveProjectTemplatesRequestDTO): Promise<void> {
  await requireProjectAdmin(userId, projectId);
  const ids = [...new Set(input.enabledTemplateIds)];
  if (ids.length === 0) throw new HttpError(400, 'Enable at least one template.');
  if (!input.defaultTemplateId || !ids.includes(input.defaultTemplateId)) {
    throw new HttpError(400, 'Pick one of the enabled templates as the default.');
  }
  const found = await prisma.workflowTemplate.findMany({ where: { id: { in: ids }, archivedAt: null } });
  if (found.length !== ids.length) throw new HttpError(400, 'An archived or unknown template cannot be enabled.');
  await prisma.$transaction(async (tx) => {
    // Chats already running on a disabled template keep going: only new chats lose the option.
    await tx.projectTemplate.deleteMany({ where: { projectId, templateId: { notIn: ids } } });
    for (const id of ids) {
      await tx.projectTemplate.upsert({
        where: { projectId_templateId: { projectId, templateId: id } },
        create: { projectId, templateId: id, isDefault: id === input.defaultTemplateId },
        update: { isDefault: id === input.defaultTemplateId },
      });
    }
    await audit({ type: 'project.templates_updated', actorId: userId, projectId, data: { enabled: found.map((t) => t.name), default: found.find((t) => t.id === input.defaultTemplateId)?.name ?? null } }, tx);
  });
}

export interface ResolvedTemplate {
  template: WorkflowTemplate;
  version: VersionFull;
}

/** The template a new chat in this project starts on: the one picked (it must be enabled), else the project's default; always its latest version. */
export async function resolveChatTemplate(projectId: string, templateId?: string): Promise<ResolvedTemplate> {
  const rows = await prisma.projectTemplate.findMany({
    where: { projectId, template: { archivedAt: null } },
    include: { template: true },
  });
  if (rows.length === 0) {
    throw new HttpError(409, 'This project has no workflow template enabled. A project admin can enable one under Project settings.', 'NO_TEMPLATES');
  }
  const pick = templateId ? rows.find((r) => r.templateId === templateId) : (rows.find((r) => r.isDefault) ?? rows[0]);
  if (!pick) throw new HttpError(400, 'That template is not enabled for this project.', 'TEMPLATE_NOT_ENABLED');
  return { template: pick.template, version: await latestVersionOf(pick.templateId) };
}

/** Templates the chat could still switch to: enabled for the project, not archived, not the current one. Empty once the branch exists. */
export async function switchableTemplates(
  projectId: string,
  currentTemplateId: string,
  branch: string | null,
): Promise<Array<{ id: string; name: string; description: string }>> {
  if (branch) return [];
  const rows = await prisma.projectTemplate.findMany({
    where: { projectId, template: { archivedAt: null }, templateId: { not: currentTemplateId } },
    include: { template: true },
    orderBy: { template: { name: 'asc' } },
  });
  return rows.map((r) => ({ id: r.templateId, name: r.template.name, description: r.template.description }));
}
