import { checkDynamicQr, computeRecord, distanceMeters, dynamicQrCode, localDay, matchShift, parseQrCode, shiftInstants, zonedInstant } from './attendance-rules.js';

const rules = { graceMinutes: 10, earlyCheckInMinutes: 30, lateCheckOutMinutes: 60, recordOvertime: true };
const at = (iso: string) => new Date(iso);
const shift = { id: 's', startsAt: at('2026-11-04T07:00:00.000Z'), endsAt: at('2026-11-04T15:00:00.000Z'), isLeave: false };
const dayEndsAt = at('2026-11-04T22:00:00.000Z');

describe('attendance rules', () => {
  it('turns the restaurant\'s wall-clock times into instants, night shifts ending the next day', () => {
    // Cairo is UTC+2 in November.
    expect(zonedInstant('2026-11-04', '09:00', 'Africa/Cairo').toISOString()).toBe('2026-11-04T07:00:00.000Z');
    const night = shiftInstants('2026-11-04', '22:00', '06:00', 'Africa/Cairo');
    expect(night.endsAt.toISOString()).toBe('2026-11-05T04:00:00.000Z');
    expect(localDay(at('2026-11-04T23:30:00.000Z'), 'Africa/Cairo')).toBe('2026-11-05');
  });

  it('matches a check-in to its shift, or says it is too early', () => {
    expect(matchShift([shift], at('2026-11-04T06:40:00.000Z'), rules)).toEqual({ shift, early: false });
    expect(matchShift([shift], at('2026-11-04T06:00:00.000Z'), rules)).toEqual({ shift, early: true });
    expect(matchShift([shift], at('2026-11-04T16:30:00.000Z'), rules)).toBeNull();
    expect(matchShift([{ ...shift, isLeave: true }], at('2026-11-04T07:00:00.000Z'), rules)).toBeNull();
  });

  it('calculates late, early leave, overtime and incomplete sessions', () => {
    const now = at('2026-11-04T20:00:00.000Z');
    expect(computeRecord({ checkInAt: at('2026-11-04T07:08:00.000Z'), checkOutAt: at('2026-11-04T15:00:00.000Z'), shift, rules, now, dayEndsAt }))
      .toEqual({ status: 'PRESENT', workedMinutes: 472, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 });
    expect(computeRecord({ checkInAt: at('2026-11-04T07:25:00.000Z'), checkOutAt: at('2026-11-04T15:00:00.000Z'), shift, rules, now, dayEndsAt }))
      .toMatchObject({ status: 'LATE', lateMinutes: 25 });
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: at('2026-11-04T14:00:00.000Z'), shift, rules, now, dayEndsAt }))
      .toMatchObject({ status: 'EARLY_LEAVE', earlyLeaveMinutes: 60 });
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: at('2026-11-04T16:30:00.000Z'), shift, rules, now, dayEndsAt }))
      .toMatchObject({ status: 'OVERTIME', overtimeMinutes: 90 });
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: at('2026-11-04T16:30:00.000Z'), shift, rules: { ...rules, recordOvertime: false }, now, dayEndsAt }))
      .toMatchObject({ status: 'PRESENT', overtimeMinutes: 0 });
    // A few minutes either side of the end (within the grace period) is neither overtime nor early leave.
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: at('2026-11-04T15:02:00.000Z'), shift, rules, now, dayEndsAt }))
      .toMatchObject({ status: 'PRESENT', overtimeMinutes: 0 });
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: at('2026-11-04T14:55:00.000Z'), shift, rules, now, dayEndsAt }))
      .toMatchObject({ status: 'PRESENT', earlyLeaveMinutes: 0 });
    // Still in after the end plus the allowance: incomplete; within it, still present.
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: null, shift, rules, now, dayEndsAt }).status).toBe('INCOMPLETE');
    expect(computeRecord({ checkInAt: at('2026-11-04T07:00:00.000Z'), checkOutAt: null, shift, rules, now: at('2026-11-04T15:30:00.000Z'), dayEndsAt }).status).toBe('PRESENT');
  });

  it('measures distance from the branch', () => {
    expect(distanceMeters({ latitude: 30.0444, longitude: 31.2357 }, { latitude: 30.0444, longitude: 31.2357 })).toBe(0);
    const d = distanceMeters({ latitude: 30.0444, longitude: 31.2357 }, { latitude: 30.0454, longitude: 31.2357 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it('signs short-lived QR codes that only the server can check', () => {
    const policyId = '0b3c8a8e-1f0b-4e7a-9d6c-2a9a1f3b5c7d';
    const now = Date.UTC(2026, 10, 4, 9, 0, 10);
    const { code } = dynamicQrCode(policyId, 'secret', 30, now);
    const parsed = parseQrCode(code);
    expect(parsed?.kind).toBe('dynamic');
    if (parsed?.kind !== 'dynamic') return;
    expect(checkDynamicQr(parsed, 'secret', 30, now)).toBe('valid');
    expect(checkDynamicQr(parsed, 'secret', 30, now + 35_000)).toBe('valid');
    expect(checkDynamicQr(parsed, 'secret', 30, now + 120_000)).toBe('expired');
    expect(checkDynamicQr(parsed, 'other-secret', 30, now)).toBe('invalid');
    expect(parseQrCode('s_short')).toBeNull();
    expect(parseQrCode('s_abcdefghijklmnop')).toEqual({ kind: 'static', code: 'abcdefghijklmnop' });
  });
});
