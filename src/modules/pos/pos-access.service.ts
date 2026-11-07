import { ConflictException, Injectable } from '@nestjs/common';
import {
  DEFAULT_POS_SETTINGS, POS_ERROR_CODES, type PlanCode, type PosDisabledReason, type PosMode, type PosOverview, type PosSettings, type PosStatus,
} from '@bilhanah/contracts';
import type { PosAccount, Prisma, RestaurantStatus } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

type Restaurant = { id: string; status: RestaurantStatus };
type Platform = { enabled: boolean; plans: PlanCode[] };

/** A restaurant's POS status, in order: platform and plan, the administrator, then the owner's setup. */
export function posStatus(platform: Platform, planCode: PlanCode | null, account: Pick<PosAccount, 'access' | 'activatedAt' | 'setupCompletedAt'> | null): { status: PosStatus; disabledReason: PosDisabledReason | null } {
  if (!platform.enabled) return { status: 'DISABLED', disabledReason: 'PLATFORM' };
  if (!planCode || !platform.plans.includes(planCode)) return { status: 'DISABLED', disabledReason: 'PLAN' };
  if (account?.access === 'DISABLED') return { status: 'DISABLED', disabledReason: 'ADMIN' };
  if (account?.access === 'SUSPENDED') return { status: 'SUSPENDED', disabledReason: null };
  if (!account?.activatedAt) return { status: 'NOT_ACTIVATED', disabledReason: null };
  if (!account.setupCompletedAt) return { status: 'PENDING_SETUP', disabledReason: null };
  return { status: 'ACTIVE', disabledReason: null };
}

export function settingsOf(account: PosAccount | null): PosSettings {
  if (!account) return { ...DEFAULT_POS_SETTINGS };
  return {
    taxRateBps: account.taxRateBps, taxInclusive: account.taxInclusive, serviceChargeBps: account.serviceChargeBps,
    serviceChargeDineInOnly: account.serviceChargeDineInOnly, paymentMethods: account.paymentMethods,
    cashierMaxDiscountPercent: account.cashierMaxDiscountPercent, requireOpenShift: account.requireOpenShift,
    receiptHeader: account.receiptHeader, receiptFooter: account.receiptFooter, receiptShowLogo: account.receiptShowLogo,
  };
}

export const posUnavailable = (status: PosStatus) =>
  new ConflictException({ code: POS_ERROR_CODES.POS_UNAVAILABLE, message: 'The POS is not available for this restaurant.', details: { status } });

/** Whether a restaurant may use its POS, for every POS route. */
@Injectable()
export class PosAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  platform(db: Prisma.TransactionClient = this.prisma): Promise<Platform & { updatedAt: Date }> {
    return db.posPlatformSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }

  async planCode(restaurant: Restaurant): Promise<PlanCode | null> {
    const access = await this.subscriptions.accessFor(restaurant);
    return hasAccess(access) ? access.planCode : null;
  }

  async overview(restaurant: Restaurant): Promise<PosOverview & { account: PosAccount | null }> {
    const [platform, planCode, account] = await Promise.all([
      this.platform(), this.planCode(restaurant), this.prisma.posAccount.findUnique({ where: { restaurantId: restaurant.id } }),
    ]);
    const { status, disabledReason } = posStatus(platform, planCode, account);
    return {
      account,
      status,
      disabledReason,
      accessReason: account?.accessReason ?? null,
      allowedModes: account?.allowedModes ?? (['BILHANAH', 'EXTERNAL'] satisfies PosMode[]),
      mode: account?.mode ?? null,
      activatedAt: account?.activatedAt?.toISOString() ?? null,
      setupCompletedAt: account?.setupCompletedAt?.toISOString() ?? null,
      settings: settingsOf(account),
      updatedAt: account?.updatedAt.toISOString() ?? null,
    };
  }

  /** Refuses (409 POS_UNAVAILABLE) unless the POS is ACTIVE; returns the account. */
  async requireActive(restaurant: Restaurant): Promise<PosAccount> {
    const overview = await this.overview(restaurant);
    if (overview.status !== 'ACTIVE' || !overview.account) throw posUnavailable(overview.status);
    return overview.account;
  }
}
