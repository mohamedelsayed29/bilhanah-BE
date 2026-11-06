import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  activeDependents,
  missingRequirements,
  planIncludesService,
  RESTAURANT_ERROR_CODES,
  RESTAURANT_SERVICES,
  type RestaurantServiceKey,
  type RestaurantSetup,
  type RestaurantSetupSummary,
  type restaurantSetupSchema,
  SERVICE_ERROR_CODES,
  SERVICE_RULES,
  type ServiceStates,
} from '@bilhanah/contracts';
import type { Prisma, RestaurantStatus } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { readServiceStates } from './service-states.js';

type Owned = { id: string; status: RestaurantStatus };
type SetupRow = Pick<Prisma.RestaurantGetPayload<object>, 'menuSource' | 'externalMenuUrl' | 'externalPosName' | 'setupCompletedAt'>;

const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ConflictException({ code, message, ...(details && { details }) });

/**
 * Restaurant services (docs/SERVICES.md): what the owner switches on or off, and the setup chosen
 * while onboarding (where the menu lives, the POS). Every route is scoped to the caller's own
 * restaurant; switching a service off changes one row and never touches the service's data.
 */
@Injectable()
export class RestaurantServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly audit: AuditService,
  ) {}

  states(restaurantId: string, db: Prisma.TransactionClient = this.prisma): Promise<ServiceStates> {
    return readServiceStates(db, restaurantId);
  }

  /** Refuses (409 SERVICE_INACTIVE) while the service, or one it needs, is off. */
  async require(restaurantId: string, key: RestaurantServiceKey): Promise<void> {
    const on = await this.states(restaurantId);
    const off = [key, ...SERVICE_RULES[key].requires].find((service) => !on[service]);
    if (off) throw conflict(SERVICE_ERROR_CODES.SERVICE_INACTIVE, 'This service is switched off for your restaurant.', { service: off });
  }

  /** The restaurant an account belongs to (owner or staff); null for administrators. */
  async restaurantOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, restaurant: { select: { id: true } }, staffRestaurantId: true },
    });
    if (!user || user.role === 'ADMIN') return null;
    return user.role === 'OWNER' ? (user.restaurant?.id ?? null) : user.staffRestaurantId;
  }

  async summary(restaurant: Owned & SetupRow): Promise<RestaurantSetupSummary> {
    return { ...this.setupFields(restaurant), services: await this.states(restaurant.id) };
  }

  async setup(ownerId: string): Promise<RestaurantSetup> {
    return this.view(await this.owned(ownerId));
  }

  /** Switches one service on or off: on needs the plan and every required service; off needs no service depending on it. */
  async setEnabled(ownerId: string, key: RestaurantServiceKey, enabled: boolean): Promise<RestaurantSetup> {
    const restaurant = await this.owned(ownerId);
    await this.prisma.$transaction(async (tx) => {
      // One switch at a time per restaurant, so two requests cannot leave a dependent on without its requirement.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`services:${restaurant.id}`}))`;
      const on = await this.states(restaurant.id, tx);
      if (on[key] === enabled) return;
      if (enabled) await this.checkCanEnable(restaurant, key, on);
      else {
        const dependents = activeDependents(key, on);
        if (dependents.length) {
          throw conflict(SERVICE_ERROR_CODES.SERVICE_DEPENDENTS, 'Switch off the services that need this one first.', { dependents });
        }
      }
      await this.write(tx, restaurant.id, ownerId, { [key]: enabled });
    });
    return this.view(restaurant);
  }

  /** Saves the onboarding answers and, when given, the whole set of services, and marks setup done. */
  async saveSetup(ownerId: string, input: z.output<typeof restaurantSetupSchema>): Promise<RestaurantSetup> {
    const restaurant = await this.owned(ownerId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`services:${restaurant.id}`}))`;
      if (input.services) {
        const current = await this.states(restaurant.id, tx);
        const wanted = Object.fromEntries(RESTAURANT_SERVICES.map((key) => [key, input.services!.includes(key)])) as ServiceStates;
        for (const key of RESTAURANT_SERVICES) {
          if (!wanted[key]) continue;
          const missing = missingRequirements(key, wanted);
          if (missing.length) throw conflict(SERVICE_ERROR_CODES.SERVICE_REQUIREMENTS, 'Switch on the services this one needs first.', { service: key, missing });
          if (!current[key]) await this.checkPlan(restaurant, key);
        }
        const changes = Object.fromEntries(RESTAURANT_SERVICES.filter((key) => current[key] !== wanted[key]).map((key) => [key, wanted[key]]));
        // Write every choice, so a restaurant that picked its services keeps them even if defaults change.
        await this.write(tx, restaurant.id, ownerId, wanted, changes);
      }
      await tx.restaurant.update({
        where: { id: restaurant.id },
        data: {
          menuSource: input.menuSource,
          externalMenuUrl: input.menuSource === 'EXTERNAL' ? (input.externalMenuUrl ?? null) : null,
          ...(input.externalPosName !== undefined && { externalPosName: input.externalPosName }),
          setupCompletedAt: new Date(),
        },
      });
    });
    return this.view(await this.owned(ownerId));
  }

  private async checkCanEnable(restaurant: Owned, key: RestaurantServiceKey, on: ServiceStates): Promise<void> {
    const missing = missingRequirements(key, on);
    if (missing.length) throw conflict(SERVICE_ERROR_CODES.SERVICE_REQUIREMENTS, 'Switch on the services this one needs first.', { service: key, missing });
    await this.checkPlan(restaurant, key);
  }

  private async checkPlan(restaurant: Owned, key: RestaurantServiceKey): Promise<void> {
    const access = await this.subscriptions.accessFor(restaurant);
    if (!planIncludesService(key, access.planFeatures)) {
      throw conflict(SERVICE_ERROR_CODES.SERVICE_NOT_IN_PLAN, 'Your plan does not include this service.', { service: key });
    }
  }

  /** Upserts the given states; `changes` (what actually changed) is what the audit log records. */
  private async write(tx: Prisma.TransactionClient, restaurantId: string, actorId: string, states: Partial<ServiceStates>, changes: Partial<ServiceStates> = states): Promise<void> {
    for (const [service, enabled] of Object.entries(states) as [RestaurantServiceKey, boolean][]) {
      await tx.restaurantService.upsert({
        where: { restaurantId_service: { restaurantId, service } },
        create: { restaurantId, service, enabled, changedById: actorId },
        update: { enabled, changedById: actorId },
      });
    }
    for (const [service, enabled] of Object.entries(changes) as [RestaurantServiceKey, boolean][]) {
      await this.audit.record({ actorId, restaurantId, action: enabled ? 'service.enabled' : 'service.disabled', targetType: 'restaurant-service', targetId: service }, tx);
    }
  }

  private async view(restaurant: Owned & SetupRow): Promise<RestaurantSetup> {
    const [rows, access] = await Promise.all([
      this.prisma.restaurantService.findMany({ where: { restaurantId: restaurant.id } }),
      this.subscriptions.accessFor(restaurant),
    ]);
    const on = await this.states(restaurant.id);
    return {
      ...this.setupFields(restaurant),
      services: RESTAURANT_SERVICES.map((key) => ({
        key,
        enabled: on[key],
        inPlan: planIncludesService(key, access.planFeatures),
        requires: SERVICE_RULES[key].requires,
        missing: missingRequirements(key, on),
        dependents: activeDependents(key, on),
        changedAt: rows.find((row) => row.service === key)?.changedAt.toISOString() ?? null,
      })),
    };
  }

  private setupFields(restaurant: SetupRow): Omit<RestaurantSetup, 'services'> {
    return {
      menuSource: restaurant.menuSource,
      externalMenuUrl: restaurant.externalMenuUrl,
      externalPosName: restaurant.externalPosName,
      completedAt: restaurant.setupCompletedAt?.toISOString() ?? null,
    };
  }

  private async owned(ownerId: string): Promise<Owned & SetupRow> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true, status: true, menuSource: true, externalMenuUrl: true, externalPosName: true, setupCompletedAt: true },
    });
    if (!restaurant) throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    if (restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED, message: 'This restaurant is suspended. Please contact Bilhanah support.' });
    }
    return restaurant;
  }
}
