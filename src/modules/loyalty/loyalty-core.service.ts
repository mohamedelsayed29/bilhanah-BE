import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  LOYALTY_ERROR_CODES as CODES,
  type LoyaltyIneligibleReason,
  type LoyaltyQuote,
  type LoyaltySettings,
  type OrderType,
  pointsFor,
  type RewardLine,
  serviceWorks,
  tierFor,
} from '@bilhanah/contracts';
import type { LoyaltyMember, LoyaltyTier, Prisma, RestaurantStatus } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { readServiceStates } from '../services/service-states.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { evaluateReward, loyaltyTargets, settingsFrom } from './loyalty-rules.js';
import { expireDue, expiresAt, postLoyalty, type PostEntry } from './loyalty-ledger.js';
import { LoyaltyPasses } from './loyalty-pass.js';

export type Tx = Prisma.TransactionClient;
type Restaurant = { id: string; status: RestaurantStatus };

export const loyaltyUnavailable = () =>
  new ConflictException({ code: CODES.LOYALTY_UNAVAILABLE, message: 'This restaurant has no loyalty program right now.' });
export const passInvalid = () =>
  new ForbiddenException({ code: CODES.LOYALTY_PASS_INVALID, message: 'This member card is no longer valid. Ask the restaurant for a new one.' });
export const rewardIneligible = (reason: LoyaltyIneligibleReason) =>
  new ConflictException({ code: CODES.LOYALTY_REWARD_INELIGIBLE, message: 'This reward cannot be used on this order.', details: { reason } });

/** A running program: its rules and tiers (tiers only while switched on). */
export type Program = { settings: LoyaltySettings; tiers: LoyaltyTier[] };

/** What checkout decided before the order is written (prepareCheckout), applied in its transaction (applyCheckout). */
export type CheckoutPlan = {
  restaurantId: string;
  /** An existing member (by card, or by phone), or one to create from the phone. */
  member: { id: string } | { create: { phone: string; name: string } };
  reward: { id: string; name: string; pointsCost: number } | null;
  discountPiastres: number;
  pointsToEarn: number;
};

/**
 * The heart of loyalty: whether a restaurant's program runs, members and their cards, and the
 * ledger. Every change to a balance goes through `post`, which moves the balance and writes the
 * transaction together. Orders call `prepareCheckout`/`applyCheckout` when placed and `syncOrder`
 * after any change to their status or payment.
 */
@Injectable()
export class LoyaltyCore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    readonly passes: LoyaltyPasses,
  ) {}

  async settings(restaurantId: string, db: Tx = this.prisma): Promise<LoyaltySettings> {
    return settingsFrom(await db.loyaltySettings.findUnique({ where: { restaurantId } }));
  }

  /** The service is on (with ordering), the plan has ordering, and the owner switched the program on. */
  async serviceWorks(restaurant: Restaurant, now = new Date()): Promise<boolean> {
    const [access, states] = await Promise.all([this.subscriptions.accessFor(restaurant, now), readServiceStates(this.prisma, restaurant.id)]);
    return hasAccess(access) && access.features.ordering && serviceWorks('LOYALTY', states);
  }

  /** The running program, or null when diners cannot use it. */
  async program(restaurant: Restaurant, now = new Date()): Promise<Program | null> {
    const settings = await this.settings(restaurant.id);
    if (!settings.enabled || !(await this.serviceWorks(restaurant, now))) return null;
    const tiers = settings.tiersEnabled ? await this.prisma.loyaltyTier.findMany({ where: { restaurantId: restaurant.id }, orderBy: { minLifetimePoints: 'asc' } }) : [];
    return { settings, tiers };
  }

  /** The member a card belongs to, at this restaurant only; null for a forged, replaced or foreign card. */
  async memberByPass(restaurantId: string, pass: string | undefined): Promise<LoyaltyMember | null> {
    const claim = pass ? this.passes.verify(pass) : null;
    if (!claim) return null;
    const member = await this.prisma.loyaltyMember.findFirst({ where: { id: claim.memberId, restaurantId } });
    return member && member.passVersion === claim.version ? member : null;
  }

  passFor(member: Pick<LoyaltyMember, 'id' | 'passVersion'>): string {
    return this.passes.issue(member.id, member.passVersion);
  }

  /** Times the member redeemed each reward on orders that kept it. */
  async redeemedCounts(memberId: string, db: Tx = this.prisma): Promise<Map<string, number>> {
    const rows = await db.order.groupBy({ by: ['loyaltyRewardId'], where: { loyaltyMemberId: memberId, loyaltySpentHeld: true, loyaltyRewardId: { not: null } }, _count: { _all: true } });
    return new Map(rows.map((row) => [row.loyaltyRewardId!, row._count._all]));
  }

  multiplierFor(program: Program, lifetimePoints: number): number {
    return program.settings.tiersEnabled ? (tierFor(program.tiers, lifetimePoints)?.earnMultiplier ?? 100) : 100;
  }

  // --- Checkout ------------------------------------------------------------------

  /**
   * Who the order counts for and what its reward gives, checked on the server. The card decides
   * the member when valid; otherwise the phone does (earning only). A reward needs a valid card.
   * Returns null when the order is not part of the program.
   */
  async prepareCheckout(
    restaurant: Restaurant,
    input: { type: OrderType; phone: string | null; name: string; pass?: string; rewardId?: string; lines: RewardLine[] },
    now = new Date(),
  ): Promise<CheckoutPlan | null> {
    const program = await this.program(restaurant, now);
    if (!program) {
      if (input.rewardId) throw loyaltyUnavailable();
      return null;
    }
    if (!program.settings.orderTypes.includes(input.type)) {
      if (input.rewardId) throw rewardIneligible('ORDER_TYPE');
      return null;
    }
    const carded = await this.memberByPass(restaurant.id, input.pass);
    if (input.rewardId && !carded) throw passInvalid();
    const member = carded ?? (input.phone ? await this.prisma.loyaltyMember.findUnique({ where: { restaurantId_phone: { restaurantId: restaurant.id, phone: input.phone } } }) : null);
    if (!member && !input.phone) return null;

    const subtotal = input.lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
    let reward: CheckoutPlan['reward'] = null;
    let discountPiastres = 0;
    if (input.rewardId) {
      const row = await this.prisma.loyaltyReward.findFirst({ where: { id: input.rewardId, restaurantId: restaurant.id } });
      if (!row) throw rewardIneligible('INACTIVE');
      const result = evaluateReward(row, {
        settings: program.settings,
        tiers: program.tiers,
        balance: carded!.balance,
        lifetimePoints: carded!.lifetimePoints,
        redeemedCount: (await this.redeemedCounts(carded!.id)).get(row.id) ?? 0,
        order: { type: input.type, lines: input.lines },
      });
      if (result.reason) throw rewardIneligible(result.reason);
      reward = { id: row.id, name: row.nameAr, pointsCost: row.pointsCost };
      discountPiastres = result.discountPiastres;
    }
    const pointsToEarn = pointsFor(subtotal - discountPiastres, program.settings, this.multiplierFor(program, member?.lifetimePoints ?? 0));
    if (!member && pointsToEarn === 0) return null;
    return {
      restaurantId: restaurant.id,
      member: member ? { id: member.id } : { create: { phone: input.phone!, name: input.name } },
      reward,
      discountPiastres,
      pointsToEarn,
    };
  }

  /** The checkout preview: the reward's discount, the points to earn and what the card can use. Never writes. */
  async quote(restaurant: Restaurant, input: { type: OrderType; pass?: string; rewardId?: string; lines: RewardLine[] }, now = new Date()): Promise<LoyaltyQuote> {
    const subtotal = input.lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
    const program = await this.program(restaurant, now);
    const none: LoyaltyQuote = { subtotalPiastres: subtotal, discountPiastres: 0, totalPiastres: subtotal, pointsToEarn: 0, balance: null, reward: null, rewards: [] };
    if (!program || !program.settings.orderTypes.includes(input.type)) return none;
    const member = await this.memberByPass(restaurant.id, input.pass);
    let rewards: LoyaltyQuote['rewards'] = [];
    let chosen: LoyaltyQuote['reward'] = null;
    let discount = 0;
    if (member) {
      const [rows, counts] = await Promise.all([
        this.prisma.loyaltyReward.findMany({ where: { restaurantId: restaurant.id, isActive: true } }),
        this.redeemedCounts(member.id),
      ]);
      rewards = rows.map((row) => {
        const result = evaluateReward(row, {
          settings: program.settings, tiers: program.tiers, balance: member.balance, lifetimePoints: member.lifetimePoints,
          redeemedCount: counts.get(row.id) ?? 0, order: { type: input.type, lines: input.lines },
        });
        if (row.id === input.rewardId) {
          chosen = { id: row.id, name: row.nameAr, pointsCost: row.pointsCost, available: result.reason === null, reason: result.reason };
          if (result.reason === null) discount = result.discountPiastres;
        }
        return { id: row.id, available: result.reason === null, reason: result.reason, discountPiastres: result.discountPiastres };
      });
    }
    return {
      subtotalPiastres: subtotal,
      discountPiastres: discount,
      totalPiastres: subtotal - discount,
      pointsToEarn: pointsFor(subtotal - discount, program.settings, this.multiplierFor(program, member?.lifetimePoints ?? 0)),
      balance: member?.balance ?? null,
      reward: chosen,
      rewards,
    };
  }

  /** The member for the order, created from the phone when new (and whether this order created it). */
  async resolveMember(tx: Tx, plan: CheckoutPlan): Promise<{ id: string; created: boolean }> {
    if ('id' in plan.member) return { id: plan.member.id, created: false };
    const { phone, name } = plan.member.create;
    // Two first orders with one phone at once: one creates the member, the other joins it.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO loyalty_members (id, restaurant_id, phone, name, updated_at)
      VALUES (gen_random_uuid(), ${plan.restaurantId}::uuid, ${phone}, ${name}, now())
      ON CONFLICT (restaurant_id, phone) DO NOTHING
      RETURNING id`;
    if (inserted[0]) return { id: inserted[0].id, created: true };
    const existing = await tx.loyaltyMember.findUniqueOrThrow({ where: { restaurantId_phone: { restaurantId: plan.restaurantId, phone } }, select: { id: true } });
    return { id: existing.id, created: false };
  }

  /** In the order's transaction: takes the reward's points (refusing if the balance fell meanwhile). */
  async applyCheckout(tx: Tx, plan: CheckoutPlan, member: { id: string; created: boolean }, order: { id: string; number: number }): Promise<void> {
    if (member.created) await tx.loyaltyMember.update({ where: { id: member.id }, data: { joinOrderId: order.id } });
    if (!plan.reward) return;
    const posted = await this.post(tx, member.id, plan.restaurantId, {
      kind: 'REDEEM',
      points: -plan.reward.pointsCost,
      reason: `${plan.reward.name} on order #${order.number}`,
      orderId: order.id,
      rewardId: plan.reward.id,
      activity: true,
      requireBalance: true,
    });
    if (posted === null) throw rewardIneligible('NOT_ENOUGH_POINTS');
  }

  // --- The ledger ------------------------------------------------------------------

  /** See postLoyalty. */
  post(tx: Tx, memberId: string, restaurantId: string, entry: PostEntry, now = new Date()): Promise<number | null> {
    return postLoyalty(tx, memberId, restaurantId, entry, now);
  }

  /**
   * Brings an order's points in line with its state (see loyaltyTargets): credits them once it
   * reaches the completion state, takes them back after a refund, and returns or re-takes the
   * points spent on its reward. Each switch is a compare-and-swap on the order, so a repeated or
   * concurrent call changes nothing. Call it inside the transaction that changed the order.
   */
  async syncOrder(tx: Tx, orderId: string, actor: { id: string; name: string | null } | null = null): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, restaurantId: true, number: true, status: true, paidAt: true, refundedAt: true, loyaltyMemberId: true, loyaltyRewardId: true,
        loyaltyRewardName: true, loyaltyPointsToEarn: true, loyaltyPointsSpent: true, loyaltyEarned: true, loyaltySpentHeld: true,
      },
    });
    if (!order?.loyaltyMemberId) return;
    const target = loyaltyTargets(order, await this.settings(order.restaurantId, tx));
    const why = order.status === 'CANCELLED' || order.status === 'REJECTED' ? order.status.toLowerCase() : order.refundedAt ? 'refunded' : 'completed';

    if (target.earned !== order.loyaltyEarned) {
      const { count } = await tx.order.updateMany({ where: { id: order.id, loyaltyEarned: order.loyaltyEarned }, data: { loyaltyEarned: target.earned } });
      if (count === 1) {
        await this.post(tx, order.loyaltyMemberId, order.restaurantId, target.earned
          ? { kind: 'EARN', points: order.loyaltyPointsToEarn, reason: `Order #${order.number} ${why}`, orderId: order.id, lifetime: true, activity: true, actor }
          : { kind: 'EARN_REVERSAL', points: -order.loyaltyPointsToEarn, reason: `Order #${order.number} ${why}`, orderId: order.id, lifetime: true, actor });
      }
    }
    if (target.held !== order.loyaltySpentHeld) {
      const { count } = await tx.order.updateMany({ where: { id: order.id, loyaltySpentHeld: order.loyaltySpentHeld }, data: { loyaltySpentHeld: target.held } });
      if (count === 1) {
        const reward = order.loyaltyRewardName ?? 'Reward';
        await this.post(tx, order.loyaltyMemberId, order.restaurantId, target.held
          // Paid again after a refund: the reward is in use again.
          ? { kind: 'REDEEM', points: -order.loyaltyPointsSpent, reason: `${reward} on order #${order.number} paid again`, orderId: order.id, rewardId: order.loyaltyRewardId, actor }
          : { kind: 'REDEEM_RETURN', points: order.loyaltyPointsSpent, reason: `${reward}: order #${order.number} ${why}`, orderId: order.id, rewardId: order.loyaltyRewardId, actor });
      }
    }
  }

  // --- Expiry ------------------------------------------------------------------------

  expiresAt(member: Pick<LoyaltyMember, 'balance' | 'lastActivityAt'>, settings: Pick<LoyaltySettings, 'expiryDays'>): Date | null {
    return expiresAt(member, settings);
  }

  /** Expires one member's balance if due (read paths run it first, so a balance is never shown past its expiry). */
  async expireMember(member: Pick<LoyaltyMember, 'id' | 'restaurantId' | 'balance' | 'lastActivityAt'>, settings: Pick<LoyaltySettings, 'expiryDays'>, now = new Date()): Promise<boolean> {
    const at = expiresAt(member, settings);
    if (!at || at > now) return false;
    return (await expireDue(this.prisma, now, { restaurantId: member.restaurantId, memberId: member.id })) > 0;
  }
}
