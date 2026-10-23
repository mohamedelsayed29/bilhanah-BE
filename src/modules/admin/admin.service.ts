import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADMIN_ERROR_CODES,
  type adminAuditQuerySchema,
  type AdminOverview,
  type AdminPayment,
  type adminPaymentsQuerySchema,
  type AdminRestaurantDetail,
  type AdminRestaurantRow,
  type adminRestaurantsQuerySchema,
  type AdminSettings,
  type AuditEntry,
  type Paginated,
  type PlanCode,
  RESTAURANT_ERROR_CODES,
  type RestaurantAccess,
  type updatePaymentSettingsSchema,
  type updateTrialSettingsSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { toInstructions, toOwnerPayment } from '../billing/billing.service.js';
import { resolveAccess } from '../subscriptions/access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const restaurantSelect = {
  id: true,
  name: true,
  subdomain: true,
  city: true,
  status: true,
  createdAt: true,
  owner: { select: { fullName: true, email: true } },
  entitlements: { select: { kind: true, planCode: true, startsAt: true, endsAt: true } },
} satisfies Prisma.RestaurantSelect;

type RestaurantListRow = Prisma.RestaurantGetPayload<{ select: typeof restaurantSelect }>;

const paymentInclude = {
  entitlement: { select: { startsAt: true, endsAt: true } },
  restaurant: { select: { id: true, name: true, subdomain: true } },
  reviewedBy: { select: { fullName: true } },
} satisfies Prisma.SubscriptionPaymentInclude;

type PaymentListRow = Prisma.SubscriptionPaymentGetPayload<{ include: typeof paymentInclude }>;

const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

/** Platform administration: restaurants, payments, settings and the audit log. Every change is audited. */
@Injectable()
export class AdminService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  async overview(now = new Date()): Promise<AdminOverview> {
    const [restaurants, plans, pendingPayments] = await Promise.all([
      this.prisma.restaurant.findMany({ select: restaurantSelect }),
      this.planPrices(),
      this.prisma.subscriptionPayment.count({ where: { status: 'PENDING' } }),
    ]);
    const counts = { TRIAL: 0, PAID: 0, INACTIVE: 0, SUSPENDED: 0 };
    let monthlyRecurringPiastres = 0;
    let expiringSoon = 0;
    for (const restaurant of restaurants) {
      const access = this.accessOf(restaurant, now);
      counts[access.status] += 1;
      if (access.status === 'PAID' && access.planCode) monthlyRecurringPiastres += plans.get(access.planCode) ?? 0;
      // Ends within a week, with nothing queued after it.
      const coverageEnds = Math.max(0, ...restaurant.entitlements.map((entitlement) => entitlement.endsAt.getTime()));
      if ((access.status === 'TRIAL' || access.status === 'PAID') && coverageEnds - now.getTime() <= 7 * DAY_MS) expiringSoon += 1;
    }
    return {
      restaurants: { ...counts, total: restaurants.length },
      pendingPayments,
      monthlyRecurringPiastres,
      expiringSoon,
      newRestaurantsLast30Days: restaurants.filter((restaurant) => now.getTime() - restaurant.createdAt.getTime() <= 30 * DAY_MS).length,
    };
  }

  /**
   * Restaurants matching a name, subdomain or owner email. Access is computed
   * from entitlements, so the access filter is applied after the text search.
   */
  async restaurants(query: z.output<typeof adminRestaurantsQuerySchema>, now = new Date()): Promise<Paginated<AdminRestaurantRow>> {
    const text = query.query?.trim();
    // Only a query that looks like a phone number (e.g. "010 1234") searches phones,
    // so "pay-abc4" does not match every number containing a 4.
    const phoneDigits = text && /^[\d\s+()-]+$/.test(text) ? text.replace(/\D/g, '') : '';
    const rows = await this.prisma.restaurant.findMany({
      where: text
        ? {
            OR: [
              { name: { contains: text, mode: 'insensitive' } },
              { subdomain: { contains: text.toLowerCase() } },
              { owner: { email: { contains: text.toLowerCase() } } },
              ...(phoneDigits.length >= 4 ? [{ phone: { contains: phoneDigits } }] : []),
            ],
          }
        : undefined,
      select: restaurantSelect,
      orderBy: { createdAt: 'desc' },
    });
    const matching = rows
      .map((row) => this.toRow(row, now))
      .filter((row) => !query.access || row.access.status === query.access);
    const start = (query.page - 1) * query.pageSize;
    return { items: matching.slice(start, start + query.pageSize), total: matching.length, page: query.page, pageSize: query.pageSize };
  }

  async restaurant(id: string, now = new Date()): Promise<AdminRestaurantDetail> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id },
      select: {
        ...restaurantSelect,
        phone: true,
        address: true,
        whatsappNumber: true,
        ownerId: true,
        owner: { select: { fullName: true, email: true, status: true } },
        entitlements: {
          orderBy: { startsAt: 'desc' },
          select: {
            id: true,
            kind: true,
            planCode: true,
            startsAt: true,
            endsAt: true,
            note: true,
            grantedBy: { select: { fullName: true } },
            payment: { select: { id: true } },
          },
        },
        payments: { orderBy: { createdAt: 'desc' }, take: 50, include: paymentInclude },
        _count: { select: { categories: true, menuItems: true } },
      },
    });
    if (!restaurant) throw restaurantNotFound();
    return {
      ...this.toRow(restaurant, now),
      phone: restaurant.phone,
      address: restaurant.address,
      whatsappNumber: restaurant.whatsappNumber,
      status: restaurant.status,
      ownerId: restaurant.ownerId,
      ownerStatus: restaurant.owner.status,
      menu: { categories: restaurant._count.categories, items: restaurant._count.menuItems },
      entitlements: restaurant.entitlements.map((entitlement) => ({
        id: entitlement.id,
        kind: entitlement.kind,
        planCode: entitlement.planCode,
        startsAt: entitlement.startsAt.toISOString(),
        endsAt: entitlement.endsAt.toISOString(),
        note: entitlement.note,
        grantedBy: entitlement.grantedBy?.fullName ?? null,
        paymentId: entitlement.payment?.id ?? null,
      })),
      payments: restaurant.payments.map((payment) => this.toAdminPayment(payment)),
    };
  }

  /** Takes the public menu offline and blocks the owner's edits. Data is kept. */
  async setSuspended(adminId: string, id: string, suspended: boolean, reason: string | null, ipAddress?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.restaurant.updateMany({
        where: { id, status: suspended ? 'ACTIVE' : 'SUSPENDED' },
        data: { status: suspended ? 'SUSPENDED' : 'ACTIVE' },
      });
      if (changed.count !== 1) {
        if (!(await tx.restaurant.count({ where: { id } }))) throw restaurantNotFound();
        throw suspended
          ? new ConflictException({ code: ADMIN_ERROR_CODES.ALREADY_SUSPENDED, message: 'This restaurant is already suspended.' })
          : new ConflictException({ code: ADMIN_ERROR_CODES.NOT_SUSPENDED, message: 'This restaurant is not suspended.' });
      }
      await this.audit.record(
        {
          actorId: adminId,
          action: suspended ? 'restaurant.suspend' : 'restaurant.unsuspend',
          targetType: 'restaurant',
          targetId: id,
          metadata: reason ? { reason } : undefined,
          ipAddress,
        },
        tx,
      );
    });
  }

  async payments(query: z.output<typeof adminPaymentsQuerySchema>): Promise<Paginated<AdminPayment>> {
    const where = query.status ? { status: query.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.subscriptionPayment.findMany({
        where,
        include: paymentInclude,
        // Oldest pending first, so the queue is worked in order; otherwise newest first.
        orderBy: { createdAt: query.status === 'PENDING' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.subscriptionPayment.count({ where }),
    ]);
    return { items: items.map((payment) => this.toAdminPayment(payment)), total, page: query.page, pageSize: query.pageSize };
  }

  async payment(id: string): Promise<AdminPayment> {
    const payment = await this.prisma.subscriptionPayment.findUnique({ where: { id }, include: paymentInclude });
    if (!payment) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Payment not found.' });
    return this.toAdminPayment(payment);
  }

  async settings(): Promise<AdminSettings> {
    const [payment, trial, plans] = await Promise.all([
      this.prisma.paymentSettings.findUniqueOrThrow({ where: { id: 1 } }),
      this.prisma.trialSettings.findUniqueOrThrow({ where: { id: 1 } }),
      this.prisma.plan.findMany({ orderBy: { priceMonthlyPiastres: 'asc' } }),
    ]);
    return {
      payment: toInstructions(payment),
      trial: { enabled: trial.enabled, durationDays: trial.durationDays, planCode: trial.planCode },
      plans: plans.map((plan) => ({ code: plan.code, priceMonthlyPiastres: plan.priceMonthlyPiastres })),
    };
  }

  async updatePaymentSettings(adminId: string, input: z.output<typeof updatePaymentSettingsSchema>, ipAddress?: string): Promise<AdminSettings> {
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentSettings.update({ where: { id: 1 }, data: input });
      await this.audit.record({ actorId: adminId, action: 'settings.payment', targetType: 'settings', metadata: input, ipAddress }, tx);
    });
    return this.settings();
  }

  /** Applies to restaurants created from now on; existing trials are unchanged. */
  async updateTrialSettings(adminId: string, input: z.output<typeof updateTrialSettingsSchema>, ipAddress?: string): Promise<AdminSettings> {
    await this.prisma.$transaction(async (tx) => {
      await tx.trialSettings.update({ where: { id: 1 }, data: input });
      await this.audit.record({ actorId: adminId, action: 'settings.trial', targetType: 'settings', metadata: input, ipAddress }, tx);
    });
    return this.settings();
  }

  /** New payments use the new price; approved periods and pending payments keep theirs. */
  async updatePlanPrice(adminId: string, code: PlanCode, priceMonthlyPiastres: number, ipAddress?: string): Promise<AdminSettings> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUniqueOrThrow({ where: { code } });
      await tx.plan.update({ where: { code }, data: { priceMonthlyPiastres } });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'plan.price',
          targetType: 'plan',
          targetId: code,
          metadata: { from: before.priceMonthlyPiastres, to: priceMonthlyPiastres },
          ipAddress,
        },
        tx,
      );
    });
    return this.settings();
  }

  async auditLog(query: z.output<typeof adminAuditQuerySchema>): Promise<Paginated<AuditEntry>> {
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.auditLog.count(),
    ]);
    return {
      items: items.map((entry) => ({
        id: entry.id,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata,
        actor: entry.actor ? { id: entry.actor.id, name: entry.actor.fullName, email: entry.actor.email } : null,
        ipAddress: entry.ipAddress,
        createdAt: entry.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private accessOf(restaurant: Pick<RestaurantListRow, 'status' | 'entitlements'>, now: Date): RestaurantAccess {
    return resolveAccess(restaurant.status, restaurant.entitlements, now);
  }

  private toRow(restaurant: RestaurantListRow, now: Date): AdminRestaurantRow {
    return {
      id: restaurant.id,
      name: restaurant.name,
      subdomain: restaurant.subdomain,
      publicUrl: this.urlTemplate.replace('{subdomain}', restaurant.subdomain),
      city: restaurant.city,
      ownerName: restaurant.owner.fullName,
      ownerEmail: restaurant.owner.email,
      access: this.accessOf(restaurant, now),
      createdAt: restaurant.createdAt.toISOString(),
    };
  }

  private toAdminPayment(payment: PaymentListRow): AdminPayment {
    return {
      ...toOwnerPayment(payment),
      restaurant: payment.restaurant,
      reviewedBy: payment.reviewedBy?.fullName ?? null,
    };
  }

  private async planPrices(): Promise<Map<PlanCode, number>> {
    const plans = await this.prisma.plan.findMany();
    return new Map(plans.map((plan) => [plan.code, plan.priceMonthlyPiastres]));
  }
}
