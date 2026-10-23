import { describe, expect, it } from 'vitest';
import { isOpenAt } from '../src/hours.js';
import { type OpeningHours, openingHoursSchema } from '../src/opening-hours.js';

const closed = { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] };
// 2026-10-24 is a Saturday. Cairo is UTC+3 in October 2026.
const cairo = (isoLocal: string) => new Date(`${isoLocal}+03:00`);

describe('isOpenAt', () => {
  const hours: OpeningHours = {
    ...closed,
    sat: [{ opens: '12:00', closes: '16:00' }, { opens: '18:00', closes: '02:00' }],
    sun: [{ opens: '09:00', closes: '17:00' }],
  };

  it('uses the restaurant time zone', () => {
    expect(isOpenAt(hours, cairo('2026-10-24T13:00'), 'Africa/Cairo')).toBe(true);
    expect(isOpenAt(hours, cairo('2026-10-24T17:00'), 'Africa/Cairo')).toBe(false);
    // 13:00 in Cairo is 10:00 UTC; the same instant in London is 11:00, before opening.
    expect(isOpenAt(hours, cairo('2026-10-24T13:00'), 'Europe/London')).toBe(false);
  });

  it('treats closing time as exclusive', () => {
    expect(isOpenAt(hours, cairo('2026-10-24T15:59'), 'Africa/Cairo')).toBe(true);
    expect(isOpenAt(hours, cairo('2026-10-24T16:00'), 'Africa/Cairo')).toBe(false);
  });

  it('carries ranges past midnight into the next day', () => {
    expect(isOpenAt(hours, cairo('2026-10-24T23:30'), 'Africa/Cairo')).toBe(true);
    expect(isOpenAt(hours, cairo('2026-10-25T01:30'), 'Africa/Cairo')).toBe(true); // Sunday, from Saturday night
    expect(isOpenAt(hours, cairo('2026-10-25T02:30'), 'Africa/Cairo')).toBe(false);
    expect(isOpenAt(hours, cairo('2026-10-25T09:00'), 'Africa/Cairo')).toBe(true);
  });

  it('is closed on days without ranges', () => {
    expect(isOpenAt(hours, cairo('2026-10-26T13:00'), 'Africa/Cairo')).toBe(false); // Monday
  });
});

describe('openingHoursSchema', () => {
  it('requires every day and valid 24-hour times', () => {
    expect(openingHoursSchema.safeParse(closed).success).toBe(true);
    expect(openingHoursSchema.safeParse({ sat: [] }).success).toBe(false);
    expect(openingHoursSchema.safeParse({ ...closed, sat: [{ opens: '9:00', closes: '17:00' }] }).success).toBe(false);
    expect(openingHoursSchema.safeParse({ ...closed, sat: [{ opens: '10:00', closes: '10:00' }] }).success).toBe(false);
  });
});
