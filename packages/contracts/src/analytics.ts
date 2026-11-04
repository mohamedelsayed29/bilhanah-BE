// Visits and orders over time, for owners and administrators. Free of zod, so
// the website can import it; the query schemas are in analytics-schemas.ts.

/**
 * How a diner reached the menu: qr (the restaurant's QR code, ?src=qr), table
 * (a table QR, ?t=code) or link (anything else: a shared link, social media).
 */
export const VISIT_SOURCES = ['qr', 'table', 'link'] as const;
export type VisitSource = (typeof VISIT_SOURCES)[number];

/** Periods the dashboard offers, in days. */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

export type VisitCounts = Record<VisitSource, number>;

/** One day in the restaurant's time zone (YYYY-MM-DD). Orders exclude rejected and cancelled ones. */
export type RestaurantStatsDay = {
  date: string;
  /** Menu opens, counted once per visitor and day. */
  visits: number;
  orders: number;
  revenuePiastres: number;
};

/** GET /v1/restaurants/mine/stats?days= */
export type RestaurantStats = {
  days: RestaurantStatsDay[];
  totals: { visits: number; orders: number; revenuePiastres: number; averageOrderPiastres: number };
  /** Visits in the period by how diners arrived. */
  sources: VisitCounts;
  ordersByType: { DINE_IN: number; PICKUP: number };
  /** The five dishes ordered most in the period (by quantity). */
  topItems: { nameAr: string; nameEn: string | null; quantity: number; revenuePiastres: number }[];
  /** False when the plan has no ordering: the dashboard shows visits only. */
  ordering: boolean;
  /** The branch the orders figures are for; null for the whole restaurant. Visits are always restaurant-wide. */
  branchId: string | null;
  /** False without analytics.financial: every revenue and average figure is 0 and the dashboard hides them. */
  financial: boolean;
};

export type PlatformStatsDay = {
  date: string;
  visits: number;
  orders: number;
  newRestaurants: number;
  /** Subscription payments approved that day (manual or online). */
  revenuePiastres: number;
};

/** GET /v1/admin/stats?days= (Cairo time). */
export type PlatformStats = {
  days: PlatformStatsDay[];
  totals: { visits: number; orders: number; newRestaurants: number; revenuePiastres: number; standOrders: number; standRevenuePiastres: number };
  /** The ten restaurants with the most visits in the period. */
  topRestaurants: { id: string; name: string; subdomain: string; visits: number; orders: number }[];
};
