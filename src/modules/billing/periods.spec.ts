import { addMonths, nextPeriodStart } from './periods.js';

const utc = (iso: string) => new Date(`${iso}T10:00:00.000Z`);

describe('addMonths', () => {
  it('keeps the day of month', () => {
    expect(addMonths(utc('2026-10-15'), 1)).toEqual(utc('2026-11-15'));
    expect(addMonths(utc('2026-10-15'), 12)).toEqual(utc('2027-10-15'));
  });

  it('clamps to the end of shorter months', () => {
    expect(addMonths(utc('2026-01-31'), 1)).toEqual(utc('2026-02-28'));
    expect(addMonths(utc('2028-01-31'), 1)).toEqual(utc('2028-02-29'));
    expect(addMonths(utc('2026-08-31'), 3)).toEqual(utc('2026-11-30'));
  });
});

describe('nextPeriodStart', () => {
  const now = utc('2026-10-23');

  it('starts now without current coverage', () => {
    expect(nextPeriodStart([], now)).toEqual(now);
    expect(nextPeriodStart([{ endsAt: utc('2026-09-01') }], now)).toEqual(now);
  });

  it('starts after the latest coverage, so trial days are not lost', () => {
    expect(nextPeriodStart([{ endsAt: utc('2026-11-10') }, { endsAt: utc('2026-12-10') }], now)).toEqual(utc('2026-12-10'));
  });
});
