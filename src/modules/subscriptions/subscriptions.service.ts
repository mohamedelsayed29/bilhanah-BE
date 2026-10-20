import { Injectable } from '@nestjs/common';
import type { RestaurantAccess } from '@bilhanah/contracts';
import type { Prisma, RestaurantStatus } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { resolveAccess } from './access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grants the automatic trial using the current global settings. Runs inside
   * the restaurant-creation transaction; a unique index allows one trial per restaurant.
   */
  async startTrial(tx: Prisma.TransactionClient, restaurantId: string, now: Date): Promise<void> {
    const settings = await tx.trialSettings.findUniqueOrThrow({ where: { id: 1 } });
    if (!settings.enabled) return;
    await tx.entitlement.create({
      data: {
        restaurantId,
        kind: 'TRIAL',
        planCode: settings.planCode,
        startsAt: now,
        endsAt: new Date(now.getTime() + settings.durationDays * DAY_MS),
      },
    });
  }

  async accessFor(restaurant: { id: string; status: RestaurantStatus }, now = new Date()): Promise<RestaurantAccess> {
    const entitlements = await this.prisma.entitlement.findMany({
      where: { restaurantId: restaurant.id },
      select: { kind: true, planCode: true, startsAt: true, endsAt: true },
    });
    return resolveAccess(restaurant.status, entitlements, now);
  }
}
