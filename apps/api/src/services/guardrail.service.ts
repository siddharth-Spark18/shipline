import { GuardrailKind, GuardrailRule as DbRule, GuardrailScope, Prisma, Role, RuleAction, RuleEffect, StageDefinition } from '@prisma/client';
import {
  EffectiveRules,
  GuardrailRule,
  GuardrailRuleInput,
  PathAction,
  ROLES,
  RuleKind,
  normalizeRuleInput,
  validateRuleInput,
} from '@shipline/shared';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { audit } from '../lib/audit';
import { requireGlobalAdmin, requireProjectAdmin } from './access.service';

// --- DB <-> shared mapping ---

const EFFECT_FROM_DB = { ALLOW: 'allow', ASK: 'ask', DENY: 'deny' } as const;
const EFFECT_TO_DB = { allow: 'ALLOW', ask: 'ASK', deny: 'DENY' } as const;
const KIND_FROM_DB: Record<GuardrailKind, RuleKind> = { PATH: 'path', BASH: 'bash', TOOL: 'tool' };
const KIND_TO_DB: Record<RuleKind, GuardrailKind> = { path: 'PATH', bash: 'BASH', tool: 'TOOL' };
const ACTION_FROM_DB: Record<RuleAction, PathAction> = { READ: 'read', EDIT: 'edit' };
const ACTION_TO_DB: Record<PathAction, RuleAction> = { read: 'READ', edit: 'EDIT' };
const LEVEL_FROM_DB = { ORG: 'org', PROJECT: 'project', ROLE: 'role' } as const;

export function toRule(row: DbRule): GuardrailRule {
  return {
    id: row.id,
    level: LEVEL_FROM_DB[row.scope],
    role: row.role ?? undefined,
    kind: KIND_FROM_DB[row.kind],
    pattern: row.pattern,
    actions: row.actions.map((a) => ACTION_FROM_DB[a]),
    effect: EFFECT_FROM_DB[row.effect],
    reason: row.reason,
  };
}

/** Stage-level rules live on the stage definition (inside a template version) as GuardrailRuleInput[]. */
export function stageRulesOf(def: Pick<StageDefinition, 'id' | 'stageRules'>): GuardrailRule[] {
  const raw = Array.isArray(def.stageRules) ? (def.stageRules as unknown as GuardrailRuleInput[]) : [];
  return raw.map((r, i) => ({
    id: `${def.id}:${i}`,
    level: 'stage' as const,
    kind: r.kind,
    pattern: r.pattern,
    actions: r.actions ?? [],
    effect: r.effect,
    reason: r.reason,
  }));
}

// --- Rule cache ---

export interface RuleSet {
  org: GuardrailRule[];
  project: GuardrailRule[];
  roles: Partial<Record<Role, GuardrailRule[]>>;
}

/**
 * Rule evaluation is in the path of every tool call, so the org, project and role rules of a project
 * are cached and dropped when any of them changes (`invalidateRules`). A short TTL bounds staleness
 * if another API instance changed them.
 * OPEN-QUESTION #11 (hosting): like the ask waiters, the invalidation is per process; a
 * multi-instance deployment needs a shared channel. The TTL is the fallback until then.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; set: RuleSet }>();

/** Drops one project's cached rules, or every project's (an org rule changed). */
export function invalidateRules(projectId?: string | null): void {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}

export async function loadRuleSet(projectId: string): Promise<RuleSet> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.set;
  const rows = await prisma.guardrailRule.findMany({
    where: { OR: [{ scope: 'ORG' }, { projectId }] },
    orderBy: { createdAt: 'asc' },
  });
  const set: RuleSet = { org: [], project: [], roles: {} };
  for (const row of rows) {
    const rule = toRule(row);
    if (row.scope === 'ORG') set.org.push(rule);
    else if (row.scope === 'PROJECT') set.project.push(rule);
    else if (row.role) (set.roles[row.role] ??= []).push(rule);
  }
  cache.set(projectId, { at: Date.now(), set });
  return set;
}

/** Everything that applies to a chat in this project while `stageDef` is the current stage. */
export async function effectiveRulesFor(projectId: string, stageDef: Pick<StageDefinition, 'id' | 'stageRules'> | null): Promise<EffectiveRules> {
  const set = await loadRuleSet(projectId);
  return { ...set, stage: stageDef ? stageRulesOf(stageDef) : [] };
}

// --- Admin CRUD (every change is audit-logged and drops the cache) ---

export interface ProjectGuardrails {
  /** Org baseline, shown read-only in project settings. */
  inherited: GuardrailRule[];
  project: GuardrailRule[];
  roles: Record<Role, GuardrailRule[]>;
}

export async function listOrgRules(): Promise<GuardrailRule[]> {
  const rows = await prisma.guardrailRule.findMany({ where: { scope: 'ORG' }, orderBy: { createdAt: 'asc' } });
  return rows.map(toRule);
}

export async function listProjectGuardrails(projectId: string): Promise<ProjectGuardrails> {
  const set = await loadRuleSet(projectId);
  const roles = Object.fromEntries(ROLES.map((r) => [r, set.roles[r] ?? []])) as Record<Role, GuardrailRule[]>;
  return { inherited: set.org, project: set.project, roles };
}

function checkInput(input: GuardrailRuleInput): GuardrailRuleInput {
  const problem = validateRuleInput(input);
  if (problem) throw new HttpError(400, problem, 'RULE_INVALID');
  return normalizeRuleInput(input);
}

function ruleData(input: GuardrailRuleInput) {
  return {
    kind: KIND_TO_DB[input.kind],
    pattern: input.pattern,
    actions: input.actions.map((a) => ACTION_TO_DB[a]),
    effect: EFFECT_TO_DB[input.effect] as RuleEffect,
    reason: input.reason,
  };
}

const auditData = (row: DbRule): Prisma.InputJsonValue => ({
  ruleId: row.id,
  scope: row.scope,
  role: row.role,
  kind: row.kind,
  pattern: row.pattern,
  actions: row.actions,
  effect: row.effect,
  reason: row.reason,
});

export async function createRule(
  actorId: string,
  target: { scope: 'ORG' } | { scope: 'PROJECT'; projectId: string } | { scope: 'ROLE'; projectId: string; role: Role },
  raw: GuardrailRuleInput,
): Promise<GuardrailRule> {
  if (target.scope === 'ORG') await requireGlobalAdmin(actorId);
  else await requireProjectAdmin(actorId, target.projectId);
  if (target.scope === 'ROLE' && !ROLES.includes(target.role)) throw new HttpError(400, 'Unknown role');
  const input = checkInput(raw);
  const row = await prisma.guardrailRule.create({
    data: {
      scope: target.scope as GuardrailScope,
      projectId: target.scope === 'ORG' ? null : target.projectId,
      role: target.scope === 'ROLE' ? target.role : null,
      createdById: actorId,
      ...ruleData(input),
    },
  });
  await audit({ type: 'guardrail.created', actorId, projectId: row.projectId, data: auditData(row) });
  invalidateRules(row.projectId);
  return toRule(row);
}

async function requireRuleAdmin(actorId: string, row: DbRule): Promise<void> {
  if (row.scope === 'ORG' || !row.projectId) await requireGlobalAdmin(actorId);
  else await requireProjectAdmin(actorId, row.projectId);
}

/** The rule, but only through the project it belongs to (so a project admin cannot reach another project's rule). */
async function findRule(id: string, projectId: string | null): Promise<DbRule> {
  const row = await prisma.guardrailRule.findUnique({ where: { id } });
  if (!row || row.projectId !== projectId) throw new HttpError(404, 'Rule not found');
  return row;
}

export async function updateRule(actorId: string, projectId: string | null, id: string, raw: GuardrailRuleInput): Promise<GuardrailRule> {
  const existing = await findRule(id, projectId);
  await requireRuleAdmin(actorId, existing);
  const input = checkInput(raw);
  const row = await prisma.guardrailRule.update({ where: { id }, data: ruleData(input) });
  await audit({ type: 'guardrail.updated', actorId, projectId: row.projectId, data: { ...(auditData(row) as object), before: auditData(existing) } });
  invalidateRules(row.projectId);
  return toRule(row);
}

export async function deleteRule(actorId: string, projectId: string | null, id: string): Promise<void> {
  const existing = await findRule(id, projectId);
  await requireRuleAdmin(actorId, existing);
  await prisma.guardrailRule.delete({ where: { id } });
  await audit({ type: 'guardrail.deleted', actorId, projectId: existing.projectId, data: auditData(existing) });
  invalidateRules(existing.projectId);
}
