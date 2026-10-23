import { z } from 'zod';
import { STATS_PERIODS, VISIT_SOURCES } from './analytics.js';

/** POST /v1/public/restaurants/:subdomain/visits, sent once per page load by the menu. */
export const recordVisitSchema = z.strictObject({ source: z.enum(VISIT_SOURCES).default('link') });

export const statsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((days) => (STATS_PERIODS as readonly number[]).includes(days), { message: `Use one of ${STATS_PERIODS.join(', ')}.` })
    .default(30),
});
