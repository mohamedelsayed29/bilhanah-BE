import { DEFAULT_REVIEW_TAGS } from '@bilhanah/contracts';
import { average, computeStats, csvCell, dishRows, distribution, lastDays, localDay, median, menuRating, share, type StatsRow, toCsv } from './reviews-math.js';

const TZ = 'Africa/Cairo';
const now = new Date('2026-11-06T10:00:00Z');
const at = (iso: string) => new Date(iso);

const row = (overall: number, extra: Partial<StatsRow> = {}): StatsRow => ({
  overall, ratings: {}, tags: [], verified: true, followUpStatus: null, createdAt: at('2026-11-05T10:00:00Z'), repliedAt: null, ...extra,
});

describe('review stats arithmetic', () => {
  it('averages, shares, medians and distributions', () => {
    expect(average([5, 4, 4])).toBe(4.33);
    expect(average([5, 4, 4], 1)).toBe(4.3);
    expect(average([])).toBeNull();
    expect(share(1, 3)).toBe(0.3333);
    expect(share(0, 0)).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(median([])).toBeNull();
    expect(distribution([5, 5, 1, 3, 7])).toEqual({ '1': 1, '2': 0, '3': 1, '4': 0, '5': 2 });
  });

  it('counts days in the restaurant’s time zone', () => {
    // 23:30 UTC on the 5th is already the 6th in Cairo (UTC+2).
    expect(localDay(at('2026-11-05T23:30:00Z'), TZ)).toBe('2026-11-06');
    expect(lastDays(3, now, TZ)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
  });

  it('computes the period’s stats from every review', () => {
    const rows = [
      row(5, { ratings: { food: 5, service: 4 }, tags: ['DELICIOUS', 'FAST'], repliedAt: at('2026-11-05T10:30:00Z') }),
      row(4, { ratings: { food: 4 }, tags: ['DELICIOUS'], createdAt: at('2026-11-06T08:00:00Z'), repliedAt: at('2026-11-06T09:30:00Z') }),
      row(2, { tags: ['SLOW', 'SLOW'], verified: false, followUpStatus: 'CONTACTED' }),
      row(1, { ratings: { service: 1 }, followUpStatus: 'OPEN', createdAt: at('2026-11-04T09:00:00Z') }),
    ];
    const stats = computeStats(rows, { days: 3, now, timeZone: TZ, tags: DEFAULT_REVIEW_TAGS });
    expect(stats).toMatchObject({
      days: 3,
      count: 4,
      average: 3,
      distribution: { '1': 1, '2': 1, '3': 0, '4': 1, '5': 1 },
      subRatings: { food: { average: 4.5, count: 2 }, service: { average: 2.5, count: 2 } },
      replyRate: 0.5,
      // 30 and 90 minutes.
      medianReplyMinutes: 60,
      unhappy: 2,
      unhappyFollowedUpShare: 0.5,
      verifiedShare: 0.75,
    });
    expect(stats.series).toEqual([
      { day: '2026-11-04', count: 1, average: 1 },
      { day: '2026-11-05', count: 2, average: 3.5 },
      { day: '2026-11-06', count: 1, average: 4 },
    ]);
    // A tag counts once per review, most frequent first, named from the settings.
    expect(stats.tags.map((tag) => [tag.code, tag.count, tag.sentiment])).toEqual([['DELICIOUS', 2, 'POSITIVE'], ['FAST', 1, 'POSITIVE'], ['SLOW', 1, 'NEGATIVE']]);
  });

  it('has nothing to say about an empty period', () => {
    const stats = computeStats([], { days: 2, now, timeZone: TZ, tags: [] });
    expect(stats).toMatchObject({ count: 0, average: null, replyRate: null, medianReplyMinutes: null, unhappy: 0, unhappyFollowedUpShare: null, verifiedShare: null });
    expect(stats.series).toEqual([{ day: '2026-11-05', count: 0, average: null }, { day: '2026-11-06', count: 0, average: null }]);
  });
});

describe('dish ratings', () => {
  const koshary = { menuItemId: 'k', nameAr: 'كشري', nameEn: 'Koshary' };
  const lemonade = { menuItemId: 'l', nameAr: 'ليمون', nameEn: null };

  it('ranks dishes best first with up and down shares, grouping deleted dishes by name', () => {
    const rows = dishRows([
      { ...koshary, rating: 5 }, { ...koshary, rating: 5 }, { ...koshary, rating: 1 },
      { ...lemonade, rating: 5 }, { ...lemonade, rating: 5 },
      { menuItemId: null, nameAr: 'فتة', nameEn: null, rating: 3 }, { menuItemId: null, nameAr: 'فتة', nameEn: null, rating: 2 },
    ]);
    expect(rows.map((dish) => [dish.nameAr, dish.average, dish.count, dish.upShare, dish.downShare])).toEqual([
      ['ليمون', 5, 2, 1, 0],
      ['كشري', 3.67, 3, 0.6667, 0.3333],
      ['فتة', 2.5, 2, 0, 0.5],
    ]);
    expect(dishRows([{ ...koshary, rating: 5 }, { ...lemonade, rating: 4 }, { ...lemonade, rating: 4 }], 2).map((dish) => dish.menuItemId)).toEqual(['l']);
  });

  it('shows a menu badge only from menuMinCount ratings', () => {
    expect(menuRating({ count: 2, sum: 10, positive: 2 }, 3)).toBeNull();
    expect(menuRating({ count: 3, sum: 11, positive: 2 }, 3)).toEqual({ average: 3.7, count: 3, positiveShare: 0.6667 });
    expect(menuRating({ count: 0, sum: 0, positive: 0 }, 0)).toBeNull();
  });
});

describe('CSV', () => {
  it('quotes when needed and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(null)).toBe('');
    expect(toCsv([['a', 'ب'], [1, null]])).toBe('﻿a,ب\r\n1,\r\n');
  });
});
