import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

interface AuditInput {
  type: string;
  actorId?: string | null;
  projectId?: string | null;
  ticketId?: string | null;
  stageRunId?: string | null;
  data?: Prisma.InputJsonValue;
}

export async function audit(input: AuditInput, tx: Prisma.TransactionClient = prisma): Promise<void> {
  await tx.auditEvent.create({
    data: {
      type: input.type,
      actorId: input.actorId ?? null,
      projectId: input.projectId ?? null,
      ticketId: input.ticketId ?? null,
      stageRunId: input.stageRunId ?? null,
      data: input.data ?? {},
    },
  });
}
