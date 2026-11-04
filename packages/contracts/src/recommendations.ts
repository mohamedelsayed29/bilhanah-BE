import { z } from 'zod';

/**
 * Upselling and cross-selling: the restaurant pairs a dish with others (bought together,
 * add-ons, an upgrade, alternatives) and chooses where diners see them (the dish page, the
 * cart, checkout). Only dishes orderable at the diner's branch are shown, so a rule never
 * stands in the way of an order.
 */
export const RECOMMENDATION_TYPES = ['FREQUENTLY_BOUGHT_TOGETHER', 'ADD_ON', 'UPGRADE', 'ALTERNATIVE'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_PLACEMENTS = ['PRODUCT_DETAILS', 'CART', 'CHECKOUT'] as const;
export type RecommendationPlacement = (typeof RECOMMENDATION_PLACEMENTS)[number];

export const RECOMMENDATION_EVENT_KINDS = ['IMPRESSION', 'CLICK', 'ADD'] as const;
export type RecommendationEventKind = (typeof RECOMMENDATION_EVENT_KINDS)[number];

export const RECOMMENDATION_LIMITS = { rules: 200, itemsPerRule: 8, maxQuantity: 10, title: 60, eventsPerBatch: 50 } as const;

export const RECOMMENDATION_ERROR_CODES = {
  RECOMMENDATION_NOT_FOUND: 'RECOMMENDATION_NOT_FOUND',
  /** A source or suggested dish (or size) is not on this restaurant's menu. details: { menuItemIds } */
  RECOMMENDATION_ITEMS_INVALID: 'RECOMMENDATION_ITEMS_INVALID',
  RECOMMENDATION_LIMIT_REACHED: 'RECOMMENDATION_LIMIT_REACHED',
} as const;

const ruleItemSchema = z.strictObject({
  itemId: z.uuid(),
  /** A fixed size; null lets the diner pick (or uses a dish's only price). */
  variantId: z.uuid().nullable().default(null),
  maxQuantity: z.number().int().min(1).max(RECOMMENDATION_LIMITS.maxQuantity).default(1),
});

const ruleFields = {
  type: z.enum(RECOMMENDATION_TYPES),
  placements: z.array(z.enum(RECOMMENDATION_PLACEMENTS)).min(1).max(RECOMMENDATION_PLACEMENTS.length).transform((list) => [...new Set(list)]),
  title: z.string().trim().max(RECOMMENDATION_LIMITS.title).transform((value) => (value === '' ? null : value)).nullable().optional(),
  required: z.boolean().optional(),
  isActive: z.boolean().optional(),
  items: z.array(ruleItemSchema).min(1).max(RECOMMENDATION_LIMITS.itemsPerRule),
};

/** Required add-ons only make sense on the dish page, where the diner picks them with the dish. */
const requiredFits = (rule: { type?: RecommendationType; placements?: RecommendationPlacement[]; required?: boolean }) =>
  !rule.required || (rule.type === 'ADD_ON' && !!rule.placements?.includes('PRODUCT_DETAILS'));
const requiredMessage = { message: 'Only add-ons shown on the dish page can be required.', path: ['required'] };

/** POST /v1/recommendations (owners). */
export const createRecommendationSchema = z.strictObject({ sourceItemId: z.uuid(), ...ruleFields }).refine(requiredFits, requiredMessage);

/** PATCH /v1/recommendations/:id: any field; `items` replaces the list. */
export const updateRecommendationSchema = z
  .strictObject({ sourceItemId: z.uuid().optional(), ...Object.fromEntries(Object.entries(ruleFields).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof typeof ruleFields]: z.ZodOptional<(typeof ruleFields)[K]>;
  } })
  .refine(requiredFits, requiredMessage);

export type RecommendationRuleItem = { itemId: string; variantId: string | null; maxQuantity: number };

export type RecommendationRule = {
  id: string;
  sourceItemId: string;
  type: RecommendationType;
  placements: RecommendationPlacement[];
  title: string | null;
  required: boolean;
  isActive: boolean;
  items: RecommendationRuleItem[];
  createdAt: string;
};

/**
 * In the public menu: the active rules whose source and suggestions are orderable at the branch
 * shown, with the suggestions that are. Prices come from the menu's own items.
 */
export type PublicRecommendation = Omit<RecommendationRule, 'isActive' | 'createdAt'>;

/** POST /v1/public/restaurants/:subdomain/recommendation-events: what a diner saw, opened and added. */
export const recommendationEventsSchema = z.strictObject({
  branch: z.string().max(60).optional(),
  events: z.array(z.strictObject({
    ruleId: z.uuid(),
    itemId: z.uuid(),
    kind: z.enum(RECOMMENDATION_EVENT_KINDS),
    placement: z.enum(RECOMMENDATION_PLACEMENTS),
  })).min(1).max(RECOMMENDATION_LIMITS.eventsPerBatch),
});

/** On an order line: the suggestion it was added from. Ignored when it does not match an active rule. */
export const orderLineRecommendationSchema = z.strictObject({ ruleId: z.uuid(), placement: z.enum(RECOMMENDATION_PLACEMENTS) });

export const recommendationStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  branchId: z.uuid().optional(),
});

export type RecommendationFunnel = {
  impressions: number;
  clicks: number;
  adds: number;
  /** Order lines bought from the suggestion, in orders that were not rejected or cancelled. */
  purchases: number;
  revenuePiastres: number;
};

/**
 * GET /v1/recommendations/stats: the funnel over the last `days`, the conversion rate
 * (purchases / impressions), revenue from suggestions, and the average order value of orders
 * with and without a suggested dish.
 */
export type RecommendationStats = RecommendationFunnel & {
  days: number;
  conversionRate: number | null;
  averageOrderPiastres: number | null;
  averageOrderWithPiastres: number | null;
  averageOrderWithoutPiastres: number | null;
  rules: (RecommendationFunnel & { ruleId: string; conversionRate: number | null })[];
};
