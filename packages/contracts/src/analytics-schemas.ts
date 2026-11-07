import { z } from 'zod';
import { OVERVIEW_PERIODS, STATS_PERIODS, VISIT_SOURCES } from './analytics.js';

/** POST /v1/public/restaurants/:subdomain/visits, sent once per page load by the menu. */
export const recordVisitSchema = z.strictObject({ source: z.enum(VISIT_SOURCES).default('link') });

export const statsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((days) => (STATS_PERIODS as readonly number[]).includes(days), { message: `Use one of ${STATS_PERIODS.join(', ')}.` })
    .default(30),
  /** One branch; the whole restaurant when omitted (managers always get their branch). */
  branchId: z.uuid().optional(),
});

// --- Table analytics ------------------------------------------------------------------------------

export const TABLE_ANALYTICS_LIMITS = { rangeDays: 92 } as const;

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * GET /v1/restaurants/mine/stats/tables?from=&to=[&branchId=][&areaId=]: the tables' use and revenue over local
 * days [from, to] (both included, at most TABLE_ANALYTICS_LIMITS.rangeDays), optionally in one area ('NONE': no area).
 */
export const tableAnalyticsQuerySchema = z
  .object({
    from: localDay,
    to: localDay,
    branchId: z.uuid().optional(),
    areaId: z.union([z.uuid(), z.literal('NONE')]).optional(),
  })
  .refine((range) => range.from <= range.to, { message: '"to" must not be before "from".', path: ['to'] })
  .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 < TABLE_ANALYTICS_LIMITS.rangeDays, {
    message: `At most ${TABLE_ANALYTICS_LIMITS.rangeDays} days.`, path: ['to'],
  });

/** One table over the period. A seating is one party at it: a table session, or orders without one up to their bill. */
export type TableAnalyticsRow = {
  id: string;
  label: string;
  areaId: string | null;
  areaName: string | null;
  seats: number;
  isActive: boolean;
  seatings: number;
  /** Over seatings that ended (session closed or bill paid); null without any. */
  averageOccupancyMinutes: number | null;
  /** Seatings per day of the period. */
  turnoverRate: number;
  orders: number;
  /** Paid dine-in orders placed in the period; null without analytics.financial. */
  revenuePiastres: number | null;
  /** QR scans (once per phone per half hour). */
  scans: number;
};

export type TableAnalytics = {
  from: string;
  to: string;
  days: number;
  /** The tables' status right now (the area filter applies). */
  now: { total: number; available: number; occupied: number; reserved: number; cleaning: number; unavailable: number };
  summary: {
    seatings: number;
    averageOccupancyMinutes: number | null;
    /** Seatings per table per day. */
    turnoverRate: number | null;
    orders: number;
    revenuePiastres: number | null;
    scans: number;
    /** The first day scans were counted for this restaurant; null before any. */
    scanTrackingSince: string | null;
  };
  /** Most used first (seatings, then orders, then revenue). */
  tables: TableAnalyticsRow[];
};

export const overviewQuerySchema = z.object({
  period: z.enum(OVERVIEW_PERIODS).default('today'),
  branchId: z.uuid().optional(),
});
