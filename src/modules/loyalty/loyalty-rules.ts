import {
  DEFAULT_LOYALTY_SETTINGS,
  type LoyaltyIneligibleReason,
  type LoyaltySettings,
  type OrderStatus,
  type OrderType,
  type RewardLine,
  rewardDiscount,
  tierFor,
} from '@bilhanah/contracts';
import type { LoyaltyReward as RewardRow, LoyaltySettings as SettingsRow, LoyaltyTier as TierRow } from '@bilhanah/database';

/** The restaurant's rules; the defaults (program off) until it saves some. */
export function settingsFrom(row: SettingsRow | null): LoyaltySettings {
  if (!row) return { ...DEFAULT_LOYALTY_SETTINGS, updatedAt: null };
  return {
    enabled: row.enabled,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    pointsPerUnit: row.pointsPerUnit,
    spendUnitPiastres: row.spendUnitPiastres,
    earnOn: row.earnOn,
    orderTypes: row.orderTypes,
    minOrderPiastres: row.minOrderPiastres,
    minRedeemPoints: row.minRedeemPoints,
    maxDiscountPercent: row.maxDiscountPercent,
    expiryDays: row.expiryDays,
    cancelReturnsRedeemed: row.cancelReturnsRedeemed,
    refundReversesEarned: row.refundReversesEarned,
    refundReturnsRedeemed: row.refundReturnsRedeemed,
    tiersEnabled: row.tiersEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type RewardContext = {
  settings: Pick<LoyaltySettings, 'minRedeemPoints' | 'maxDiscountPercent' | 'orderTypes' | 'tiersEnabled'>;
  tiers: readonly Pick<TierRow, 'id' | 'minLifetimePoints'>[];
  balance: number;
  lifetimePoints: number;
  /** Times the member already redeemed this reward (orders that kept it). */
  redeemedCount: number;
  /** Without an order (the member's page): only the points, limits and tier are checked. */
  order?: { type: OrderType; lines: readonly RewardLine[] };
};

/** Whether a member may use a reward (on an order, when given), why not, and the discount it gives. */
export function evaluateReward(
  reward: Pick<RewardRow, 'type' | 'isActive' | 'pointsCost' | 'amountPiastres' | 'percent' | 'maxDiscountPiastres' | 'menuItemId' | 'variantId' | 'minOrderPiastres' | 'maxPerMember' | 'tierId'>,
  context: RewardContext,
): { reason: LoyaltyIneligibleReason | null; discountPiastres: number } {
  const no = (reason: LoyaltyIneligibleReason) => ({ reason, discountPiastres: 0 });
  const free = reward.type === 'FREE_PRODUCT' || reward.type === 'FREE_ADDON';
  if (!reward.isActive || (free && !reward.menuItemId)) return no('INACTIVE');
  if (reward.tierId && context.settings.tiersEnabled) {
    const needed = context.tiers.find((tier) => tier.id === reward.tierId);
    const reached = tierFor(context.tiers, context.lifetimePoints);
    if (needed && (!reached || reached.minLifetimePoints < needed.minLifetimePoints)) return no('TIER_REQUIRED');
  }
  if (reward.maxPerMember !== null && context.redeemedCount >= reward.maxPerMember) return no('LIMIT_REACHED');
  if (context.balance < context.settings.minRedeemPoints) return no('BELOW_MIN_REDEEM');
  if (context.balance < reward.pointsCost) return no('NOT_ENOUGH_POINTS');
  if (!context.order) return { reason: null, discountPiastres: 0 };

  const { lines, type } = context.order;
  if (!context.settings.orderTypes.includes(type)) return no('ORDER_TYPE');
  const subtotal = lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
  if (subtotal < reward.minOrderPiastres) return no('BELOW_MIN_ORDER');
  if (free) {
    const matches = (line: RewardLine) => line.menuItemId === reward.menuItemId && (!reward.variantId || line.variantId === reward.variantId);
    if (!lines.some(matches)) return no('ITEM_NOT_IN_ORDER');
    // An add-on comes with something else: the order needs a paid dish besides it.
    if (reward.type === 'FREE_ADDON') {
      const others = lines.reduce((count, line) => count + (matches(line) ? line.quantity - 1 : line.quantity), 0);
      if (others < 1) return no('ADDON_NEEDS_ORDER');
    }
  }
  const discountPiastres = rewardDiscount(reward, lines, context.settings.maxDiscountPercent);
  if (discountPiastres <= 0) return no('BELOW_MIN_ORDER');
  return { reason: null, discountPiastres };
}

/** The loyalty state of an order, as the reconciler sees it. */
export type OrderLoyaltyState = {
  status: OrderStatus;
  paidAt: Date | null;
  refundedAt: Date | null;
  loyaltyPointsToEarn: number;
  loyaltyPointsSpent: number;
};

/**
 * Where an order's points should stand (docs/LOYALTY.md, "Reversal rules"):
 * - earned: once the order reaches the program's completion state (completed; or completed and
 *   paid), unless it was refunded and refunds reverse earned points;
 * - spent points held: unless the order was cancelled or rejected (and cancelling returns them),
 *   or refunded (and refunds return them).
 * Applying the difference is what keeps every award and reversal exactly once.
 */
export function loyaltyTargets(order: OrderLoyaltyState, settings: Pick<LoyaltySettings, 'earnOn' | 'cancelReturnsRedeemed' | 'refundReversesEarned' | 'refundReturnsRedeemed'>): { earned: boolean; held: boolean } {
  const refunded = order.refundedAt !== null;
  const cancelled = order.status === 'CANCELLED' || order.status === 'REJECTED';
  const keptAfterRefund = !refunded || !settings.refundReversesEarned;
  const reached = order.status === 'COMPLETED' && (settings.earnOn === 'COMPLETED' || order.paidAt !== null || refunded);
  return {
    earned: order.loyaltyPointsToEarn > 0 && reached && keptAfterRefund,
    held: order.loyaltyPointsSpent > 0 && !(cancelled && settings.cancelReturnsRedeemed) && !(refunded && settings.refundReturnsRedeemed),
  };
}

/** "•••• 4567" for diners. */
export const maskPhone = (phone: string) => `•••• ${phone.slice(-4)}`;
