import {
  type MenuItemRating,
  type RatingDistribution,
  REVIEW_SUB_RATINGS,
  type ReviewDishRow,
  type ReviewFollowUpStatus,
  type ReviewStats,
  type ReviewSubRating,
  type ReviewTag,
  UNHAPPY_MAX_STARS,
} from '@bilhanah/contracts';

// Stats arithmetic for docs/REVIEWS.md, free of I/O. Averages are rounded to 2 decimals (menu
// badges to 1), shares to 4.

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

export function average(values: readonly number[], decimals = 2): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, decimals) : null;
}

export function share(part: number, whole: number): number | null {
  return whole ? round(part / whole, 4) : null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function distribution(values: readonly number[]): RatingDistribution {
  const counts: RatingDistribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const value of values) {
    const key = String(value) as keyof RatingDistribution;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

/** The restaurant's local date of an instant, YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The last `days` local days ending today, oldest first. */
export function lastDays(days: number, now: Date, timeZone: string): string[] {
  const today = localDay(now, timeZone);
  const base = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: days }, (_, index) => new Date(base - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

export type StatsRow = {
  overall: number;
  ratings: Partial<Record<ReviewSubRating, number>>;
  tags: readonly string[];
  verified: boolean;
  followUpStatus: ReviewFollowUpStatus | null;
  createdAt: Date;
  repliedAt: Date | null;
};

type ComputedStats = Omit<ReviewStats, 'dishRanking' | 'pending' | 'openFollowUps'>;

/** Everything in ReviewStats that comes from the period's reviews themselves. */
export function computeStats(rows: readonly StatsRow[], options: { days: number; now: Date; timeZone: string; tags: readonly ReviewTag[] }): ComputedStats {
  const overall = rows.map((row) => row.overall);
  const byDay = new Map<string, number[]>();
  for (const row of rows) {
    const day = localDay(row.createdAt, options.timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), row.overall]);
  }
  const subRatings: ComputedStats['subRatings'] = {};
  for (const key of REVIEW_SUB_RATINGS) {
    const values = rows.flatMap((row) => (row.ratings[key] === undefined ? [] : [row.ratings[key]]));
    if (values.length) subRatings[key] = { average: average(values)!, count: values.length };
  }
  const tagCounts = new Map<string, number>();
  for (const row of rows) for (const tag of new Set(row.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = [...tagCounts]
    .map(([code, count]) => ({ ...(options.tags.find((tag) => tag.code === code) ?? { code, nameAr: code, nameEn: null, sentiment: 'POSITIVE' as const }), count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const replied = rows.filter((row) => row.repliedAt);
  const unhappy = rows.filter((row) => row.overall <= UNHAPPY_MAX_STARS);
  const followedUp = unhappy.filter((row) => row.followUpStatus === 'CONTACTED' || row.followUpStatus === 'RESOLVED');
  return {
    days: options.days,
    count: rows.length,
    average: average(overall),
    distribution: distribution(overall),
    series: lastDays(options.days, options.now, options.timeZone).map((day) => {
      const values = byDay.get(day) ?? [];
      return { day, count: values.length, average: average(values) };
    }),
    subRatings,
    tags,
    replyRate: share(replied.length, rows.length),
    medianReplyMinutes: (() => {
      const minutes = median(replied.map((row) => (row.repliedAt!.getTime() - row.createdAt.getTime()) / 60_000));
      return minutes === null ? null : round(minutes, 1);
    })(),
    unhappy: unhappy.length,
    unhappyFollowedUpShare: share(followedUp.length, unhappy.length),
    verifiedShare: share(rows.filter((row) => row.verified).length, rows.length),
  };
}

export type DishRatingRow = { menuItemId: string | null; nameAr: string; nameEn: string | null; rating: number };

/** Per dish (the menu item, or its name once the item is gone): average, count, up and down shares; best first. */
export function dishRows(ratings: readonly DishRatingRow[], minCount = 1): ReviewDishRow[] {
  const groups = new Map<string, { first: DishRatingRow; values: number[] }>();
  for (const row of ratings) {
    const key = row.menuItemId ?? `name:${row.nameAr}`;
    const group = groups.get(key);
    if (group) group.values.push(row.rating);
    else groups.set(key, { first: row, values: [row.rating] });
  }
  return [...groups.values()]
    .filter((group) => group.values.length >= minCount)
    .map(({ first, values }) => ({
      menuItemId: first.menuItemId,
      nameAr: first.nameAr,
      nameEn: first.nameEn,
      average: average(values)!,
      count: values.length,
      upShare: share(values.filter((value) => value >= 4).length, values.length)!,
      downShare: share(values.filter((value) => value <= 2).length, values.length)!,
    }))
    .sort((a, b) => b.average - a.average || b.count - a.count || a.nameAr.localeCompare(b.nameAr));
}

/** A dish's badge on the public menu from its published ratings; null below minCount. */
export function menuRating(aggregate: { count: number; sum: number; positive: number }, minCount: number): MenuItemRating | null {
  if (aggregate.count < Math.max(1, minCount)) return null;
  return { average: round(aggregate.sum / aggregate.count, 1), count: aggregate.count, positiveShare: round(aggregate.positive / aggregate.count, 4) };
}

/** One CSV cell: quoted when needed; cells that a spreadsheet would run as a formula are prefixed with '. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A UTF-8 CSV with a byte-order mark, so spreadsheet apps read Arabic correctly. */
export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
