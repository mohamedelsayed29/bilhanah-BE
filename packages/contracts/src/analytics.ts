// Visits and orders over time, for owners and administrators. Free of zod, so
// the website can import it; the query schemas are in analytics-schemas.ts.

/**
 * How a diner reached the menu: qr (the restaurant's QR code, ?src=qr), table
 * (a table QR, ?t=code) or link (anything else: a shared link, social media).
 */
import type { DataSource, MenuSource } from './services.js';
import type { ImageSet } from './media.js';

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
  /** Where the figures come from: orders placed through Bilhanah only; the menu and POS the restaurant uses. */
  dataSource: { orders: DataSource; menuSource: MenuSource; externalPosName: string | null };
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

// --- The dashboard's overview ---------------------------------------------------------

/** The overview's periods: today (hour by hour), the last 7 or 30 days (day by day). */
export const OVERVIEW_PERIODS = ['today', 'week', 'month'] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

/** A figure and the same figure over the previous period (yesterday up to this time, the 7 or 30 days before). */
export type OverviewFigure = { value: number; previous: number };

export type OverviewDish = {
  menuItemId: string | null;
  nameAr: string;
  nameEn: string | null;
  image: ImageSet | null;
};

/** GET /v1/restaurants/mine/stats/overview?period=&branchId= */
export type RestaurantOverview = {
  period: OverviewPeriod;
  /** False without analytics.financial: every amount is 0 and the dashboard hides them. */
  financial: boolean;
  branchId: string | null;
  kpis: { revenuePiastres: OverviewFigure; orders: OverviewFigure; dineIn: OverviewFigure; pickup: OverviewFigure };
  /** `hour` for today ("2026-11-07T14:00", local), `day` otherwise ("2026-11-07"). */
  bucket: 'hour' | 'day';
  sales: { at: string; orders: number; revenuePiastres: number }[];
  /** Revenue (lines, before discounts) by menu category, largest first; deleted dishes count as uncategorised (id null). */
  income: { totalPiastres: number; categories: { id: string | null; nameAr: string; nameEn: string | null; revenuePiastres: number }[] };
  /** The four dishes ordered most in the period. */
  trending: (OverviewDish & { quantity: number; revenuePiastres: number })[];
  /** Dishes sold out now: everywhere, or at the branch (`branchName`). */
  soldOut: (OverviewDish & { branchName: string | null; byInventory: boolean })[];
  soldOutTotal: number;
};
