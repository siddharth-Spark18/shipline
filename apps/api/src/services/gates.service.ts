import { prisma } from '../lib/prisma';

export interface GateEvaluation {
  pass: boolean;
  overridden: boolean;
  lines: string[];
}

/**
 * `shipline/gates` rule: passes only if every stage of the pinned template version that is marked
 * required for the gate is DONE or SKIPPED (a template without Raise PR has no gate), or an admin override exists on the ticket. Reopening an
 * earlier stage resets later ones to PENDING, so the gate fails again until they are redone.
 */
export async function evaluateGates(ticketId: string): Promise<GateEvaluation> {
  // The pinned template version's required stages (runs left over from a template switch do not count).
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { templateVersionId: true } });
  const [runs, overrides] = await Promise.all([
    prisma.stageRun.findMany({
      where: { ticketId, stageDef: { versionId: ticket?.templateVersionId ?? '' } },
      include: { stageDef: true },
      orderBy: { stageDef: { order: 'asc' } },
    }),
    prisma.override.findMany({ where: { ticketId }, include: { admin: true }, orderBy: { createdAt: 'asc' } }),
  ]);

  const lines: string[] = [];
  let allMet = true;
  for (const run of runs) {
    if (!run.stageDef.requiredForGate) continue;
    const ok = run.status === 'DONE' || run.status === 'SKIPPED';
    if (!ok) allMet = false;
    lines.push(`- ${ok ? '[x]' : '[ ]'} ${run.stageDef.name}: ${run.status}`);
  }

  const overridden = overrides.length > 0;
  for (const o of overrides) {
    lines.push(`- Admin override (${o.kind}) by ${o.admin.name}: ${o.reason}`);
  }
  return { pass: allMet || overridden, overridden, lines };
}
