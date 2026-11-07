import { z } from 'zod';
import type { Paginated } from './admin.js';
import { ORDER_TYPES, orderLineSchema, type OrderType } from './orders.js';

/**
 * Loyalty program (docs/LOYALTY.md). Each restaurant runs its own: diners earn points on completed
 * orders, at every branch and on every order type the restaurant allows, and spend them on rewards
 * at checkout. Members are known by phone; the member card (a signed "pass" kept by the diner's
 * browser) is what lets them see their balance and redeem. Every change is a ledger transaction.
 */

export const LOYALTY_EARN_ON = ['COMPLETED', 'PAID'] as const;
export type LoyaltyEarnOn = (typeof LOYALTY_EARN_ON)[number];

export const LOYALTY_REWARD_TYPES = ['FIXED_DISCOUNT', 'PERCENT_DISCOUNT', 'FREE_PRODUCT', 'FREE_ADDON'] as const;
export type LoyaltyRewardType = (typeof LOYALTY_REWARD_TYPES)[number];

export const LOYALTY_TRANSACTION_KINDS = ['EARN', 'EARN_REVERSAL', 'REDEEM', 'REDEEM_RETURN', 'EXPIRE', 'ADJUST'] as const;
export type LoyaltyTransactionKind = (typeof LOYALTY_TRANSACTION_KINDS)[number];

export const LOYALTY_LIMITS = {
  pointsPerUnit: 1000,
  rewards: 30,
  tiers: 6,
  adjustPoints: 100_000,
  pointsCost: 1_000_000,
} as const;

export const LOYALTY_ERROR_CODES = {
  /** The program is off, the service is switched off, or the plan lacks ordering (409). */
  LOYALTY_UNAVAILABLE: 'LOYALTY_UNAVAILABLE',
  /** The member card is unknown, forged or was replaced (401-like; sent as 403). */
  LOYALTY_PASS_INVALID: 'LOYALTY_PASS_INVALID',
  /** Joining with a phone that already has a membership (409): the card comes from the restaurant. */
  LOYALTY_MEMBER_EXISTS: 'LOYALTY_MEMBER_EXISTS',
  LOYALTY_MEMBER_NOT_FOUND: 'LOYALTY_MEMBER_NOT_FOUND',
  LOYALTY_REWARD_NOT_FOUND: 'LOYALTY_REWARD_NOT_FOUND',
  /** The reward cannot be applied to this order (409; details.reason is a LoyaltyIneligibleReason). */
  LOYALTY_REWARD_INELIGIBLE: 'LOYALTY_REWARD_INELIGIBLE',
  /** An adjustment would take the balance below zero (409). */
  LOYALTY_BALANCE_TOO_LOW: 'LOYALTY_BALANCE_TOO_LOW',
  /** Two tiers with the same threshold, a free-item reward without its dish... (400). */
  LOYALTY_INVALID: 'LOYALTY_INVALID',
} as const;

/** Why a reward cannot be used on an order. */
export const LOYALTY_INELIGIBLE_REASONS = [
  'NOT_ENOUGH_POINTS',
  'BELOW_MIN_REDEEM',
  'BELOW_MIN_ORDER',
  'ITEM_NOT_IN_ORDER',
  'ADDON_NEEDS_ORDER',
  'LIMIT_REACHED',
  'TIER_REQUIRED',
  'ORDER_TYPE',
  'INACTIVE',
] as const;
export type LoyaltyIneligibleReason = (typeof LOYALTY_INELIGIBLE_REASONS)[number];

// --- Rules ------------------------------------------------------------------------

const optionalName = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable()).optional();

export const loyaltySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  nameAr: optionalName(40).transform((value) => value ?? null),
  nameEn: optionalName(40).transform((value) => value ?? null),
  pointsPerUnit: z.number().int().min(1).max(LOYALTY_LIMITS.pointsPerUnit),
  /** In piastres: 100 (1 EGP) to 100,000 EGP. */
  spendUnitPiastres: z.number().int().min(100).max(10_000_000),
  earnOn: z.enum(LOYALTY_EARN_ON),
  orderTypes: z.array(z.enum(ORDER_TYPES)).min(1).max(ORDER_TYPES.length),
  minOrderPiastres: z.number().int().min(0).max(10_000_000),
  minRedeemPoints: z.number().int().min(0).max(LOYALTY_LIMITS.pointsCost),
  maxDiscountPercent: z.number().int().min(1).max(100),
  expiryDays: z.number().int().min(7).max(3650).nullable(),
  cancelReturnsRedeemed: z.boolean(),
  refundReversesEarned: z.boolean(),
  refundReturnsRedeemed: z.boolean(),
  tiersEnabled: z.boolean(),
});
export type LoyaltySettingsInput = z.input<typeof loyaltySettingsSchema>;
export type LoyaltySettings = z.output<typeof loyaltySettingsSchema> & { updatedAt: string | null };

/** What a restaurant starts with (the program off). */
export const DEFAULT_LOYALTY_SETTINGS: Omit<LoyaltySettings, 'updatedAt'> = {
  enabled: false,
  nameAr: null,
  nameEn: null,
  pointsPerUnit: 1,
  spendUnitPiastres: 1000,
  earnOn: 'COMPLETED',
  orderTypes: [...ORDER_TYPES],
  minOrderPiastres: 0,
  minRedeemPoints: 0,
  maxDiscountPercent: 100,
  expiryDays: null,
  cancelReturnsRedeemed: true,
  refundReversesEarned: true,
  refundReturnsRedeemed: true,
  tiersEnabled: false,
};

export const loyaltyTierSchema = z.strictObject({
  id: z.uuid().optional(),
  nameAr: z.string().trim().min(1).max(30),
  nameEn: optionalName(30),
  minLifetimePoints: z.number().int().min(0).max(100_000_000),
  /** 100 = normal rate; up to five times. */
  earnMultiplier: z.number().int().min(100).max(500),
});
/** PUT /v1/loyalty/tiers replaces the whole list. */
export const loyaltyTiersSchema = z.strictObject({ tiers: z.array(loyaltyTierSchema).max(LOYALTY_LIMITS.tiers) });
export type LoyaltyTier = { id: string; nameAr: string; nameEn: string | null; minLifetimePoints: number; earnMultiplier: number };

export const loyaltyRewardSchema = z
  .strictObject({
    type: z.enum(LOYALTY_REWARD_TYPES),
    nameAr: z.string().trim().min(1).max(80),
    nameEn: optionalName(80),
    pointsCost: z.number().int().min(1).max(LOYALTY_LIMITS.pointsCost),
    amountPiastres: z.number().int().min(1).max(10_000_000).nullable().optional(),
    percent: z.number().int().min(1).max(100).nullable().optional(),
    maxDiscountPiastres: z.number().int().min(1).max(10_000_000).nullable().optional(),
    menuItemId: z.uuid().nullable().optional(),
    variantId: z.uuid().nullable().optional(),
    minOrderPiastres: z.number().int().min(0).max(10_000_000).default(0),
    maxPerMember: z.number().int().min(1).max(1000).nullable().optional(),
    tierId: z.uuid().nullable().optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .superRefine((reward, context) => {
    if (reward.type === 'FIXED_DISCOUNT' && !reward.amountPiastres) context.addIssue({ code: 'custom', path: ['amountPiastres'], message: 'Enter the amount off.' });
    if (reward.type === 'PERCENT_DISCOUNT' && !reward.percent) context.addIssue({ code: 'custom', path: ['percent'], message: 'Enter the percentage off.' });
    if ((reward.type === 'FREE_PRODUCT' || reward.type === 'FREE_ADDON') && !reward.menuItemId) {
      context.addIssue({ code: 'custom', path: ['menuItemId'], message: 'Choose the free dish.' });
    }
  });
export type LoyaltyRewardInput = z.input<typeof loyaltyRewardSchema>;

/** A reward as the restaurant manages it. */
export type LoyaltyReward = {
  id: string;
  type: LoyaltyRewardType;
  nameAr: string;
  nameEn: string | null;
  pointsCost: number;
  amountPiastres: number | null;
  percent: number | null;
  maxDiscountPiastres: number | null;
  menuItemId: string | null;
  variantId: string | null;
  /** The free dish's names, while it exists. */
  menuItem: { id: string; nameAr: string; nameEn: string | null; variantNameAr: string | null; variantNameEn: string | null } | null;
  minOrderPiastres: number;
  maxPerMember: number | null;
  tierId: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Times redeemed (orders that kept it). */
  redemptions: number;
};

// --- Pure rules (shared by the API, the checkout preview and tests) -----------------

/** Points an amount earns: whole spend units times the rate, times the tier multiplier (rounded down). */
export function pointsFor(amountPiastres: number, rules: { pointsPerUnit: number; spendUnitPiastres: number; minOrderPiastres: number }, multiplier = 100): number {
  if (amountPiastres <= 0 || amountPiastres < rules.minOrderPiastres) return 0;
  const base = Math.floor(amountPiastres / rules.spendUnitPiastres) * rules.pointsPerUnit;
  return Math.floor((base * multiplier) / 100);
}

/** The highest tier the lifetime points reach (tiers sorted or not); null below the first. */
export function tierFor<T extends { minLifetimePoints: number }>(tiers: readonly T[], lifetimePoints: number): T | null {
  let best: T | null = null;
  for (const tier of tiers) if (lifetimePoints >= tier.minLifetimePoints && (!best || tier.minLifetimePoints > best.minLifetimePoints)) best = tier;
  return best;
}

export type RewardLine = { menuItemId: string; variantId: string; unitPricePiastres: number; quantity: number };

/**
 * The discount a reward gives on a subtotal: a fixed amount, a share (capped), or one unit of the
 * free dish (the cheapest matching line). Never more than the subtotal or the program's cap.
 */
export function rewardDiscount(
  reward: Pick<LoyaltyReward, 'type' | 'amountPiastres' | 'percent' | 'maxDiscountPiastres' | 'menuItemId' | 'variantId'>,
  lines: readonly RewardLine[],
  maxDiscountPercent = 100,
): number {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
  let discount = 0;
  if (reward.type === 'FIXED_DISCOUNT') discount = reward.amountPiastres ?? 0;
  else if (reward.type === 'PERCENT_DISCOUNT') {
    discount = Math.floor((subtotal * (reward.percent ?? 0)) / 100);
    if (reward.maxDiscountPiastres) discount = Math.min(discount, reward.maxDiscountPiastres);
  } else {
    const matching = lines.filter((line) => line.menuItemId === reward.menuItemId && (!reward.variantId || line.variantId === reward.variantId));
    discount = matching.length ? Math.min(...matching.map((line) => line.unitPricePiastres)) : 0;
  }
  const cap = Math.floor((subtotal * maxDiscountPercent) / 100);
  return Math.max(0, Math.min(discount, subtotal, cap));
}

// --- Diners ---------------------------------------------------------------------------

/** The member card: a signed token kept by the diner's browser. */
export const loyaltyPassSchema = z.string().trim().min(10).max(200);

/** GET /v1/public/restaurants/:subdomain/loyalty: the program as diners see it ({ enabled: false } when off). */
export type PublicLoyaltyProgram =
  | { enabled: false }
  | {
    enabled: true;
    nameAr: string | null;
    nameEn: string | null;
    pointsPerUnit: number;
    spendUnitPiastres: number;
    earnOn: LoyaltyEarnOn;
    orderTypes: OrderType[];
    minOrderPiastres: number;
    minRedeemPoints: number;
    maxDiscountPercent: number;
    expiryDays: number | null;
    tiers: LoyaltyTier[];
    rewards: PublicLoyaltyReward[];
  };

export type PublicLoyaltyReward = Pick<LoyaltyReward, 'id' | 'type' | 'nameAr' | 'nameEn' | 'pointsCost' | 'amountPiastres' | 'percent' | 'maxDiscountPiastres' | 'menuItemId' | 'variantId' | 'menuItem' | 'minOrderPiastres' | 'tierId'>;

export const loyaltyMeSchema = z.strictObject({ pass: loyaltyPassSchema });

export const loyaltyJoinSchema = z.strictObject({
  name: z.string().trim().min(2).max(60),
  phone: z.string().trim().transform((value) => value.replace(/[\s().-]/g, '')).pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.')),
});

export type LoyaltyJoinResponse = { pass: string; member: LoyaltyMemberCard };

export type LoyaltyTransaction = {
  id: string;
  kind: LoyaltyTransactionKind;
  points: number;
  balanceAfter: number;
  reason: string;
  /** The order's number and day, when it came from one. */
  order: { id: string; number: number; placedAt: string; branchName: string } | null;
  rewardName: string | null;
  actorName: string | null;
  createdAt: string;
};

/** What a member sees with their card (and the restaurant sees on the member's page). */
export type LoyaltyMemberCard = {
  id: string;
  name: string;
  /** Masked for diners ("•••• 4567"); in full for staff. */
  phone: string;
  balance: number;
  lifetimePoints: number;
  tier: LoyaltyTier | null;
  nextTier: (LoyaltyTier & { pointsToGo: number }) | null;
  /** When the balance expires without activity; null when points never expire or there are none. */
  expiresAt: string | null;
  joinedAt: string;
};

/** POST /v1/public/restaurants/:subdomain/loyalty/me */
export type LoyaltyMemberView = {
  member: LoyaltyMemberCard;
  rewards: (PublicLoyaltyReward & { available: boolean; reason: LoyaltyIneligibleReason | null; redeemedCount: number })[];
  history: LoyaltyTransaction[];
  /** Points from orders still on their way (credited once completed). */
  pendingPoints: number;
};

/** POST /v1/public/restaurants/:subdomain/orders/quote: what checkout shows before ordering. */
export const loyaltyQuoteSchema = z.strictObject({
  type: z.enum(ORDER_TYPES),
  tableCode: z.string().trim().min(4).max(16).optional(),
  branch: z.string().trim().toLowerCase().max(40).optional(),
  items: z.array(orderLineSchema).min(1).max(50),
  pass: loyaltyPassSchema.optional(),
  rewardId: z.uuid().optional(),
});

export type LoyaltyQuote = {
  subtotalPiastres: number;
  discountPiastres: number;
  totalPiastres: number;
  /** Points the order will earn once completed (0 without a phone or below the minimum). */
  pointsToEarn: number;
  /** Only with a valid card. */
  balance: number | null;
  reward: { id: string; name: string; pointsCost: number; available: boolean; reason: LoyaltyIneligibleReason | null } | null;
  /** The rewards the card could use on this order, for the picker. */
  rewards: { id: string; available: boolean; reason: LoyaltyIneligibleReason | null; discountPiastres: number }[];
};

/** On a placed order and its tracking page. */
export type OrderLoyalty = {
  pointsToEarn: number;
  /** True once credited. */
  earned: boolean;
  pointsSpent: number;
  rewardName: string | null;
  discountPiastres: number;
};

// --- Restaurant ---------------------------------------------------------------------

export const loyaltyMembersQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
  sort: z.enum(['recent', 'balance', 'lifetime', 'joined']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type LoyaltyMemberListItem = {
  id: string;
  name: string;
  phone: string;
  balance: number;
  lifetimePoints: number;
  tierName: string | null;
  orders: number;
  lastActivityAt: string;
  joinedAt: string;
};
export type LoyaltyMembersPage = Paginated<LoyaltyMemberListItem>;

export type LoyaltyMemberDetail = {
  member: LoyaltyMemberCard;
  orders: number;
  spentPiastres: number;
  history: LoyaltyTransaction[];
};

export const loyaltyAdjustSchema = z.strictObject({
  /** Signed: positive adds points. */
  points: z.number().int().min(-LOYALTY_LIMITS.adjustPoints).max(LOYALTY_LIMITS.adjustPoints).refine((value) => value !== 0, 'Enter the points to add or remove.'),
  reason: z.string().trim().min(3).max(200),
});

/** POST /v1/loyalty/members/:id/card: a new member card (every older one stops working). */
export type LoyaltyCardLink = { pass: string; url: string };

export const loyaltyAnalyticsQuerySchema = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });

export type LoyaltyAnalytics = {
  days: number;
  members: number;
  newMembers: number;
  /** Members who earned or redeemed in the period. */
  activeMembers: number;
  pointsIssued: number;
  pointsRedeemed: number;
  pointsExpired: number;
  /** Points members hold now (what the program owes). */
  outstandingPoints: number;
  /** Points redeemed / points issued over the period. */
  redemptionRate: number | null;
  /** Customers (by phone) with two or more orders, out of those who ordered in the period. */
  repeatCustomerRate: number | null;
  customers: number;
  returningCustomers: number;
  /** Bills (after discounts) of completed orders from customers who had ordered before. */
  returningRevenuePiastres: number;
  revenuePiastres: number;
  discountPiastres: number;
  rewardsRedeemed: number;
  topRewards: { id: string | null; name: string; redemptions: number; discountPiastres: number }[];
  /** One point per day: points issued and redeemed. */
  daily: { day: string; issued: number; redeemed: number }[];
};

export const LOYALTY_REWARD_LABELS: Record<LoyaltyRewardType, [string, string]> = {
  FIXED_DISCOUNT: ['خصم بمبلغ ثابت', 'Fixed discount'],
  PERCENT_DISCOUNT: ['خصم بنسبة', 'Percentage discount'],
  FREE_PRODUCT: ['صنف مجاني', 'Free product'],
  FREE_ADDON: ['إضافة مجانية', 'Free add-on'],
};

export const LOYALTY_TRANSACTION_LABELS: Record<LoyaltyTransactionKind, [string, string]> = {
  EARN: ['نقاط من طلب', 'Earned'],
  EARN_REVERSAL: ['إلغاء نقاط طلب مسترد', 'Reversed'],
  REDEEM: ['استبدال مكافأة', 'Redeemed'],
  REDEEM_RETURN: ['رجوع نقاط مكافأة', 'Returned'],
  EXPIRE: ['انتهاء صلاحية', 'Expired'],
  ADJUST: ['تعديل يدوي', 'Adjustment'],
};
