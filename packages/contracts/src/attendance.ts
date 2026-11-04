import { z } from 'zod';

/**
 * Staff attendance: employees check in and out by the methods their branch allows (employee portal,
 * QR code, PIN kiosk; USB fingerprint once a device is chosen), against their shifts and the
 * branch's rules. An event is one check-in or check-out; a record is the session it makes; a status
 * is calculated from the record, the shift and the rules.
 */

export const ATTENDANCE_ERROR_CODES = {
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  /** 403: this account has no employee record (the owner links one on the attendance page). */
  NOT_AN_EMPLOYEE: 'NOT_AN_EMPLOYEE',
  EMPLOYEE_INACTIVE: 'EMPLOYEE_INACTIVE',
  EMPLOYEE_NUMBER_TAKEN: 'EMPLOYEE_NUMBER_TAKEN',
  /** 409: the account is already linked to another employee. */
  ACCOUNT_ALREADY_LINKED: 'ACCOUNT_ALREADY_LINKED',
  /** 403: the method is not enabled at the employee's branch. details: { method, methods } */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  /** 409: no shift now, and the rules need one. */
  NO_SHIFT: 'NO_SHIFT',
  /** 409: too early for the shift (before its early check-in allowance). details: { opensAt } */
  TOO_EARLY: 'TOO_EARLY',
  /** 409: this shift's attendance is already complete. */
  SHIFT_DONE: 'SHIFT_DONE',
  /** 403: outside the branch's radius, or no location, under the REJECT rule. details: { distanceMeters } */
  OUTSIDE_LOCATION: 'OUTSIDE_LOCATION',
  /** 400: an unknown, disabled or expired QR code. */
  QR_INVALID: 'QR_INVALID',
  QR_EXPIRED: 'QR_EXPIRED',
  /** 401: a wrong employee number or PIN (the same answer for both). */
  PIN_INVALID: 'PIN_INVALID',
  /** 429: too many wrong PINs; retry after details.retryAfterSeconds. */
  KIOSK_LOCKED: 'KIOSK_LOCKED',
  /** 401: the kiosk's token is missing, unknown or disabled. */
  KIOSK_UNAUTHORIZED: 'KIOSK_UNAUTHORIZED',
  KIOSK_CODE_INVALID: 'KIOSK_CODE_INVALID',
  /** 400: at least one method must stay on; the primary must be one of them; fingerprint needs a device. */
  POLICY_INVALID: 'POLICY_INVALID',
  CORRECTIONS_DISABLED: 'CORRECTIONS_DISABLED',
  CORRECTION_ALREADY_REVIEWED: 'CORRECTION_ALREADY_REVIEWED',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
} as const;

export const ATTENDANCE_METHODS = ['PORTAL', 'QR', 'KIOSK', 'FINGERPRINT'] as const;
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];
/** How an event or record came in: a method, or a manager entering it. */
export type AttendanceSource = AttendanceMethod | 'MANUAL';

export const ATTENDANCE_STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'INCOMPLETE', 'EARLY_LEAVE', 'OVERTIME', 'PENDING_CORRECTION'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** USB fingerprint needs a confirmed device model and its local service; it cannot be turned on yet. */
export const AVAILABLE_ATTENDANCE_METHODS = ['PORTAL', 'QR', 'KIOSK'] as const satisfies readonly AttendanceMethod[];

export const ATTENDANCE_LIMITS = {
  employees: 500,
  /** Wrong PINs in a row (per kiosk, or per employee number) before a lock. */
  pinAttempts: 5,
  pinLockSeconds: 5 * 60,
  pinLength: { min: 4, max: 6 },
  kioskCodeMinutes: 15,
  qrTtlSeconds: { min: 15, max: 300 },
  rangeDays: 93,
} as const;

// --- Policies ---------------------------------------------------------------------------------------

export const attendancePolicySchema = z.strictObject({
  methods: z.array(z.enum(ATTENDANCE_METHODS)).min(1).max(4).transform((list) => [...new Set(list)]),
  primaryMethod: z.enum(ATTENDANCE_METHODS),
  graceMinutes: z.number().int().min(0).max(120),
  earlyCheckInMinutes: z.number().int().min(0).max(240),
  lateCheckOutMinutes: z.number().int().min(0).max(480),
  recordOvertime: z.boolean(),
  allowWithoutShift: z.boolean(),
  allowOutsideShift: z.boolean(),
  allowMultipleShifts: z.boolean(),
  requireCheckOut: z.boolean(),
  correctionsEnabled: z.boolean(),
  manualNeedsApproval: z.boolean(),
  qrMode: z.enum(['STATIC', 'DYNAMIC']),
  qrTtlSeconds: z.number().int().min(ATTENDANCE_LIMITS.qrTtlSeconds.min).max(ATTENDANCE_LIMITS.qrTtlSeconds.max),
  locationMode: z.enum(['OFF', 'FLAG', 'REJECT']),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  radiusMeters: z.number().int().min(20).max(5000).nullable(),
})
  .refine((policy) => policy.methods.includes(policy.primaryMethod), { path: ['primaryMethod'], message: 'The primary method must be enabled.' })
  .refine((policy) => policy.locationMode === 'OFF' || (policy.latitude !== null && policy.longitude !== null && policy.radiusMeters !== null), {
    path: ['radiusMeters'], message: 'Set the branch location and radius to check it.',
  });
export type AttendancePolicyInput = z.output<typeof attendancePolicySchema>;

/** A policy as stored: the restaurant's (branchId null) or a branch's own. */
export type AttendancePolicy = AttendancePolicyInput & { branchId: string | null; updatedAt: string };

/** GET /v1/attendance/policies: the restaurant's rules and each branch's (its own, or the restaurant's). */
export type AttendancePolicies = {
  restaurant: AttendancePolicy;
  branches: { branchId: string; branchName: string; override: boolean; policy: AttendancePolicy; qrUrl: string | null }[];
};

// --- Employees and shifts ---------------------------------------------------------------------------

const employeeFields = {
  fullName: z.string().trim().min(2).max(100),
  branchId: z.uuid(),
  jobTitle: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  /** Empty: the next free number. */
  employeeNumber: z.string().trim().regex(/^[0-9A-Za-z-]{1,12}$/).optional(),
  /** A staff account of this restaurant (portal and QR attendance). */
  userId: z.uuid().nullable().optional(),
  hireDate: z.iso.date().nullable().optional(),
};
export const createEmployeeSchema = z.strictObject(employeeFields);
export const updateEmployeeSchema = z.strictObject({ ...employeeFields, isActive: z.boolean() }).partial();

export type Employee = {
  id: string;
  employeeNumber: string;
  fullName: string;
  jobTitle: string | null;
  phone: string | null;
  branchId: string;
  branchName: string;
  /** The linked staff account, by name and role. */
  account: { id: string; name: string; role: string } | null;
  isActive: boolean;
  hireDate: string | null;
  hasPin: boolean;
  pinMustChange: boolean;
};

/** POST /v1/attendance/employees/:id/pin: the new PIN, shown once. */
export type EmployeePin = { pin: string };

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Shifts for several employees on several days at once (a shift ending at or before its start ends the next day). */
export const createShiftsSchema = z.strictObject({
  employeeIds: z.array(z.uuid()).min(1).max(100),
  days: z.array(z.iso.date()).min(1).max(31),
  start: clock,
  end: clock,
  name: z.string().trim().max(40).nullable().optional(),
  isLeave: z.boolean().default(false),
});

export type Shift = {
  id: string;
  employeeId: string;
  branchId: string;
  day: string;
  startsAt: string;
  endsAt: string;
  name: string | null;
  isLeave: boolean;
};

export const rangeQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  branchId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
});

// --- Records --------------------------------------------------------------------------------------

export type AttendanceRecord = {
  id: string;
  employee: { id: string; fullName: string; employeeNumber: string; jobTitle: string | null };
  branchId: string;
  branchName: string;
  day: string;
  shift: { id: string; startsAt: string; endsAt: string; name: string | null } | null;
  checkInAt: string;
  checkOutAt: string | null;
  status: AttendanceStatus;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  checkInMethod: AttendanceSource;
  checkOutMethod: AttendanceSource | null;
  kioskName: string | null;
  flagged: boolean;
  managerNote: string | null;
};

export const recordsQuerySchema = rangeQuerySchema.extend({
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  method: z.enum([...ATTENDANCE_METHODS, 'MANUAL']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const exportQuerySchema = recordsQuerySchema.omit({ page: true, pageSize: true }).extend({
  format: z.enum(['csv', 'xls']).default('csv'),
  report: z.enum(['records', 'summary']).default('records'),
  lang: z.enum(['ar', 'en']).default('ar'),
});

const isoInstant = z.iso.datetime({ offset: true });
/** A manager records attendance for an employee (forgotten, or on their behalf). */
export const manualRecordSchema = z.strictObject({
  employeeId: z.uuid(),
  checkInAt: isoInstant,
  checkOutAt: isoInstant.nullable(),
  reason: z.string().trim().min(3).max(300),
});

/** Editing a record: new times and/or a note, with why (kept in the audit log). */
export const updateRecordSchema = z.strictObject({
  checkInAt: isoInstant.optional(),
  checkOutAt: isoInstant.nullable().optional(),
  managerNote: z.string().trim().max(300).nullable().optional(),
  reason: z.string().trim().min(3).max(300),
});

/** A manual entry or edit: applied, or waiting for approval (when the rules say so). */
export type ManualAttendanceResult = { record: AttendanceRecord | null; pendingCorrection: AttendanceCorrection | null };

/** One employee's day on the overview: their shift(s), their session(s) and where they stand. */
export type AttendanceOverviewRow = {
  employee: { id: string; fullName: string; employeeNumber: string; jobTitle: string | null; branchName: string };
  shifts: Shift[];
  records: AttendanceRecord[];
  /** UPCOMING: a shift later today; NOT_SCHEDULED: no shift and no attendance; WORKING: checked in now. */
  state: AttendanceStatus | 'UPCOMING' | 'NOT_SCHEDULED' | 'WORKING';
};

/** GET /v1/attendance/overview?date=&branchId= */
export type AttendanceOverview = {
  date: string;
  totals: { scheduled: number; present: number; absent: number; late: number; working: number; incomplete: number; onLeave: number; overtime: number };
  rows: AttendanceOverviewRow[];
  pendingCorrections: number;
};

/** Per employee over a period (the monthly / late / absence / overtime reports). */
export type AttendanceSummaryRow = {
  employee: { id: string; fullName: string; employeeNumber: string; branchName: string };
  scheduledShifts: number;
  daysPresent: number;
  lateCount: number;
  lateMinutes: number;
  absences: number;
  incomplete: number;
  leaveDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
};

// --- Checking in and out ------------------------------------------------------------------------

const location = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).optional() });

export const portalPunchSchema = z.strictObject({
  action: z.enum(['CHECK_IN', 'CHECK_OUT']),
  idempotencyKey: z.string().min(8).max(64),
  location: location.nullable().optional(),
});

/** The QR code scanned at the branch; the server decides check-in or check-out. */
export const qrPunchSchema = z.strictObject({
  code: z.string().min(8).max(200),
  idempotencyKey: z.string().min(8).max(64),
  location: location.nullable().optional(),
});

export const kioskPunchSchema = z.strictObject({
  employeeNumber: z.string().trim().min(1).max(12),
  pin: z.string().regex(/^\d{4,6}$/),
  idempotencyKey: z.string().min(8).max(64),
});

export const changePinSchema = z.strictObject({ pin: z.string().regex(/^\d{4,6}$/) });

/** At the kiosk: the employee replaces a reset PIN (proving the current one). */
export const kioskChangePinSchema = z.strictObject({
  employeeNumber: z.string().trim().min(1).max(12),
  pin: z.string().regex(/^\d{4,6}$/),
  newPin: z.string().regex(/^\d{4,6}$/),
});

/** What a check-in or check-out did, for the confirmation screen. */
export type PunchResult = {
  action: 'CHECK_IN' | 'CHECK_OUT';
  /** The kiosk asks for a new PIN (a reset PIN must be changed). */
  mustChangePin: boolean;
  at: string;
  employeeName: string;
  record: AttendanceRecord;
  /** The record is flagged (location) and a manager will see it. */
  flagged: boolean;
};

/** GET /v1/attendance/me: the signed-in employee's attendance page. */
export type MyAttendance = {
  employee: { id: string; fullName: string; employeeNumber: string; branchName: string; pinMustChange: boolean; hasPin: boolean };
  methods: AttendanceMethod[];
  primaryMethod: AttendanceMethod;
  locationRequired: boolean;
  correctionsEnabled: boolean;
  /** Checked in, not out yet. */
  open: AttendanceRecord | null;
  todayShifts: Shift[];
  upcomingShifts: Shift[];
  recent: AttendanceRecord[];
};

// --- Kiosks and QR ------------------------------------------------------------------------------

export const createKioskSchema = z.strictObject({ name: z.string().trim().min(1).max(60), branchId: z.uuid() });
export const activateKioskSchema = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/) });

export type AttendanceKiosk = {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  activated: boolean;
  disabled: boolean;
  lastSeenAt: string | null;
};

/** The one-time code typed on the kiosk screen (shown once). */
export type KioskActivationCode = { code: string; expiresAt: string };

/** What an activated kiosk shows: its place, and the branch's live QR code when QR is on (dynamic). */
export type KioskState = {
  kiosk: { name: string; branchName: string; restaurantName: string };
  methods: AttendanceMethod[];
  qr: { url: string; expiresAt: string } | null;
};

export type KioskActivation = { token: string; state: KioskState };

// --- Corrections --------------------------------------------------------------------------------

export const createCorrectionSchema = z.strictObject({
  day: z.iso.date(),
  /** The session being fixed; none when the employee never checked in that day. */
  recordId: z.uuid().nullable().optional(),
  requestedCheckIn: isoInstant.nullable(),
  requestedCheckOut: isoInstant.nullable(),
  reason: z.string().trim().min(3).max(300),
}).refine((value) => value.requestedCheckIn || value.requestedCheckOut, { path: ['requestedCheckIn'], message: 'Give a check-in or check-out time.' });

export const reviewCorrectionSchema = z.strictObject({ note: z.string().trim().max(300).nullable().optional() });

export type AttendanceCorrection = {
  id: string;
  employee: { id: string; fullName: string; employeeNumber: string; branchName: string };
  day: string;
  recordId: string | null;
  current: { checkInAt: string; checkOutAt: string | null } | null;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
};

export const correctionsQuerySchema = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), branchId: z.uuid().optional() });

/** Names on screen: [Arabic, English]. */
export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, [string, string]> = {
  PRESENT: ['حاضر', 'Present'],
  LATE: ['متأخر', 'Late'],
  ABSENT: ['غايب', 'Absent'],
  ON_LEAVE: ['إجازة', 'On leave'],
  INCOMPLETE: ['ناقص', 'Incomplete'],
  EARLY_LEAVE: ['مشي بدري', 'Early leave'],
  OVERTIME: ['وقت إضافي', 'Overtime'],
  PENDING_CORRECTION: ['مستني تصحيح', 'Pending correction'],
};

export const ATTENDANCE_METHOD_LABELS: Record<AttendanceSource, [string, string]> = {
  PORTAL: ['بوابة الموظف', 'Employee portal'],
  QR: ['كود QR', 'QR code'],
  KIOSK: ['كشك PIN', 'PIN kiosk'],
  FINGERPRINT: ['بصمة USB', 'USB fingerprint'],
  MANUAL: ['يدوي', 'Manual'],
};
