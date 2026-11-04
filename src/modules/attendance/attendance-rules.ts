import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AttendanceStatus } from '@bilhanah/contracts';

/** The parts of a policy the calculations use. */
export type Rules = {
  graceMinutes: number;
  earlyCheckInMinutes: number;
  lateCheckOutMinutes: number;
  recordOvertime: boolean;
};

export type ShiftWindow = { id: string; startsAt: Date; endsAt: Date; isLeave: boolean };

const MINUTE = 60_000;

/** The restaurant's local date at `at` ("2026-11-04"). */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The UTC offset of `timeZone` at `at`, in minutes (Cairo in summer: +180). */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const local = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']));
  return Math.round((local - at.getTime()) / MINUTE);
}

/** The instant of a local wall-clock time ("2026-11-04", "09:30") in the restaurant's time zone. */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const guess = new Date(`${day}T${time}:00.000Z`);
  // Two passes settle the offset across a daylight-saving change.
  const first = new Date(guess.getTime() - offsetMinutes(guess, timeZone) * MINUTE);
  return new Date(guess.getTime() - offsetMinutes(first, timeZone) * MINUTE);
}

/** A shift's instants: an end at or before its start is the next day's (a night shift). */
export function shiftInstants(day: string, start: string, end: string, timeZone: string): { startsAt: Date; endsAt: Date } {
  const startsAt = zonedInstant(day, start, timeZone);
  let endsAt = zonedInstant(day, end, timeZone);
  if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 60 * MINUTE);
  return { startsAt, endsAt };
}

/**
 * The shift a check-in at `now` belongs to: one open for it (from early check-in to its end plus
 * the late check-out allowance), else the next one that has not opened yet (`early`).
 */
export function matchShift(shifts: readonly ShiftWindow[], now: Date, rules: Rules): { shift: ShiftWindow; early: boolean } | null {
  const working = shifts.filter((shift) => !shift.isLeave).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const open = working.find((shift) => now.getTime() >= shift.startsAt.getTime() - rules.earlyCheckInMinutes * MINUTE && now.getTime() <= shift.endsAt.getTime() + rules.lateCheckOutMinutes * MINUTE);
  if (open) return { shift: open, early: false };
  const next = working.find((shift) => shift.startsAt.getTime() - rules.earlyCheckInMinutes * MINUTE > now.getTime());
  return next ? { shift: next, early: true } : null;
}

export type Computed = { status: AttendanceStatus; workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number };

/**
 * A session's figures and status from its times, its shift and the rules. Late: checked in after
 * the start plus the grace period. Early leave and overtime (when recorded): out more than the
 * grace period before or after the end (a few minutes either way is noise). Incomplete: still not out after the end plus the late check-out allowance (or,
 * with no shift, by the end of the day). The status shows the most important of these.
 */
export function computeRecord(input: { checkInAt: Date; checkOutAt: Date | null; shift: ShiftWindow | null; rules: Rules; now: Date; dayEndsAt: Date }): Computed {
  const { checkInAt, checkOutAt, shift, rules, now } = input;
  const minutes = (ms: number) => Math.max(0, Math.round(ms / MINUTE));
  const workedMinutes = checkOutAt ? minutes(checkOutAt.getTime() - checkInAt.getTime()) : 0;
  const lateBy = shift ? checkInAt.getTime() - shift.startsAt.getTime() : 0;
  const lateMinutes = shift && lateBy > rules.graceMinutes * MINUTE ? minutes(lateBy) : 0;
  const grace = rules.graceMinutes * MINUTE;
  const earlyLeaveMinutes = shift && checkOutAt && shift.endsAt.getTime() - checkOutAt.getTime() > grace ? minutes(shift.endsAt.getTime() - checkOutAt.getTime()) : 0;
  const overtimeMinutes = shift && checkOutAt && rules.recordOvertime && checkOutAt.getTime() - shift.endsAt.getTime() > grace ? minutes(checkOutAt.getTime() - shift.endsAt.getTime()) : 0;
  const deadline = shift ? new Date(shift.endsAt.getTime() + rules.lateCheckOutMinutes * MINUTE) : input.dayEndsAt;
  let status: AttendanceStatus = 'PRESENT';
  if (!checkOutAt && now > deadline) status = 'INCOMPLETE';
  else if (lateMinutes) status = 'LATE';
  else if (earlyLeaveMinutes) status = 'EARLY_LEAVE';
  else if (overtimeMinutes) status = 'OVERTIME';
  return { status, workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes };
}

/** Great-circle distance in meters. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

// --- QR codes ------------------------------------------------------------------------------------
// Static: "s_" + the branch's random code. Dynamic: "d_" + policy id + time window + an HMAC of both
// with the policy's secret, valid for its window and the one before (so a code shown at the end of a
// window still works while the employee scans). Neither carries anything about an employee.

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);

export function dynamicQrCode(policyId: string, secret: string, ttlSeconds: number, now = Date.now()): { code: string; expiresAt: Date } {
  const window = Math.floor(now / (ttlSeconds * 1000));
  return { code: `d_${policyId}.${window}.${sign(secret, `${policyId}.${window}`)}`, expiresAt: new Date((window + 1) * ttlSeconds * 1000) };
}

export type ParsedQr = { kind: 'static'; code: string } | { kind: 'dynamic'; policyId: string; window: number; signature: string } | null;

export function parseQrCode(raw: string): ParsedQr {
  if (raw.startsWith('s_') && /^s_[A-Za-z0-9_-]{16,32}$/.test(raw)) return { kind: 'static', code: raw.slice(2) };
  const match = /^d_([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(raw);
  return match ? { kind: 'dynamic', policyId: match[1]!, window: Number(match[2]), signature: match[3]! } : null;
}

/** 'valid', 'expired' (a real code from an older window) or 'invalid'. */
export function checkDynamicQr(parsed: Extract<ParsedQr, { kind: 'dynamic' }>, secret: string, ttlSeconds: number, now = Date.now()): 'valid' | 'expired' | 'invalid' {
  const expected = Buffer.from(sign(secret, `${parsed.policyId}.${parsed.window}`));
  const given = Buffer.from(parsed.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  const current = Math.floor(now / (ttlSeconds * 1000));
  if (parsed.window > current) return 'invalid';
  return current - parsed.window <= 1 ? 'valid' : 'expired';
}
