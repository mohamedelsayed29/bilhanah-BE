import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export type AuditEvent = {
  actorId: string | null;
  /** Set for a restaurant's own events (staff and role changes), so the restaurant can read them. */
  restaurantId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
};

/** Records administrator actions and restaurants' staff changes. Pass the transaction so the record commits with the change it describes. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(event: AuditEvent, tx: Prisma.TransactionClient = this.prisma): Promise<unknown> {
    return tx.auditLog.create({
      data: {
        actorId: event.actorId,
        restaurantId: event.restaurantId ?? null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        metadata: event.metadata,
        ipAddress: event.ipAddress?.slice(0, 64) ?? null,
      },
    });
  }
}
