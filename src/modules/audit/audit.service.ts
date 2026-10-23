import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export type AuditEvent = {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
};

/** Records administrator actions. Pass the transaction so the record commits with the change it describes. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(event: AuditEvent, tx: Prisma.TransactionClient = this.prisma): Promise<unknown> {
    return tx.auditLog.create({
      data: {
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        metadata: event.metadata,
        ipAddress: event.ipAddress?.slice(0, 64) ?? null,
      },
    });
  }
}
