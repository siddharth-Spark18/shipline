import { CustomAgent } from '@prisma/client';
import { CustomAgentDTO, CustomAgentInput, PLUGIN_AGENTS, customAgentRef, parseAgentRef, validateAgentInput } from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { requireGlobalAdmin } from './access.service';

export const toAgentDTO = (a: CustomAgent): CustomAgentDTO => ({
  id: a.id,
  name: a.name,
  description: a.description,
  prompt: a.prompt,
  tools: a.tools,
  model: a.model,
});

export async function listCustomAgents(): Promise<CustomAgentDTO[]> {
  const rows = await prisma.customAgent.findMany({ orderBy: { name: 'asc' } });
  return rows.map(toAgentDTO);
}

function clean(input: CustomAgentInput): CustomAgentInput {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    tools: input.tools.map((t) => t.trim()).filter(Boolean),
    model: input.model?.trim() || null,
  };
}

export async function createCustomAgent(actorId: string, raw: CustomAgentInput): Promise<CustomAgentDTO> {
  await requireGlobalAdmin(actorId);
  const input = clean(raw);
  const problem = validateAgentInput(input, true);
  if (problem) throw new HttpError(400, problem, 'AGENT_INVALID');
  if (await prisma.customAgent.findUnique({ where: { name: input.name } })) {
    throw new HttpError(409, `A custom agent named "${input.name}" already exists.`, 'AGENT_EXISTS');
  }
  const row = await prisma.customAgent.create({ data: { ...input, createdById: actorId } });
  await audit({ type: 'agent.created', actorId, data: { agentId: row.id, name: row.name } });
  return toAgentDTO(row);
}

/** The name is fixed once created: stages and Claude address the agent by it. */
export async function updateCustomAgent(actorId: string, id: string, raw: Omit<CustomAgentInput, 'name'>): Promise<CustomAgentDTO> {
  await requireGlobalAdmin(actorId);
  const existing = await prisma.customAgent.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Agent not found');
  const input = clean({ ...raw, name: existing.name });
  const problem = validateAgentInput(input, false);
  if (problem) throw new HttpError(400, problem, 'AGENT_INVALID');
  const row = await prisma.customAgent.update({
    where: { id },
    data: { description: input.description, prompt: input.prompt, tools: input.tools, model: input.model },
  });
  await audit({ type: 'agent.updated', actorId, data: { agentId: id, name: row.name } });
  return toAgentDTO(row);
}

/**
 * Blocked while a version of a template that is not archived names the agent ("archive the template
 * first, or change the stage"). Versions of archived templates may still name it: chats pinned to
 * them keep running, just without the agent.
 */
export async function deleteCustomAgent(actorId: string, id: string): Promise<void> {
  await requireGlobalAdmin(actorId);
  const existing = await prisma.customAgent.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Agent not found');
  const users = await prisma.stageDefinition.findMany({
    where: { agentRef: customAgentRef(id), version: { template: { archivedAt: null } } },
    select: { name: true, version: { select: { version: true, template: { select: { name: true } } } } },
  });
  if (users.length > 0) {
    const where = [...new Set(users.map((u) => `${u.version.template.name} v${u.version.version} (${u.name})`))].join(', ');
    throw new HttpError(409, `"${existing.name}" is used by: ${where}. Archive the template first or change the stage.`, 'AGENT_IN_USE');
  }
  await prisma.customAgent.delete({ where: { id } });
  await audit({ type: 'agent.deleted', actorId, data: { agentId: id, name: existing.name } });
}

/** The name an agent ref resolves to now, or null when the agent is gone. */
export async function resolveAgentName(ref: string | null): Promise<string | null> {
  const parsed = parseAgentRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'plugin') return PLUGIN_AGENTS.some((a) => a.name === parsed.name) ? parsed.name : null;
  return (await prisma.customAgent.findUnique({ where: { id: parsed.id } }))?.name ?? null;
}

/** The custom agents the stages of a template version name (what `claude --agents` gets). */
export async function customAgentsForVersion(versionId: string): Promise<CustomAgentDTO[]> {
  const defs = await prisma.stageDefinition.findMany({ where: { versionId, agentRef: { startsWith: 'custom:' } }, select: { agentRef: true } });
  const ids = [...new Set(defs.map((d) => parseAgentRef(d.agentRef)).flatMap((p) => (p?.kind === 'custom' ? [p.id] : [])))];
  if (ids.length === 0) return [];
  const rows = await prisma.customAgent.findMany({ where: { id: { in: ids } } });
  return rows.map(toAgentDTO);
}
