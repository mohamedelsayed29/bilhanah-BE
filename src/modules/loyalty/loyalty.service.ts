import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type LoyaltyAnalytics,
  type LoyaltyCardLink,
  LOYALTY_ERROR_CODES as CODES,
  type LoyaltyJoinResponse,
  type LoyaltyMemberCard,
  type LoyaltyMemberDetail,
  type LoyaltyMembersPage,
  type LoyaltyMemberView,
  type LoyaltyReward,
  type LoyaltySettings,
  type LoyaltyTier,
  type LoyaltyTransaction,
  type Permission,
  type PublicLoyaltyProgram,
  type PublicLoyaltyReward,
  normalizeSubdomain,
  RESTAURANT_ERROR_CODES,
  tierFor,
  type loyaltyAdjustSchema,
  type loyaltyAnalyticsQuerySchema,
  type loyaltyJoinSchema,
  type loyaltyMembersQuerySchema,
  type loyaltyRewardSchema,
  type loyaltySettingsSchema,
  type loyaltyTiersSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { LoyaltyMember, LoyaltyTier as TierRow } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { LoyaltyCore, loyaltyUnavailable, passInvalid, type Program } from './loyalty-core.service.js';
import { evaluateReward, maskPhone, settingsFrom } from './loyalty-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY = 100;

const memberNotFound = () => new NotFoundException({ code: CODES.LOYALTY_MEMBER_NOT_FOUND, message: 'Member not found.' });
const rewardNotFound = () => new NotFoundException({ code: CODES.LOYALTY_REWARD_NOT_FOUND, message: 'Reward not found.' });
const invalid = (message: string, details?: Record<string, unknown>) => new BadRequestException({ code: CODES.LOYALTY_INVALID, message, ...(details && { details }) });

const rewardInclude = {
  menuItem: { select: { id: true, nameAr: true, nameEn: true } },
  variant: { select: { nameAr: true, nameEn: true } },
} satisfies Prisma.LoyaltyRewardInclude;
type RewardRow = Prisma.LoyaltyRewardGetPayload<{ include: typeof rewardInclude }>;

const transactionInclude = {
  order: { select: { id: true, number: true, placedAt: true, branch: { select: { name: true } } } },
  reward: { select: { nameAr: true } },
} satisfies Prisma.LoyaltyTransactionInclude;
type TransactionRow = Prisma.LoyaltyTransactionGetPayload<{ include: typeof transactionInclude }>;

/**
 * Loyalty for diners (the program, their card, joining) and for the restaurant (rules, rewards,
 * tiers, members, adjustments, analytics). Staff need loyalty.view / loyalty.adjust /
 * loyalty.settings; everything is scoped to the caller's restaurant, and members, rewards and
 * transactions are always looked up together with it.
 */
@Injectable()
export class LoyaltyService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: LoyaltyCore,
    private readonly scopes: BranchScopeService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  // --- Diners ------------------------------------------------------------------

  async publicProgram(subdomain: string): Promise<PublicLoyaltyProgram> {
    const restaurant = await this.restaurantBySubdomain(subdomain);
    const program = await this.core.program(restaurant);
    if (!program) return { enabled: false };
    const rewards = await this.activeRewards(restaurant.id);
    const { settings } = program;
    return {
      enabled: true,
      nameAr: settings.nameAr,
      nameEn: settings.nameEn,
      pointsPerUnit: settings.pointsPerUnit,
      spendUnitPiastres: settings.spendUnitPiastres,
      earnOn: settings.earnOn,
      orderTypes: settings.orderTypes,
      minOrderPiastres: settings.minOrderPiastres,
      minRedeemPoints: settings.minRedeemPoints,
      maxDiscountPercent: settings.maxDiscountPercent,
      expiryDays: settings.expiryDays,
      tiers: program.tiers.map(tierView),
      rewards: rewards.map(publicReward),
    };
  }

  /** The member's own page: balance, tier, what they can redeem, and their history. */
  async me(subdomain: string, pass: string): Promise<LoyaltyMemberView> {
    const restaurant = await this.restaurantBySubdomain(subdomain);
    const program = await this.core.program(restaurant);
    if (!program) throw loyaltyUnavailable();
    let member = await this.core.memberByPass(restaurant.id, pass);
    if (!member) throw passInvalid();
    if (await this.core.expireMember(member, program.settings)) member = await this.prisma.loyaltyMember.findUniqueOrThrow({ where: { id: member.id } });

    const [rewards, counts, history, pending] = await Promise.all([
      this.activeRewards(restaurant.id),
      this.core.redeemedCounts(member.id),
      this.history(member.id),
      this.prisma.order.aggregate({ where: { loyaltyMemberId: member.id, loyaltyEarned: false, status: { in: ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'] }, refundedAt: null }, _sum: { loyaltyPointsToEarn: true } }),
    ]);
    return {
      member: this.card(member, program, true),
      rewards: rewards.map((reward) => {
        const redeemedCount = counts.get(reward.id) ?? 0;
        const { reason } = evaluateReward(reward, { settings: program.settings, tiers: program.tiers, balance: member.balance, lifetimePoints: member.lifetimePoints, redeemedCount });
        return { ...publicReward(reward), available: reason === null, reason, redeemedCount };
      }),
      // Staff names stay with the restaurant.
      history: history.map((entry) => ({ ...entry, actorName: null })),
      pendingPoints: pending._sum.loyaltyPointsToEarn ?? 0,
    };
  }

  /** Joins without ordering. A phone that is already a member gets its card from the restaurant, never here. */
  async join(subdomain: string, input: z.output<typeof loyaltyJoinSchema>): Promise<LoyaltyJoinResponse> {
    const restaurant = await this.restaurantBySubdomain(subdomain);
    const program = await this.core.program(restaurant);
    if (!program) throw loyaltyUnavailable();
    let member: LoyaltyMember;
    try {
      member = await this.prisma.loyaltyMember.create({ data: { restaurantId: restaurant.id, phone: input.phone, name: input.name } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: CODES.LOYALTY_MEMBER_EXISTS, message: 'This phone already has a membership. Ask the restaurant for your member card.' });
      }
      throw error;
    }
    return { pass: this.core.passFor(member), member: this.card(member, program, true) };
  }

  // --- Restaurant: rules -----------------------------------------------------------

  async getSettings(userId: string): Promise<LoyaltySettings> {
    const scope = await this.scope(userId, 'loyalty.view', 'loyalty.settings');
    return this.core.settings(scope.restaurant.id);
  }

  async saveSettings(userId: string, input: z.output<typeof loyaltySettingsSchema>): Promise<LoyaltySettings> {
    const scope = await this.scope(userId, 'loyalty.settings');
    const restaurantId = scope.restaurant.id;
    const before = await this.core.settings(restaurantId);
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.loyaltySettings.upsert({ where: { restaurantId }, create: { restaurantId, ...input }, update: input });
      if (before.enabled !== input.enabled) {
        await this.audit.record({ actorId: userId, restaurantId, action: input.enabled ? 'loyalty.enabled' : 'loyalty.disabled', targetType: 'loyalty-program' }, tx);
      } else {
        await this.audit.record({ actorId: userId, restaurantId, action: 'loyalty.settings.updated', targetType: 'loyalty-program' }, tx);
      }
      return saved;
    });
    return settingsFrom(row);
  }

  async tiers(userId: string): Promise<LoyaltyTier[]> {
    const scope = await this.scope(userId, 'loyalty.view', 'loyalty.settings');
    const rows = await this.prisma.loyaltyTier.findMany({ where: { restaurantId: scope.restaurant.id }, orderBy: { minLifetimePoints: 'asc' } });
    return rows.map(tierView);
  }

  /** Replaces the tier list: kept ids are updated, new ones created, missing ones removed (their rewards become open to everyone). */
  async saveTiers(userId: string, input: z.output<typeof loyaltyTiersSchema>): Promise<LoyaltyTier[]> {
    const scope = await this.scope(userId, 'loyalty.settings');
    const restaurantId = scope.restaurant.id;
    const thresholds = input.tiers.map((tier) => tier.minLifetimePoints);
    if (new Set(thresholds).size !== thresholds.length) throw invalid('Two tiers cannot start at the same points.');
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.loyaltyTier.findMany({ where: { restaurantId }, select: { id: true } });
      const known = new Set(existing.map((tier) => tier.id));
      const kept = input.tiers.filter((tier) => tier.id && known.has(tier.id)).map((tier) => tier.id!);
      await tx.loyaltyTier.deleteMany({ where: { restaurantId, id: { notIn: kept } } });
      // Thresholds are unique: move the kept ones out of the way first, so tiers can swap places.
      for (const [index, id] of kept.entries()) await tx.loyaltyTier.update({ where: { id }, data: { minLifetimePoints: -1 - index } });
      for (const tier of input.tiers) {
        const data = { nameAr: tier.nameAr, nameEn: tier.nameEn ?? null, minLifetimePoints: tier.minLifetimePoints, earnMultiplier: tier.earnMultiplier };
        if (tier.id && known.has(tier.id)) await tx.loyaltyTier.update({ where: { id: tier.id }, data });
        else await tx.loyaltyTier.create({ data: { restaurantId, ...data } });
      }
      await this.audit.record({ actorId: userId, restaurantId, action: 'loyalty.tiers.updated', targetType: 'loyalty-program', metadata: { tiers: input.tiers.length } }, tx);
    });
    return this.tiers(userId);
  }

  // --- Restaurant: rewards ---------------------------------------------------------

  async rewards(userId: string): Promise<LoyaltyReward[]> {
    const scope = await this.scope(userId, 'loyalty.view', 'loyalty.settings');
    const [rows, counts] = await Promise.all([
      this.prisma.loyaltyReward.findMany({ where: { restaurantId: scope.restaurant.id }, include: rewardInclude, orderBy: [{ sortOrder: 'asc' }, { pointsCost: 'asc' }] }),
      this.prisma.order.groupBy({ by: ['loyaltyRewardId'], where: { restaurantId: scope.restaurant.id, loyaltySpentHeld: true, loyaltyRewardId: { not: null } }, _count: { _all: true } }),
    ]);
    const used = new Map(counts.map((row) => [row.loyaltyRewardId!, row._count._all]));
    return rows.map((row) => rewardView(row, used.get(row.id) ?? 0));
  }

  async createReward(userId: string, input: z.output<typeof loyaltyRewardSchema>): Promise<LoyaltyReward> {
    const scope = await this.scope(userId, 'loyalty.settings');
    const restaurantId = scope.restaurant.id;
    if ((await this.prisma.loyaltyReward.count({ where: { restaurantId } })) >= 30) throw invalid('A program can have up to 30 rewards.');
    const data = await this.rewardData(restaurantId, input);
    const row = await this.prisma.loyaltyReward.create({ data: { restaurantId, ...data }, include: rewardInclude });
    await this.audit.record({ actorId: userId, restaurantId, action: 'loyalty.reward.created', targetType: 'loyalty-reward', targetId: row.id });
    return rewardView(row, 0);
  }

  async updateReward(userId: string, id: string, input: z.output<typeof loyaltyRewardSchema>): Promise<LoyaltyReward> {
    const scope = await this.scope(userId, 'loyalty.settings');
    const restaurantId = scope.restaurant.id;
    const existing = await this.prisma.loyaltyReward.findFirst({ where: { id, restaurantId }, select: { id: true } });
    if (!existing) throw rewardNotFound();
    const data = await this.rewardData(restaurantId, input);
    const row = await this.prisma.loyaltyReward.update({ where: { id }, data, include: rewardInclude });
    await this.audit.record({ actorId: userId, restaurantId, action: 'loyalty.reward.updated', targetType: 'loyalty-reward', targetId: id });
    const used = await this.prisma.order.count({ where: { loyaltyRewardId: id, loyaltySpentHeld: true } });
    return rewardView(row, used);
  }

  /** Removes a reward. Orders and transactions keep its name; nothing a member holds changes. */
  async deleteReward(userId: string, id: string): Promise<void> {
    const scope = await this.scope(userId, 'loyalty.settings');
    const { count } = await this.prisma.loyaltyReward.deleteMany({ where: { id, restaurantId: scope.restaurant.id } });
    if (!count) throw rewardNotFound();
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'loyalty.reward.deleted', targetType: 'loyalty-reward', targetId: id });
  }

  // --- Restaurant: members ---------------------------------------------------------

  async members(userId: string, query: z.output<typeof loyaltyMembersQuerySchema>): Promise<LoyaltyMembersPage> {
    const scope = await this.scope(userId, 'loyalty.view');
    const restaurantId = scope.restaurant.id;
    const q = query.q?.trim();
    const digits = q?.replace(/[^\d]/g, '');
    const where: Prisma.LoyaltyMemberWhereInput = {
      restaurantId,
      ...(q && { OR: [{ name: { contains: q, mode: 'insensitive' } }, ...(digits && digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] }),
    };
    const orderBy: Prisma.LoyaltyMemberOrderByWithRelationInput =
      query.sort === 'balance' ? { balance: 'desc' } : query.sort === 'lifetime' ? { lifetimePoints: 'desc' } : query.sort === 'joined' ? { createdAt: 'desc' } : { lastActivityAt: 'desc' };
    const [rows, total, settings, tiers] = await Promise.all([
      this.prisma.loyaltyMember.findMany({
        where, orderBy: [orderBy, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        include: { _count: { select: { orders: { where: { status: 'COMPLETED' } } } } },
      }),
      this.prisma.loyaltyMember.count({ where }),
      this.core.settings(restaurantId),
      this.prisma.loyaltyTier.findMany({ where: { restaurantId } }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        balance: row.balance,
        lifetimePoints: row.lifetimePoints,
        tierName: settings.tiersEnabled ? (tierFor(tiers, row.lifetimePoints)?.nameAr ?? null) : null,
        orders: row._count.orders,
        lastActivityAt: row.lastActivityAt.toISOString(),
        joinedAt: row.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async member(userId: string, memberId: string): Promise<LoyaltyMemberDetail> {
    const scope = await this.scope(userId, 'loyalty.view');
    const program = await this.programFor(scope.restaurant.id);
    let member = await this.ownMember(scope, memberId);
    if (await this.core.expireMember(member, program.settings)) member = await this.ownMember(scope, memberId);
    const [stats, history] = await Promise.all([
      this.prisma.order.aggregate({ where: { loyaltyMemberId: member.id, status: 'COMPLETED', refundedAt: null }, _count: { _all: true }, _sum: { subtotalPiastres: true, discountPiastres: true } }),
      this.history(member.id),
    ]);
    return {
      member: this.card(member, program, false),
      orders: stats._count._all,
      spentPiastres: (stats._sum.subtotalPiastres ?? 0) - (stats._sum.discountPiastres ?? 0),
      history,
    };
  }

  /** Adds or removes points by hand, with a reason; never below a zero balance. */
  async adjust(userId: string, memberId: string, input: z.output<typeof loyaltyAdjustSchema>): Promise<LoyaltyMemberDetail> {
    const scope = await this.scope(userId, 'loyalty.adjust');
    const member = await this.ownMember(scope, memberId);
    const actor = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await this.prisma.$transaction(async (tx) => {
      const balance = await this.core.post(tx, member.id, scope.restaurant.id, {
        kind: 'ADJUST', points: input.points, reason: input.reason, actor: { id: userId, name: actor?.fullName ?? null }, activity: input.points > 0, requireBalance: input.points < 0,
      });
      if (balance === null) throw new ConflictException({ code: CODES.LOYALTY_BALANCE_TOO_LOW, message: 'The member does not have that many points.', details: { balance: member.balance } });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'loyalty.points.adjusted', targetType: 'loyalty-member', targetId: member.id, metadata: { points: input.points, reason: input.reason } }, tx);
    });
    return this.member(userId, memberId);
  }

  /** A new member card (to show as a QR code or send); every card issued before stops working. */
  async issueCard(userId: string, memberId: string): Promise<LoyaltyCardLink> {
    const scope = await this.scope(userId, 'loyalty.adjust');
    await this.ownMember(scope, memberId);
    const member = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.loyaltyMember.update({ where: { id: memberId }, data: { passVersion: { increment: 1 } } });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'loyalty.card.issued', targetType: 'loyalty-member', targetId: memberId }, tx);
      return updated;
    });
    const pass = this.core.passFor(member);
    const base = this.urlTemplate.replace('{subdomain}', scope.restaurant.subdomain).replace(/\/$/, '');
    return { pass, url: `${base}/loyalty#card=${encodeURIComponent(pass)}` };
  }

  // --- Restaurant: analytics -------------------------------------------------------

  async analytics(userId: string, query: z.output<typeof loyaltyAnalyticsQuerySchema>, now = new Date()): Promise<LoyaltyAnalytics> {
    const scope = await this.scope(userId, 'loyalty.view');
    const restaurantId = scope.restaurant.id;
    const since = new Date(now.getTime() - query.days * DAY_MS);
    const timezone = scope.restaurant.timezone;

    const [members, newMembers, ledger, active, outstanding, customers, revenue, rewardRows, daily] = await Promise.all([
      this.prisma.loyaltyMember.count({ where: { restaurantId } }),
      this.prisma.loyaltyMember.count({ where: { restaurantId, createdAt: { gte: since } } }),
      this.prisma.loyaltyTransaction.groupBy({ by: ['kind'], where: { restaurantId, createdAt: { gte: since } }, _sum: { points: true } }),
      this.prisma.loyaltyTransaction.findMany({ where: { restaurantId, createdAt: { gte: since }, kind: { in: ['EARN', 'REDEEM'] } }, distinct: ['memberId'], select: { memberId: true } }),
      this.prisma.loyaltyMember.aggregate({ where: { restaurantId, balance: { gt: 0 } }, _sum: { balance: true } }),
      // Customers are known by phone (members by theirs); the nth completed order tells a returning one.
      this.prisma.$queryRaw<{ customers: bigint; returning: bigint; returning_revenue: bigint | null }[]>`
        WITH completed AS (
          SELECT o.placed_at, o.subtotal_piastres - o.discount_piastres AS total,
                 COALESCE(m.phone, o.customer_phone) AS customer
          FROM orders o LEFT JOIN loyalty_members m ON m.id = o.loyalty_member_id
          WHERE o.restaurant_id = ${restaurantId}::uuid AND o.status = 'COMPLETED' AND o.refunded_at IS NULL AND o.placed_at < ${now}
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY customer ORDER BY placed_at) AS nth,
                 COUNT(*) OVER (PARTITION BY customer) AS orders
          FROM completed WHERE customer IS NOT NULL
        )
        SELECT COUNT(DISTINCT customer) FILTER (WHERE placed_at >= ${since}) AS customers,
               COUNT(DISTINCT customer) FILTER (WHERE placed_at >= ${since} AND orders >= 2) AS returning,
               SUM(total) FILTER (WHERE placed_at >= ${since} AND nth >= 2) AS returning_revenue
        FROM ranked`,
      this.prisma.order.aggregate({ where: { restaurantId, status: 'COMPLETED', refundedAt: null, placedAt: { gte: since, lt: now } }, _sum: { subtotalPiastres: true, discountPiastres: true } }),
      this.prisma.order.groupBy({
        by: ['loyaltyRewardId', 'loyaltyRewardName'], where: { restaurantId, loyaltySpentHeld: true, placedAt: { gte: since } },
        _count: { _all: true }, _sum: { discountPiastres: true }, orderBy: { _count: { loyaltyRewardId: 'desc' } }, take: 5,
      }),
      this.prisma.$queryRaw<{ day: string; issued: bigint | null; redeemed: bigint | null }[]>`
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               SUM(t.points) FILTER (WHERE t.kind IN ('EARN', 'ADJUST') AND t.points > 0) AS issued,
               -SUM(t.points) FILTER (WHERE t.kind = 'REDEEM') AS redeemed
        FROM generate_series((${since} AT TIME ZONE ${timezone})::date, (${now} AT TIME ZONE ${timezone})::date, interval '1 day') AS d(day)
        LEFT JOIN loyalty_transactions t ON t.restaurant_id = ${restaurantId}::uuid AND (t.created_at AT TIME ZONE ${timezone})::date = d.day AND t.created_at >= ${since}
        GROUP BY d.day ORDER BY d.day`,
    ]);

    const sum = (kind: string) => ledger.find((row) => row.kind === kind)?._sum.points ?? 0;
    const adjustedUp = await this.prisma.loyaltyTransaction.aggregate({ where: { restaurantId, createdAt: { gte: since }, kind: 'ADJUST', points: { gt: 0 } }, _sum: { points: true } });
    const pointsIssued = sum('EARN') + sum('EARN_REVERSAL') + (adjustedUp._sum.points ?? 0);
    const pointsRedeemed = -(sum('REDEEM') + sum('REDEEM_RETURN'));
    const customerRow = customers[0];
    const customerCount = Number(customerRow?.customers ?? 0);
    const returningCount = Number(customerRow?.returning ?? 0);
    return {
      days: query.days,
      members,
      newMembers,
      activeMembers: active.length,
      pointsIssued,
      pointsRedeemed,
      pointsExpired: -sum('EXPIRE'),
      outstandingPoints: outstanding._sum.balance ?? 0,
      redemptionRate: pointsIssued > 0 ? Math.max(0, pointsRedeemed) / pointsIssued : null,
      repeatCustomerRate: customerCount ? returningCount / customerCount : null,
      customers: customerCount,
      returningCustomers: returningCount,
      returningRevenuePiastres: Number(customerRow?.returning_revenue ?? 0),
      revenuePiastres: (revenue._sum.subtotalPiastres ?? 0) - (revenue._sum.discountPiastres ?? 0),
      discountPiastres: revenue._sum.discountPiastres ?? 0,
      rewardsRedeemed: rewardRows.reduce((total, row) => total + row._count._all, 0),
      topRewards: rewardRows.map((row) => ({ id: row.loyaltyRewardId, name: row.loyaltyRewardName ?? '—', redemptions: row._count._all, discountPiastres: row._sum.discountPiastres ?? 0 })),
      daily: daily.map((row) => ({ day: row.day, issued: Number(row.issued ?? 0), redeemed: Number(row.redeemed ?? 0) })),
    };
  }

  // --- Helpers -----------------------------------------------------------------------

  /** The caller's scope; refuses without one of the permissions (403) or while the service cannot run (409). */
  private async scope(userId: string, ...anyOf: Permission[]): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    if (!anyOf.some((permission) => scope.permissions.has(permission))) this.scopes.require(scope, anyOf[0]!);
    if (!(await this.core.serviceWorks(scope.restaurant))) throw loyaltyUnavailable();
    return scope;
  }

  private async programFor(restaurantId: string): Promise<Program> {
    const settings = await this.core.settings(restaurantId);
    const tiers = settings.tiersEnabled ? await this.prisma.loyaltyTier.findMany({ where: { restaurantId }, orderBy: { minLifetimePoints: 'asc' } }) : [];
    return { settings, tiers };
  }

  private async ownMember(scope: Scope, memberId: string): Promise<LoyaltyMember> {
    const member = await this.prisma.loyaltyMember.findFirst({ where: { id: memberId, restaurantId: scope.restaurant.id } });
    if (!member) throw memberNotFound();
    return member;
  }

  private async restaurantBySubdomain(subdomain: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain: normalizeSubdomain(subdomain) }, select: { id: true, status: true } });
    if (!restaurant) throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    return restaurant;
  }

  private activeRewards(restaurantId: string): Promise<RewardRow[]> {
    return this.prisma.loyaltyReward.findMany({ where: { restaurantId, isActive: true }, include: rewardInclude, orderBy: [{ sortOrder: 'asc' }, { pointsCost: 'asc' }] });
  }

  private async rewardData(restaurantId: string, input: z.output<typeof loyaltyRewardSchema>) {
    const free = input.type === 'FREE_PRODUCT' || input.type === 'FREE_ADDON';
    if (free) {
      const item = await this.prisma.menuItem.findFirst({ where: { id: input.menuItemId!, restaurantId }, select: { id: true, variants: { select: { id: true } } } });
      if (!item) throw invalid('That dish is not on your menu.', { field: 'menuItemId' });
      if (input.variantId && !item.variants.some((variant) => variant.id === input.variantId)) throw invalid('That size is not one of the dish’s.', { field: 'variantId' });
    }
    if (input.tierId && !(await this.prisma.loyaltyTier.findFirst({ where: { id: input.tierId, restaurantId }, select: { id: true } }))) {
      throw invalid('That tier does not exist.', { field: 'tierId' });
    }
    return {
      type: input.type,
      nameAr: input.nameAr,
      nameEn: input.nameEn ?? null,
      pointsCost: input.pointsCost,
      amountPiastres: input.type === 'FIXED_DISCOUNT' ? input.amountPiastres! : null,
      percent: input.type === 'PERCENT_DISCOUNT' ? input.percent! : null,
      maxDiscountPiastres: input.type === 'PERCENT_DISCOUNT' ? (input.maxDiscountPiastres ?? null) : null,
      menuItemId: free ? input.menuItemId! : null,
      variantId: free ? (input.variantId ?? null) : null,
      minOrderPiastres: input.minOrderPiastres,
      maxPerMember: input.maxPerMember ?? null,
      tierId: input.tierId ?? null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    };
  }

  private async history(memberId: string): Promise<LoyaltyTransaction[]> {
    const rows = await this.prisma.loyaltyTransaction.findMany({ where: { memberId }, include: transactionInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY });
    return rows.map(transactionView);
  }

  private card(member: LoyaltyMember, program: Program, diner: boolean): LoyaltyMemberCard {
    const tier = program.settings.tiersEnabled ? tierFor(program.tiers, member.lifetimePoints) : null;
    const next = program.settings.tiersEnabled ? program.tiers.find((candidate) => candidate.minLifetimePoints > member.lifetimePoints) ?? null : null;
    return {
      id: member.id,
      name: member.name,
      phone: diner ? maskPhone(member.phone) : member.phone,
      balance: member.balance,
      lifetimePoints: member.lifetimePoints,
      tier: tier ? tierView(tier) : null,
      nextTier: next ? { ...tierView(next), pointsToGo: next.minLifetimePoints - member.lifetimePoints } : null,
      expiresAt: this.core.expiresAt(member, program.settings)?.toISOString() ?? null,
      joinedAt: member.createdAt.toISOString(),
    };
  }
}

function tierView(tier: TierRow): LoyaltyTier {
  return { id: tier.id, nameAr: tier.nameAr, nameEn: tier.nameEn, minLifetimePoints: tier.minLifetimePoints, earnMultiplier: tier.earnMultiplier };
}

function rewardView(row: RewardRow, redemptions: number): LoyaltyReward {
  return {
    id: row.id,
    type: row.type,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    pointsCost: row.pointsCost,
    amountPiastres: row.amountPiastres,
    percent: row.percent,
    maxDiscountPiastres: row.maxDiscountPiastres,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    menuItem: row.menuItem ? { id: row.menuItem.id, nameAr: row.menuItem.nameAr, nameEn: row.menuItem.nameEn, variantNameAr: row.variant?.nameAr ?? null, variantNameEn: row.variant?.nameEn ?? null } : null,
    minOrderPiastres: row.minOrderPiastres,
    maxPerMember: row.maxPerMember,
    tierId: row.tierId,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    redemptions,
  };
}

function publicReward(row: RewardRow): PublicLoyaltyReward {
  const { id, type, nameAr, nameEn, pointsCost, amountPiastres, percent, maxDiscountPiastres, menuItemId, variantId, menuItem, minOrderPiastres, tierId } = rewardView(row, 0);
  return { id, type, nameAr, nameEn, pointsCost, amountPiastres, percent, maxDiscountPiastres, menuItemId, variantId, menuItem, minOrderPiastres, tierId };
}

function transactionView(row: TransactionRow): LoyaltyTransaction {
  return {
    id: row.id,
    kind: row.kind,
    points: row.points,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    order: row.order ? { id: row.order.id, number: row.order.number, placedAt: row.order.placedAt.toISOString(), branchName: row.order.branch.name } : null,
    rewardName: row.reward?.nameAr ?? null,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
  };
}
