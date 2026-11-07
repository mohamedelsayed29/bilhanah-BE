import { ConflictException, Injectable } from '@nestjs/common';
import {
  type AdminPosRestaurant, type Paginated, type PlanCode, POS_ERROR_CODES, type PosMode, type PosOverview, type PosPlatformSettings, type PosSettings, type PosStatus,
  type adminPosAccountSchema, type adminPosRestaurantsQuerySchema, type posPlatformSettingsSchema,
} from '@bilhanah/contracts';
import type { PosAccount, Prisma, RestaurantStatus } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { PosAccessService, posStatus, posUnavailable } from './pos-access.service.js';

const modeAllowed = (mode: PosMode, allowed: PosMode[]) => (mode === 'BOTH' ? allowed.includes('BOTH') || (allowed.includes('BILHANAH') && allowed.includes('EXTERNAL')) : allowed.includes(mode) || allowed.includes('BOTH'));

/**
 * Turning the POS on and setting it up (owners: pos.settings), and the administrators' controls:
 * the platform switch and plans, and each restaurant's access. Every change is audited.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly scopes: BranchScopeService,
    private readonly audit: AuditService,
  ) {}

  // --- Restaurant -------------------------------------------------------------------

  async get(userId: string): Promise<PosOverview> {
    const scope = await this.scopes.resolve(userId);
    if (!['pos.use', 'pos.settings'].some((permission) => scope.permissions.has(permission as 'pos.use'))) this.scopes.require(scope, 'pos.settings');
    const { account: _account, ...overview } = await this.access.overview(scope.restaurant);
    return overview;
  }

  /** Wizard step 1: the mode. Allowed while not activated or pending setup (and to change the mode later while active). */
  async activate(userId: string, mode: PosMode): Promise<PosOverview> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'pos.settings');
    const restaurantId = scope.restaurant.id;
    const overview = await this.access.overview(scope.restaurant);
    if (!(['NOT_ACTIVATED', 'PENDING_SETUP', 'ACTIVE'] as PosStatus[]).includes(overview.status)) throw posUnavailable(overview.status);
    if (!modeAllowed(mode, overview.allowedModes)) {
      throw new ConflictException({ code: POS_ERROR_CODES.POS_MODE_NOT_ALLOWED, message: 'This POS mode is not available for your restaurant.', details: { allowedModes: overview.allowedModes } });
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.posAccount.upsert({
        where: { restaurantId },
        create: { restaurantId, mode, activatedAt: now },
        update: { mode, activatedAt: overview.activatedAt ? undefined : now },
      });
      await this.audit.record({ actorId: userId, restaurantId, action: overview.activatedAt ? 'pos.mode.changed' : 'pos.activated', targetType: 'pos', metadata: { mode, previous: overview.mode } }, tx);
    });
    return this.get(userId);
  }

  /** Wizard step 2, and the settings page afterwards: saving them completes the setup. */
  async saveSettings(userId: string, input: PosSettings): Promise<PosOverview> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'pos.settings');
    const restaurantId = scope.restaurant.id;
    const overview = await this.access.overview(scope.restaurant);
    if (!(['PENDING_SETUP', 'ACTIVE'] as PosStatus[]).includes(overview.status)) throw posUnavailable(overview.status);
    await this.prisma.$transaction(async (tx) => {
      await tx.posAccount.update({ where: { restaurantId }, data: { ...input, setupCompletedAt: overview.setupCompletedAt ? undefined : new Date() } });
      await this.audit.record({ actorId: userId, restaurantId, action: 'pos.settings.updated', targetType: 'pos', metadata: { previous: overview.settings, next: input } as unknown as Prisma.InputJsonValue }, tx);
    });
    return this.get(userId);
  }

  // --- Administrators ---------------------------------------------------------------

  async platform(): Promise<PosPlatformSettings> {
    const row = await this.access.platform();
    return { enabled: row.enabled, plans: row.plans, updatedAt: row.updatedAt.toISOString() };
  }

  async savePlatform(adminId: string, input: z.output<typeof posPlatformSettingsSchema>): Promise<PosPlatformSettings> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.access.platform(tx);
      await tx.posPlatformSettings.update({ where: { id: 1 }, data: { enabled: input.enabled, plans: [...new Set(input.plans)] } });
      await this.audit.record({ actorId: adminId, action: 'pos.platform.updated', targetType: 'pos-platform', metadata: { previous: { enabled: before.enabled, plans: before.plans }, next: input } }, tx);
    });
    return this.platform();
  }

  async restaurants(query: z.output<typeof adminPosRestaurantsQuerySchema>): Promise<Paginated<AdminPosRestaurant>> {
    const where: Prisma.RestaurantWhereInput = query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { subdomain: { contains: query.q.toLowerCase() } }] } : {};
    const platform = await this.access.platform();
    const all = await this.prisma.restaurant.findMany({ where, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, subdomain: true, status: true, posAccount: true } });
    const rows = (await Promise.all(all.map((restaurant) => this.row(platform, restaurant)))).filter((row) => !query.status || row.status === query.status);
    const start = (query.page - 1) * query.pageSize;
    return { items: rows.slice(start, start + query.pageSize), total: rows.length, page: query.page, pageSize: query.pageSize };
  }

  /** Enables, disables or suspends a restaurant's POS, and which modes it may use. No owner action needed. */
  async setAccount(adminId: string, restaurantId: string, input: z.output<typeof adminPosAccountSchema>): Promise<AdminPosRestaurant> {
    await this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.posAccount.findUnique({ where: { restaurantId } });
      const data = { access: input.access, accessReason: input.access === 'ENABLED' ? null : (input.reason ?? null), allowedModes: [...new Set(input.allowedModes)] };
      await tx.posAccount.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
      await this.audit.record({
        actorId: adminId, restaurantId, action: `pos.access.${input.access.toLowerCase()}`, targetType: 'pos',
        metadata: { previous: before ? { access: before.access, allowedModes: before.allowedModes } : null, next: data },
      }, tx);
    });
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { id: true, name: true, subdomain: true, status: true, posAccount: true } });
    return this.row(await this.access.platform(), restaurant);
  }

  private async row(platform: { enabled: boolean; plans: PlanCode[] }, restaurant: { id: string; name: string; subdomain: string; status: RestaurantStatus; posAccount: PosAccount | null }): Promise<AdminPosRestaurant> {
    const planCode = await this.access.planCode(restaurant);
    const { status, disabledReason } = posStatus(platform, planCode, restaurant.posAccount);
    const account = restaurant.posAccount;
    return {
      id: restaurant.id, name: restaurant.name, subdomain: restaurant.subdomain, planCode, status, disabledReason,
      access: account?.access ?? 'ENABLED', accessReason: account?.accessReason ?? null, allowedModes: account?.allowedModes ?? ['BILHANAH', 'EXTERNAL'],
      mode: account?.mode ?? null, activatedAt: account?.activatedAt?.toISOString() ?? null,
    };
  }
}
