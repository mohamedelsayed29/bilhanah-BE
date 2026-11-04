import { randomBytes, randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ATTENDANCE_ERROR_CODES as CODES,
  ATTENDANCE_LIMITS,
  AVAILABLE_ATTENDANCE_METHODS,
  type AttendanceCorrection,
  type AttendanceMethod,
  type AttendanceOverview,
  type AttendanceOverviewRow,
  type AttendancePolicies,
  type AttendancePolicy,
  type AttendancePolicyInput,
  type AttendanceRecord,
  type AttendanceSummaryRow,
  type attendancePolicySchema,
  type correctionsQuerySchema,
  type createCorrectionSchema,
  type createEmployeeSchema,
  type createShiftsSchema,
  type Employee,
  type EmployeePin,
  type ManualAttendanceResult,
  type manualRecordSchema,
  type MyAttendance,
  type Paginated,
  type portalPunchSchema,
  type PunchResult,
  type qrPunchSchema,
  type rangeQuerySchema,
  type recordsQuerySchema,
  type Shift,
  type updateEmployeeSchema,
  type updateRecordSchema,
} from '@bilhanah/contracts';
import { Prisma, type AttendancePolicy as PolicyRow, type Employee as EmployeeRow } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { checkDynamicQr, computeRecord, distanceMeters, dynamicQrCode, localDay, matchShift, parseQrCode, type Rules, shiftInstants, type ShiftWindow, zonedInstant } from './attendance-rules.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const fail = (status: 'bad' | 'forbidden' | 'conflict' | 'notFound', code: string, message: string, details?: Record<string, unknown>) => {
  const body = { code, message, ...(details && { details }) };
  return status === 'bad' ? new BadRequestException(body) : status === 'forbidden' ? new ForbiddenException(body) : status === 'conflict' ? new ConflictException(body) : new NotFoundException(body);
};

const recordInclude = {
  employee: { select: { id: true, fullName: true, employeeNumber: true, jobTitle: true } },
  branch: { select: { name: true } },
  shift: { select: { id: true, startsAt: true, endsAt: true, name: true, isLeave: true } },
  kiosk: { select: { name: true } },
} satisfies Prisma.AttendanceRecordInclude;
type RecordRow = Prisma.AttendanceRecordGetPayload<{ include: typeof recordInclude }>;

const employeeInclude = { branch: { select: { name: true } }, user: { select: { id: true, fullName: true, role: true } } } satisfies Prisma.EmployeeInclude;
type EmployeeWithLinks = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;

/** The rules every new restaurant starts with. */
const DEFAULT_POLICY: AttendancePolicyInput = {
  methods: ['PORTAL'], primaryMethod: 'PORTAL', graceMinutes: 10, earlyCheckInMinutes: 30, lateCheckOutMinutes: 60, recordOvertime: true,
  allowWithoutShift: false, allowOutsideShift: false, allowMultipleShifts: false, requireCheckOut: true, correctionsEnabled: true,
  manualNeedsApproval: false, qrMode: 'DYNAMIC', qrTtlSeconds: 30, locationMode: 'OFF', latitude: null, longitude: null, radiusMeters: null,
};

const POLICY_FIELDS = Object.keys(DEFAULT_POLICY) as (keyof AttendancePolicyInput)[];
const policyValues = (row: PolicyRow): AttendancePolicyInput => Object.fromEntries(POLICY_FIELDS.map((field) => [field, row[field as keyof PolicyRow]])) as AttendancePolicyInput;

/** What a check-in or check-out asks for, from any method. */
type Punch = {
  employee: EmployeeRow;
  method: AttendanceMethod;
  action: 'CHECK_IN' | 'CHECK_OUT' | 'TOGGLE';
  idempotencyKey?: string;
  kioskId?: string | null;
  location?: { latitude: number; longitude: number; accuracy?: number } | null;
};

/**
 * Staff attendance: who works where (employees and their shifts), how they check in (each branch's
 * rules), every check-in and check-out (validated here, whatever the method), the sessions they
 * make, corrections, the daily overview and reports. Branch-tied managers only see their branch.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // --- Policies ----------------------------------------------------------------------------------

  async policies(userId: string): Promise<AttendancePolicies> {
    const scope = await this.scopes.resolve(userId);
    const restaurant = await this.restaurantPolicy(scope.restaurant.id);
    const branches = await this.scopes.visibleBranches(scope);
    const rows = await Promise.all(branches.map((branch) => this.branchRow(scope.restaurant.id, branch.id)));
    return {
      restaurant: this.toPolicy(restaurant),
      branches: branches.map((branch, index) => {
        const row = rows[index]!;
        return {
          branchId: branch.id,
          branchName: branch.name,
          override: !row.inherits,
          policy: this.toPolicy(row.inherits ? { ...restaurant, branchId: branch.id, updatedAt: row.updatedAt } : row),
          qrUrl: row.qrStaticCode ? this.scanUrl(`s_${row.qrStaticCode}`) : null,
        };
      }),
    };
  }

  /** The restaurant's rules, or (with a branch) that branch's own; `null` input makes a branch follow the restaurant again. */
  async setPolicy(userId: string, branchId: string | null, input: z.output<typeof attendancePolicySchema> | null, ipAddress?: string): Promise<AttendancePolicies> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.settings');
    if (input) this.checkPolicy(input);
    if (branchId) await this.scopes.branch(scope, branchId);
    await this.prisma.$transaction(async (tx) => {
      if (branchId) {
        const row = await this.branchRow(scope.restaurant.id, branchId, tx);
        await tx.attendancePolicy.update({ where: { id: row.id }, data: input ? { ...input, inherits: false, updatedById: userId } : { inherits: true, updatedById: userId } });
      } else {
        const row = await this.restaurantPolicy(scope.restaurant.id, tx);
        await tx.attendancePolicy.update({ where: { id: row.id }, data: { ...input!, updatedById: userId } });
      }
      await this.audit.record({
        actorId: userId, restaurantId: scope.restaurant.id, action: 'attendance.policy', targetType: 'attendance-policy', targetId: branchId,
        metadata: { branchId, methods: input?.methods ?? null, primaryMethod: input?.primaryMethod ?? null, inherits: input === null }, ipAddress,
      }, tx);
    });
    return this.policies(userId);
  }

  /** A new printed QR code for the branch (the old one stops working), and a new signing secret. */
  async regenerateQr(userId: string, branchId: string): Promise<AttendancePolicies> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.settings');
    await this.scopes.branch(scope, branchId);
    const row = await this.branchRow(scope.restaurant.id, branchId);
    await this.prisma.attendancePolicy.update({ where: { id: row.id }, data: { qrStaticCode: randomBytes(16).toString('base64url'), qrSecret: randomBytes(32).toString('hex') } });
    return this.policies(userId);
  }

  private checkPolicy(input: AttendancePolicyInput): void {
    const unavailable = input.methods.filter((method) => !(AVAILABLE_ATTENDANCE_METHODS as readonly string[]).includes(method));
    if (unavailable.length) {
      throw fail('bad', CODES.POLICY_INVALID, 'USB fingerprint needs a registered device first.', { methods: unavailable });
    }
  }

  private async restaurantPolicy(restaurantId: string, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<PolicyRow> {
    const existing = await client.attendancePolicy.findFirst({ where: { restaurantId, branchId: null } });
    if (existing) return existing;
    try {
      return await client.attendancePolicy.create({ data: { restaurantId, ...DEFAULT_POLICY, inherits: false, qrSecret: randomBytes(32).toString('hex') } });
    } catch (error) {
      // Two first visits at once: the other one created it.
      const again = await this.prisma.attendancePolicy.findFirst({ where: { restaurantId, branchId: null } });
      if (again) return again;
      throw error;
    }
  }

  /** The branch's row (created on first use, following the restaurant): its QR code and secret, and its own rules when it has them. */
  private async branchRow(restaurantId: string, branchId: string, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<PolicyRow> {
    const existing = await client.attendancePolicy.findUnique({ where: { branchId } });
    if (existing) return existing;
    const base = await this.restaurantPolicy(restaurantId, client);
    try {
      return await client.attendancePolicy.create({
        data: { ...policyValues(base), restaurantId, branchId, inherits: true, qrStaticCode: randomBytes(16).toString('base64url'), qrSecret: randomBytes(32).toString('hex') },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.prisma.attendancePolicy.findUniqueOrThrow({ where: { branchId } });
    }
  }

  /** The rules in force at a branch: its own, or the restaurant's; with the branch's QR details either way. */
  async effective(restaurantId: string, branchId: string): Promise<{ rules: AttendancePolicyInput; branchRow: PolicyRow }> {
    const row = await this.branchRow(restaurantId, branchId);
    if (!row.inherits) return { rules: policyValues(row), branchRow: row };
    return { rules: policyValues(await this.restaurantPolicy(restaurantId)), branchRow: row };
  }

  private toPolicy(row: PolicyRow): AttendancePolicy {
    return { ...policyValues(row), branchId: row.branchId, updatedAt: row.updatedAt.toISOString() };
  }

  scanUrl(code: string): string {
    return `${this.config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '')}/manager/attendance/scan?c=${encodeURIComponent(code)}`;
  }

  /** The branch's current QR code: its printed one, or the live signed one (dynamic mode). */
  async currentQr(restaurantId: string, branchId: string, now = new Date()): Promise<{ url: string; expiresAt: string } | null> {
    const { rules, branchRow } = await this.effective(restaurantId, branchId);
    if (!rules.methods.includes('QR')) return null;
    if (rules.qrMode === 'STATIC') return branchRow.qrStaticCode ? { url: this.scanUrl(`s_${branchRow.qrStaticCode}`), expiresAt: new Date(now.getTime() + DAY).toISOString() } : null;
    const { code, expiresAt } = dynamicQrCode(branchId, branchRow.qrSecret!, rules.qrTtlSeconds, now.getTime());
    return { url: this.scanUrl(code), expiresAt: expiresAt.toISOString() };
  }

  /** GET /attendance/qr/:branchId: the live code for a screen at the branch (managers). */
  async liveQr(userId: string, branchId: string): Promise<{ url: string; expiresAt: string } | null> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.manage');
    await this.scopes.branch(scope, branchId);
    return this.currentQr(scope.restaurant.id, branchId);
  }

  // --- Employees ---------------------------------------------------------------------------------

  async employees(userId: string): Promise<Employee[]> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const rows = await this.prisma.employee.findMany({ where: this.employeeWhere(scope), include: employeeInclude, orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }] });
    return rows.map((row) => this.toEmployee(row));
  }

  async createEmployee(userId: string, input: z.output<typeof createEmployeeSchema>, ipAddress?: string): Promise<Employee> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    await this.scopes.branch(scope, input.branchId);
    if (input.userId) await this.checkAccount(scope, input.userId, null);
    const count = await this.prisma.employee.count({ where: { restaurantId: scope.restaurant.id } });
    if (count >= ATTENDANCE_LIMITS.employees) throw fail('conflict', CODES.EMPLOYEE_NUMBER_TAKEN, `Up to ${ATTENDANCE_LIMITS.employees} employees.`);
    const employeeNumber = input.employeeNumber ?? await this.nextNumber(scope.restaurant.id);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.employee.create({
          data: {
            restaurantId: scope.restaurant.id, branchId: input.branchId, employeeNumber, fullName: input.fullName, jobTitle: input.jobTitle ?? null,
            phone: input.phone ?? null, userId: input.userId ?? null, hireDate: input.hireDate ? new Date(`${input.hireDate}T00:00:00.000Z`) : null,
          },
          include: employeeInclude,
        });
        await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'attendance.employee_created', targetType: 'employee', targetId: created.id, metadata: { employeeName: created.fullName, employeeNumber }, ipAddress }, tx);
        return created;
      });
      return this.toEmployee(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw fail('conflict', CODES.EMPLOYEE_NUMBER_TAKEN, 'Another employee has this number.');
    }
  }

  async updateEmployee(userId: string, id: string, input: z.output<typeof updateEmployeeSchema>, ipAddress?: string): Promise<Employee> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const current = await this.findEmployee(scope, id);
    if (input.branchId) await this.scopes.branch(scope, input.branchId);
    if (input.userId) await this.checkAccount(scope, input.userId, id);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.employee.update({
          where: { id },
          data: {
            ...(input.fullName !== undefined && { fullName: input.fullName }),
            ...(input.branchId !== undefined && { branchId: input.branchId }),
            ...(input.jobTitle !== undefined && { jobTitle: input.jobTitle }),
            ...(input.phone !== undefined && { phone: input.phone }),
            ...(input.employeeNumber !== undefined && { employeeNumber: input.employeeNumber }),
            ...(input.userId !== undefined && { userId: input.userId }),
            ...(input.isActive !== undefined && { isActive: input.isActive }),
            ...(input.hireDate !== undefined && { hireDate: input.hireDate ? new Date(`${input.hireDate}T00:00:00.000Z`) : null }),
          },
          include: employeeInclude,
        });
        await this.audit.record({
          actorId: userId, restaurantId: scope.restaurant.id, action: 'attendance.employee_updated', targetType: 'employee', targetId: id,
          metadata: { employeeName: updated.fullName, ...(input.isActive !== undefined && input.isActive !== current.isActive && { to: input.isActive ? 'ACTIVE' : 'INACTIVE' }) }, ipAddress,
        }, tx);
        return updated;
      });
      return this.toEmployee(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw fail('conflict', CODES.EMPLOYEE_NUMBER_TAKEN, 'Another employee has this number.');
    }
  }

  /** A new random PIN, shown once; the employee must change it. */
  async resetPin(userId: string, id: string, ipAddress?: string): Promise<EmployeePin> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const employee = await this.findEmployee(scope, id);
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id }, data: { pinHash: await this.passwords.hash(pin), pinMustChange: true } });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'attendance.pin_reset', targetType: 'employee', targetId: id, metadata: { employeeName: employee.fullName }, ipAddress }, tx);
    });
    return { pin };
  }

  private async nextNumber(restaurantId: string): Promise<string> {
    const numbers = await this.prisma.employee.findMany({ where: { restaurantId }, select: { employeeNumber: true } });
    const highest = Math.max(1000, ...numbers.map((row) => Number(row.employeeNumber)).filter(Number.isFinite));
    return String(highest + 1);
  }

  private async checkAccount(scope: Scope, accountId: string, employeeId: string | null): Promise<void> {
    const account = await this.prisma.user.findFirst({ where: { id: accountId, staffRestaurantId: scope.restaurant.id }, select: { id: true, employee: { select: { id: true } } } });
    if (!account) throw fail('notFound', CODES.EMPLOYEE_NOT_FOUND, 'That staff account is not part of this restaurant.');
    if (account.employee && account.employee.id !== employeeId) throw fail('conflict', CODES.ACCOUNT_ALREADY_LINKED, 'That account is linked to another employee.');
  }

  private employeeWhere(scope: Scope): Prisma.EmployeeWhereInput {
    return { restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) };
  }

  private async findEmployee(scope: Scope, id: string): Promise<EmployeeRow> {
    const employee = await this.prisma.employee.findFirst({ where: { id, ...this.employeeWhere(scope) } });
    if (!employee) throw fail('notFound', CODES.EMPLOYEE_NOT_FOUND, 'Employee not found.');
    return employee;
  }

  private toEmployee(row: EmployeeWithLinks): Employee {
    return {
      id: row.id, employeeNumber: row.employeeNumber, fullName: row.fullName, jobTitle: row.jobTitle, phone: row.phone, branchId: row.branchId,
      branchName: row.branch.name, account: row.user ? { id: row.user.id, name: row.user.fullName, role: row.user.role } : null,
      isActive: row.isActive, hireDate: row.hireDate?.toISOString().slice(0, 10) ?? null, hasPin: row.pinHash !== null, pinMustChange: row.pinMustChange,
    };
  }

  // --- Shifts ------------------------------------------------------------------------------------

  async shifts(userId: string, query: z.output<typeof rangeQuerySchema>): Promise<Shift[]> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const rows = await this.prisma.shift.findMany({
      where: { ...(await this.rangeWhere(scope, query)), ...(query.employeeId && { employeeId: query.employeeId }) },
      orderBy: [{ day: 'asc' }, { startsAt: 'asc' }],
    });
    return rows.map((row) => this.toShift(row));
  }

  async createShifts(userId: string, input: z.output<typeof createShiftsSchema>): Promise<Shift[]> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const employees = await this.prisma.employee.findMany({ where: { id: { in: input.employeeIds }, ...this.employeeWhere(scope) } });
    if (employees.length !== new Set(input.employeeIds).size) throw fail('notFound', CODES.EMPLOYEE_NOT_FOUND, 'Employee not found.');
    const tz = scope.restaurant.timezone;
    const data = employees.flatMap((employee) => input.days.map((day) => ({
      restaurantId: scope.restaurant.id, branchId: employee.branchId, employeeId: employee.id, day: new Date(`${day}T00:00:00.000Z`),
      ...shiftInstants(day, input.start, input.end, tz), isLeave: input.isLeave, name: input.name ?? null,
    })));
    const created = await this.prisma.$transaction(data.map((row) => this.prisma.shift.create({ data: row })));
    return created.map((row) => this.toShift(row));
  }

  async deleteShift(userId: string, id: string): Promise<void> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const deleted = await this.prisma.shift.deleteMany({ where: { id, restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) } });
    if (!deleted.count) throw fail('notFound', CODES.RECORD_NOT_FOUND, 'Shift not found.');
  }

  private toShift(row: { id: string; employeeId: string; branchId: string; day: Date; startsAt: Date; endsAt: Date; name: string | null; isLeave: boolean }): Shift {
    return { id: row.id, employeeId: row.employeeId, branchId: row.branchId, day: row.day.toISOString().slice(0, 10), startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), name: row.name, isLeave: row.isLeave };
  }

  // --- Checking in and out -------------------------------------------------------------------------

  /** The employee record of a signed-in staff account. */
  private async myEmployee(userId: string): Promise<{ scope: Scope; employee: EmployeeRow }> {
    const scope = await this.scopes.resolve(userId);
    const employee = await this.prisma.employee.findUnique({ where: { userId } });
    if (!employee || employee.restaurantId !== scope.restaurant.id) throw fail('forbidden', CODES.NOT_AN_EMPLOYEE, 'This account is not set up for attendance.');
    return { scope, employee };
  }

  async portalPunch(userId: string, input: z.output<typeof portalPunchSchema>): Promise<PunchResult> {
    const { employee } = await this.myEmployee(userId);
    return this.punch({ employee, method: 'PORTAL', action: input.action, idempotencyKey: input.idempotencyKey, location: input.location ?? null });
  }

  /** A scanned branch QR: valid for the employee's own branch only; check-in or check-out as due. */
  async qrPunch(userId: string, input: z.output<typeof qrPunchSchema>): Promise<PunchResult> {
    const { employee } = await this.myEmployee(userId);
    const code = input.code.includes('c=') ? new URL(input.code, 'http://x').searchParams.get('c') ?? '' : input.code;
    const parsed = parseQrCode(code);
    const invalid = () => fail('bad', CODES.QR_INVALID, 'This QR code is not valid here.');
    if (!parsed) throw invalid();
    const { rules, branchRow } = await this.effective(employee.restaurantId, employee.branchId);
    if (parsed.kind === 'static') {
      if (rules.qrMode !== 'STATIC' || branchRow.qrStaticCode !== parsed.code) throw invalid();
    } else {
      if (rules.qrMode !== 'DYNAMIC' || parsed.policyId !== employee.branchId) throw invalid();
      const check = checkDynamicQr(parsed, branchRow.qrSecret!, rules.qrTtlSeconds);
      if (check === 'expired') throw fail('bad', CODES.QR_EXPIRED, 'This QR code has expired. Scan the one on screen now.');
      if (check !== 'valid') throw invalid();
    }
    return this.punch({ employee, method: 'QR', action: 'TOGGLE', idempotencyKey: input.idempotencyKey, location: input.location ?? null });
  }

  /**
   * Every check-in and check-out comes through here, whatever the method: the employee and method
   * are checked against the branch's rules, a repeated request (same key) returns the first answer,
   * and the session is opened or closed with its status calculated.
   */
  async punch(input: Punch, now = new Date()): Promise<PunchResult> {
    const { employee } = input;
    if (input.idempotencyKey) {
      const existing = await this.prisma.attendanceEvent.findUnique({ where: { restaurantId_idempotencyKey: { restaurantId: employee.restaurantId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return this.result(existing.type, existing.at, existing.recordId, employee, Boolean((existing.metadata as { flagged?: boolean } | null)?.flagged));
    }
    if (!employee.isActive) throw fail('forbidden', CODES.EMPLOYEE_INACTIVE, 'This employee is not active.');
    const { rules, branchRow } = await this.effective(employee.restaurantId, employee.branchId);
    if (!rules.methods.includes(input.method)) {
      throw fail('forbidden', CODES.METHOD_NOT_ALLOWED, 'This attendance method is not used at your branch.', { method: input.method, methods: rules.methods });
    }

    // Location (portal and QR), when the branch checks it.
    let flagged = false;
    let distance: number | null = null;
    if ((input.method === 'PORTAL' || input.method === 'QR') && rules.locationMode !== 'OFF' && branchRow) {
      const center = rules.latitude !== null && rules.longitude !== null ? { latitude: rules.latitude, longitude: rules.longitude } : null;
      distance = input.location && center ? distanceMeters(input.location, center) : null;
      const outside = distance === null || distance > (rules.radiusMeters ?? 0);
      if (outside && rules.locationMode === 'REJECT') throw fail('forbidden', CODES.OUTSIDE_LOCATION, 'You need to be at the branch to check in.', { distanceMeters: distance });
      flagged = outside;
    }

    const tz = (await this.prisma.restaurant.findUniqueOrThrow({ where: { id: employee.restaurantId }, select: { timezone: true } })).timezone;
    const ruleSet: Rules = rules;
    const open = await this.openRecord(employee.id, ruleSet, tz, now);
    const action = input.action === 'TOGGLE' ? (open ? 'CHECK_OUT' : 'CHECK_IN') : input.action;
    const metadata = { ...(distance !== null && { distanceMeters: distance }), ...(flagged && { flagged: true }) };

    try {
      if (action === 'CHECK_OUT') {
        if (!open) throw fail('conflict', CODES.NOT_CHECKED_IN, 'You have not checked in.');
        const recordId = await this.prisma.$transaction(async (tx) => {
          await tx.attendanceRecord.update({ where: { id: open.id }, data: { checkOutAt: now, checkOutMethod: input.method, ...(flagged && { flagged: true }) } });
          await tx.attendanceEvent.create({ data: { restaurantId: employee.restaurantId, employeeId: employee.id, recordId: open.id, type: 'CHECK_OUT', at: now, method: input.method, kioskId: input.kioskId ?? null, idempotencyKey: input.idempotencyKey ?? null, metadata } });
          return open.id;
        });
        await this.recompute(recordId, now);
        return this.result('CHECK_OUT', now, recordId, employee, flagged);
      }

      if (open) throw fail('conflict', CODES.ALREADY_CHECKED_IN, 'You are already checked in.', { since: open.checkInAt.toISOString() });
      const today = localDay(now, tz);
      const yesterday = localDay(new Date(now.getTime() - DAY), tz);
      const shifts = await this.prisma.shift.findMany({ where: { employeeId: employee.id, day: { in: [new Date(`${yesterday}T00:00:00.000Z`), new Date(`${today}T00:00:00.000Z`)] } } });
      // In a shift's window: that shift. Before it opens or with only other shifts today: "outside the
      // shift" (allowOutsideShift). No shift at all today: "without a shift" (allowWithoutShift).
      const match = matchShift(shifts, now, ruleSet);
      const hasShiftsToday = shifts.some((row) => !row.isLeave && row.day.getTime() === new Date(`${today}T00:00:00.000Z`).getTime());
      let shift: ShiftWindow | null = null;
      if (match && !match.early) shift = match.shift;
      else if (match?.early) {
        if (!rules.allowOutsideShift) throw fail('conflict', CODES.TOO_EARLY, 'Your shift has not opened yet.', { opensAt: new Date(match.shift.startsAt.getTime() - rules.earlyCheckInMinutes * MINUTE).toISOString() });
        shift = match.shift;
      } else if (hasShiftsToday ? !rules.allowOutsideShift : !rules.allowWithoutShift) {
        throw fail('conflict', CODES.NO_SHIFT, 'You have no shift now.');
      }
      if (!rules.allowMultipleShifts) {
        const done = await this.prisma.attendanceRecord.count({
          where: { employeeId: employee.id, ...(shift ? { shiftId: shift.id } : { day: new Date(`${today}T00:00:00.000Z`), shiftId: null }) },
        });
        if (done) throw fail('conflict', CODES.SHIFT_DONE, 'Your attendance for this shift is already complete.');
      }
      const day = shift ? (shifts.find((row) => row.id === shift!.id)!.day) : new Date(`${today}T00:00:00.000Z`);
      const recordId = await this.prisma.$transaction(async (tx) => {
        const record = await tx.attendanceRecord.create({
          data: {
            restaurantId: employee.restaurantId, branchId: employee.branchId, employeeId: employee.id, shiftId: shift?.id ?? null, day, checkInAt: now,
            checkInMethod: input.method, kioskId: input.kioskId ?? null, flagged,
          },
        });
        await tx.attendanceEvent.create({ data: { restaurantId: employee.restaurantId, employeeId: employee.id, recordId: record.id, type: 'CHECK_IN', at: now, method: input.method, kioskId: input.kioskId ?? null, idempotencyKey: input.idempotencyKey ?? null, metadata } });
        return record.id;
      });
      await this.recompute(recordId, now);
      return this.result('CHECK_IN', now, recordId, employee, flagged);
    } catch (error) {
      // The same request twice at once: answer with the one that was recorded.
      if (!isUniqueViolation(error) || !input.idempotencyKey) throw error;
      const existing = await this.prisma.attendanceEvent.findUniqueOrThrow({ where: { restaurantId_idempotencyKey: { restaurantId: employee.restaurantId, idempotencyKey: input.idempotencyKey } } });
      return this.result(existing.type, existing.at, existing.recordId, employee, flagged);
    }
  }

  /** The employee's session still open for checking out (not one left open past its deadline, which stays incomplete). */
  private async openRecord(employeeId: string, rules: Rules, tz: string, now: Date) {
    const open = await this.prisma.attendanceRecord.findFirst({ where: { employeeId, checkOutAt: null }, orderBy: { checkInAt: 'desc' }, include: { shift: true } });
    if (!open) return null;
    const deadline = open.shift ? new Date(open.shift.endsAt.getTime() + rules.lateCheckOutMinutes * MINUTE) : this.dayEnd(open.day.toISOString().slice(0, 10), tz);
    return now > deadline ? null : open;
  }

  private dayEnd(day: string, tz: string): Date {
    return new Date(zonedInstant(day, '23:59', tz).getTime() + MINUTE);
  }

  private async result(type: 'CHECK_IN' | 'CHECK_OUT', at: Date, recordId: string, employee: EmployeeRow, flagged: boolean): Promise<PunchResult> {
    const record = await this.prisma.attendanceRecord.findUniqueOrThrow({ where: { id: recordId }, include: recordInclude });
    const fresh = await this.prisma.employee.findUniqueOrThrow({ where: { id: employee.id }, select: { pinMustChange: true, pinHash: true } });
    return { action: type, at: at.toISOString(), employeeName: employee.fullName, record: await this.toRecord(record), flagged, mustChangePin: fresh.pinHash !== null && fresh.pinMustChange };
  }

  /** Recalculates a session's figures and status from its times, shift and rules (a pending correction shows as such). */
  private async recompute(recordId: string, now = new Date(), client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<void> {
    const record = await client.attendanceRecord.findUniqueOrThrow({ where: { id: recordId }, include: { shift: true, restaurant: { select: { timezone: true } } } });
    const { rules } = await this.effective(record.restaurantId, record.branchId);
    const computed = computeRecord({
      checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, shift: record.shift, rules, now,
      dayEndsAt: this.dayEnd(record.day.toISOString().slice(0, 10), record.restaurant.timezone),
    });
    const pending = await client.attendanceCorrection.count({ where: { recordId, status: 'PENDING' } });
    await client.attendanceRecord.update({ where: { id: recordId }, data: { ...computed, ...(pending && { status: 'PENDING_CORRECTION' }) } });
  }

  // --- The employee's own page ---------------------------------------------------------------------

  async me(userId: string, now = new Date()): Promise<MyAttendance> {
    const { scope, employee } = await this.myEmployee(userId);
    const { rules } = await this.effective(employee.restaurantId, employee.branchId);
    const tz = scope.restaurant.timezone;
    const today = new Date(`${localDay(now, tz)}T00:00:00.000Z`);
    const [branch, open, shifts, recent] = await Promise.all([
      this.prisma.branch.findUniqueOrThrow({ where: { id: employee.branchId }, select: { name: true } }),
      this.openRecord(employee.id, rules, tz, now),
      this.prisma.shift.findMany({ where: { employeeId: employee.id, day: { gte: today, lt: new Date(today.getTime() + 8 * DAY) } }, orderBy: { startsAt: 'asc' } }),
      this.prisma.attendanceRecord.findMany({ where: { employeeId: employee.id }, include: recordInclude, orderBy: { checkInAt: 'desc' }, take: 30 }),
    ]);
    const openRow = open ? recent.find((row) => row.id === open.id) ?? await this.prisma.attendanceRecord.findUniqueOrThrow({ where: { id: open.id }, include: recordInclude }) : null;
    return {
      employee: { id: employee.id, fullName: employee.fullName, employeeNumber: employee.employeeNumber, branchName: branch.name, pinMustChange: employee.pinMustChange, hasPin: employee.pinHash !== null },
      methods: rules.methods,
      primaryMethod: rules.primaryMethod,
      locationRequired: rules.locationMode !== 'OFF',
      correctionsEnabled: rules.correctionsEnabled,
      open: openRow ? await this.toRecord(openRow) : null,
      todayShifts: shifts.filter((shift) => shift.day.getTime() === today.getTime()).map((row) => this.toShift(row)),
      upcomingShifts: shifts.filter((shift) => shift.day.getTime() > today.getTime()).map((row) => this.toShift(row)),
      recent: await Promise.all(recent.map((row) => this.toRecord(row))),
    };
  }

  async changeMyPin(userId: string, pin: string): Promise<void> {
    const { employee } = await this.myEmployee(userId);
    await this.prisma.employee.update({ where: { id: employee.id }, data: { pinHash: await this.passwords.hash(pin), pinMustChange: false } });
  }

  async requestCorrection(userId: string, input: z.output<typeof createCorrectionSchema>): Promise<AttendanceCorrection> {
    const { employee } = await this.myEmployee(userId);
    const { rules } = await this.effective(employee.restaurantId, employee.branchId);
    if (!rules.correctionsEnabled) throw fail('forbidden', CODES.CORRECTIONS_DISABLED, 'Corrections are turned off at your branch.');
    if (input.recordId) {
      const record = await this.prisma.attendanceRecord.findFirst({ where: { id: input.recordId, employeeId: employee.id } });
      if (!record) throw fail('notFound', CODES.RECORD_NOT_FOUND, 'Attendance record not found.');
    }
    const row = await this.prisma.attendanceCorrection.create({
      data: {
        restaurantId: employee.restaurantId, employeeId: employee.id, recordId: input.recordId ?? null, day: new Date(`${input.day}T00:00:00.000Z`),
        requestedCheckIn: input.requestedCheckIn ? new Date(input.requestedCheckIn) : null, requestedCheckOut: input.requestedCheckOut ? new Date(input.requestedCheckOut) : null,
        reason: input.reason,
      },
    });
    if (row.recordId) await this.recompute(row.recordId);
    return this.correction(row.id);
  }

  async myCorrections(userId: string): Promise<AttendanceCorrection[]> {
    const { employee } = await this.myEmployee(userId);
    const rows = await this.prisma.attendanceCorrection.findMany({ where: { employeeId: employee.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
    return Promise.all(rows.map((row) => this.correction(row.id)));
  }

  // --- Records, overview, reports --------------------------------------------------------------

  async records(userId: string, query: z.output<typeof recordsQuerySchema>): Promise<Paginated<AttendanceRecord>> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const where: Prisma.AttendanceRecordWhereInput = {
      ...(await this.rangeWhere(scope, query)),
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...(query.status && query.status !== 'INCOMPLETE' && { status: query.status }),
      ...(query.status === 'INCOMPLETE' && { checkOutAt: null }),
      ...(query.method && { OR: [{ checkInMethod: query.method }, { checkOutMethod: query.method }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({ where, include: recordInclude, orderBy: { checkInAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    const items = await Promise.all(rows.map((row) => this.toRecord(row)));
    return { items: query.status === 'INCOMPLETE' ? items.filter((item) => item.status === 'INCOMPLETE') : items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Every record in the range (exports), newest first. */
  async allRecords(userId: string, query: z.output<typeof rangeQuerySchema> & { status?: string; method?: string }): Promise<AttendanceRecord[]> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(await this.rangeWhere(scope, query)), ...(query.employeeId && { employeeId: query.employeeId }),
        ...(query.method && { OR: [{ checkInMethod: query.method as AttendanceMethod }, { checkOutMethod: query.method as AttendanceMethod }] }),
      },
      include: recordInclude, orderBy: { checkInAt: 'desc' }, take: 20_000,
    });
    const items = await Promise.all(rows.map((row) => this.toRecord(row)));
    return query.status ? items.filter((item) => item.status === query.status) : items;
  }

  async overview(userId: string, date: string | undefined, branchId: string | undefined, now = new Date()): Promise<AttendanceOverview> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const day = date ?? localDay(now, scope.restaurant.timezone);
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const where = await this.scopes.branchWhere(scope, branchId);
    const [employees, shifts, records, pendingCorrections] = await Promise.all([
      this.prisma.employee.findMany({ where: { ...where, isActive: true }, include: { branch: { select: { name: true } } }, orderBy: { fullName: 'asc' } }),
      this.prisma.shift.findMany({ where: { ...where, day: dayDate }, orderBy: { startsAt: 'asc' } }),
      this.prisma.attendanceRecord.findMany({ where: { ...where, day: dayDate }, include: recordInclude, orderBy: { checkInAt: 'asc' } }),
      this.prisma.attendanceCorrection.count({ where: { restaurantId: scope.restaurant.id, status: 'PENDING', ...(where.branchId && { employee: { branchId: where.branchId } }) } }),
    ]);
    const policies = new Map<string, Rules>();
    const rulesFor = async (id: string) => policies.get(id) ?? (policies.set(id, (await this.effective(scope.restaurant.id, id)).rules), policies.get(id)!);
    const rows: AttendanceOverviewRow[] = [];
    for (const employee of employees) {
      const mine = shifts.filter((shift) => shift.employeeId === employee.id);
      const sessions = await Promise.all(records.filter((record) => record.employeeId === employee.id).map((record) => this.toRecord(record, now)));
      const rules = await rulesFor(employee.branchId);
      let state: AttendanceOverviewRow['state'] = 'NOT_SCHEDULED';
      if (sessions.some((session) => !session.checkOutAt && session.status !== 'INCOMPLETE')) state = 'WORKING';
      else if (sessions.length) state = sessions.find((session) => session.status !== 'PRESENT')?.status ?? 'PRESENT';
      else if (mine.some((shift) => shift.isLeave)) state = 'ON_LEAVE';
      else if (mine.length) state = mine.some((shift) => now.getTime() > shift.startsAt.getTime() + rules.graceMinutes * MINUTE) ? 'ABSENT' : 'UPCOMING';
      if (state === 'NOT_SCHEDULED' && !mine.length && !sessions.length) continue;
      rows.push({
        employee: { id: employee.id, fullName: employee.fullName, employeeNumber: employee.employeeNumber, jobTitle: employee.jobTitle, branchName: employee.branch.name },
        shifts: mine.map((shift) => this.toShift(shift)), records: sessions, state,
      });
    }
    const count = (test: (row: AttendanceOverviewRow) => boolean) => rows.filter(test).length;
    return {
      date: day,
      totals: {
        scheduled: count((row) => row.shifts.some((shift) => !shift.isLeave)),
        present: count((row) => row.records.length > 0),
        absent: count((row) => row.state === 'ABSENT'),
        late: count((row) => row.records.some((record) => record.lateMinutes > 0)),
        working: count((row) => row.state === 'WORKING'),
        incomplete: count((row) => row.records.some((record) => record.status === 'INCOMPLETE')),
        onLeave: count((row) => row.state === 'ON_LEAVE'),
        overtime: count((row) => row.records.some((record) => record.overtimeMinutes > 0)),
      },
      rows,
      pendingCorrections,
    };
  }

  /** Per employee over the period: shifts, presence, lateness, absences, leave, hours and overtime. */
  async summary(userId: string, query: z.output<typeof rangeQuerySchema>, now = new Date()): Promise<AttendanceSummaryRow[]> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const where = await this.rangeWhere(scope, query);
    const [employees, shifts, records] = await Promise.all([
      this.prisma.employee.findMany({ where: { ...this.employeeWhere(scope), ...(where.branchId && { branchId: where.branchId as string }), ...(query.employeeId && { id: query.employeeId }) }, include: { branch: { select: { name: true } } }, orderBy: { fullName: 'asc' } }),
      this.prisma.shift.findMany({ where }),
      this.prisma.attendanceRecord.findMany({ where, include: recordInclude }),
    ]);
    const live = await Promise.all(records.map((record) => this.toRecord(record, now)));
    return employees.map((employee) => {
      const mine = live.filter((record) => record.employee.id === employee.id);
      const working = shifts.filter((shift) => shift.employeeId === employee.id && !shift.isLeave);
      const absences = working.filter((shift) => shift.endsAt < now && !mine.some((record) => record.shift?.id === shift.id || (!record.shift && record.day === shift.day.toISOString().slice(0, 10)))).length;
      return {
        employee: { id: employee.id, fullName: employee.fullName, employeeNumber: employee.employeeNumber, branchName: employee.branch.name },
        scheduledShifts: working.length,
        daysPresent: new Set(mine.map((record) => record.day)).size,
        lateCount: mine.filter((record) => record.lateMinutes > 0).length,
        lateMinutes: mine.reduce((sum, record) => sum + record.lateMinutes, 0),
        absences,
        incomplete: mine.filter((record) => record.status === 'INCOMPLETE').length,
        leaveDays: shifts.filter((shift) => shift.employeeId === employee.id && shift.isLeave).length,
        workedMinutes: mine.reduce((sum, record) => sum + record.workedMinutes, 0),
        overtimeMinutes: mine.reduce((sum, record) => sum + record.overtimeMinutes, 0),
      };
    }).filter((row) => row.scheduledShifts || row.daysPresent || row.leaveDays);
  }

  // --- Manual attendance and corrections ---------------------------------------------------------

  /** A manager records a session; under the approval rule, a manager without approval rights files it as a correction. */
  async manual(userId: string, input: z.output<typeof manualRecordSchema>, ipAddress?: string): Promise<ManualAttendanceResult> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const employee = await this.findEmployee(scope, input.employeeId);
    const checkInAt = new Date(input.checkInAt);
    const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;
    this.checkTimes(checkInAt, checkOutAt);
    const { rules } = await this.effective(employee.restaurantId, employee.branchId);
    const day = localDay(checkInAt, scope.restaurant.timezone);
    if (rules.manualNeedsApproval && !scope.permissions.has('attendance.approve')) {
      const correction = await this.prisma.attendanceCorrection.create({
        data: { restaurantId: employee.restaurantId, employeeId: employee.id, day: new Date(`${day}T00:00:00.000Z`), requestedCheckIn: checkInAt, requestedCheckOut: checkOutAt, reason: input.reason },
      });
      return { record: null, pendingCorrection: await this.correction(correction.id) };
    }
    const recordId = await this.prisma.$transaction(async (tx) => {
      const id = await this.createManualRecord(tx, employee, day, checkInAt, checkOutAt);
      await this.audit.record({
        actorId: userId, restaurantId: employee.restaurantId, action: 'attendance.manual', targetType: 'attendance', targetId: id,
        metadata: { employeeName: employee.fullName, branchId: employee.branchId, to: this.span(checkInAt, checkOutAt), reason: input.reason, source: 'MANUAL' }, ipAddress,
      }, tx);
      return id;
    });
    await this.recompute(recordId);
    return { record: await this.recordById(recordId), pendingCorrection: null };
  }

  /** Edits a session's times or note; the previous values go to the audit log, never silently. */
  async updateRecord(userId: string, id: string, input: z.output<typeof updateRecordSchema>, ipAddress?: string): Promise<ManualAttendanceResult> {
    const scope = await this.scopeWith(userId, 'attendance.manage');
    const current = await this.prisma.attendanceRecord.findFirst({ where: { id, restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) }, include: { employee: true } });
    if (!current) throw fail('notFound', CODES.RECORD_NOT_FOUND, 'Attendance record not found.');
    const checkInAt = input.checkInAt ? new Date(input.checkInAt) : current.checkInAt;
    const checkOutAt = input.checkOutAt === undefined ? current.checkOutAt : input.checkOutAt ? new Date(input.checkOutAt) : null;
    const timesChanged = checkInAt.getTime() !== current.checkInAt.getTime() || (checkOutAt?.getTime() ?? null) !== (current.checkOutAt?.getTime() ?? null);
    if (timesChanged) this.checkTimes(checkInAt, checkOutAt);
    const { rules } = await this.effective(current.restaurantId, current.branchId);
    if (timesChanged && rules.manualNeedsApproval && !scope.permissions.has('attendance.approve')) {
      const correction = await this.prisma.attendanceCorrection.create({
        data: { restaurantId: current.restaurantId, employeeId: current.employeeId, recordId: id, day: current.day, requestedCheckIn: checkInAt, requestedCheckOut: checkOutAt, reason: input.reason },
      });
      await this.recompute(id);
      return { record: await this.recordById(id), pendingCorrection: await this.correction(correction.id) };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.attendanceRecord.update({
        where: { id },
        data: {
          ...(timesChanged && { checkInAt, checkOutAt, ...(checkOutAt && !current.checkOutAt && { checkOutMethod: 'MANUAL' }) }),
          ...(input.managerNote !== undefined && { managerNote: input.managerNote }),
        },
      });
      await this.audit.record({
        actorId: userId, restaurantId: current.restaurantId, action: timesChanged ? 'attendance.edited' : 'attendance.note', targetType: 'attendance', targetId: id,
        metadata: {
          employeeName: current.employee.fullName, branchId: current.branchId, reason: input.reason, source: 'MANUAL',
          ...(timesChanged && { from: this.span(current.checkInAt, current.checkOutAt), to: this.span(checkInAt, checkOutAt) }),
          ...(input.managerNote !== undefined && { note: input.managerNote }),
        },
        ipAddress,
      }, tx);
    });
    await this.recompute(id);
    return { record: await this.recordById(id), pendingCorrection: null };
  }

  async corrections(userId: string, query: z.output<typeof correctionsQuerySchema>): Promise<AttendanceCorrection[]> {
    const scope = await this.scopeWith(userId, 'attendance.view');
    const branchId = scope.fixedBranchId ?? query.branchId;
    const rows = await this.prisma.attendanceCorrection.findMany({
      where: { restaurantId: scope.restaurant.id, ...(query.status && { status: query.status }), ...(branchId && { employee: { branchId } }) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200, select: { id: true },
    });
    return Promise.all(rows.map((row) => this.correction(row.id)));
  }

  async reviewCorrection(userId: string, id: string, approve: boolean, note: string | null | undefined, ipAddress?: string): Promise<AttendanceCorrection> {
    const scope = await this.scopeWith(userId, 'attendance.approve');
    const correction = await this.prisma.attendanceCorrection.findFirst({
      where: { id, restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { employee: { branchId: scope.fixedBranchId } }) },
      include: { employee: true, record: true },
    });
    if (!correction) throw fail('notFound', CODES.RECORD_NOT_FOUND, 'Correction not found.');
    if (correction.status !== 'PENDING') throw fail('conflict', CODES.CORRECTION_ALREADY_REVIEWED, 'This request was already reviewed.');
    const now = new Date();
    const recordId = await this.prisma.$transaction(async (tx) => {
      let recordId = correction.recordId;
      let from: string | null = null;
      if (approve) {
        if (correction.record) {
          from = this.span(correction.record.checkInAt, correction.record.checkOutAt);
          const checkInAt = correction.requestedCheckIn ?? correction.record.checkInAt;
          const checkOutAt = correction.requestedCheckOut ?? correction.record.checkOutAt;
          this.checkTimes(checkInAt, checkOutAt);
          await tx.attendanceRecord.update({ where: { id: correction.record.id }, data: { checkInAt, checkOutAt, ...(correction.requestedCheckOut && !correction.record.checkOutAt && { checkOutMethod: 'MANUAL' }) } });
        } else {
          if (!correction.requestedCheckIn) throw fail('bad', CODES.RECORD_NOT_FOUND, 'A new session needs a check-in time.');
          this.checkTimes(correction.requestedCheckIn, correction.requestedCheckOut);
          recordId = await this.createManualRecord(tx, correction.employee, correction.day.toISOString().slice(0, 10), correction.requestedCheckIn, correction.requestedCheckOut);
          await tx.attendanceCorrection.update({ where: { id }, data: { recordId } });
        }
      }
      await tx.attendanceCorrection.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedById: userId, reviewedAt: now, reviewNote: note ?? null } });
      await this.audit.record({
        actorId: userId, restaurantId: correction.restaurantId, action: approve ? 'attendance.correction_approved' : 'attendance.correction_rejected', targetType: 'attendance', targetId: recordId,
        metadata: {
          employeeName: correction.employee.fullName, branchId: correction.employee.branchId, reason: correction.reason, note: note ?? null, source: 'CORRECTION',
          ...(approve && { from, to: this.span(correction.requestedCheckIn ?? correction.record?.checkInAt ?? null, correction.requestedCheckOut ?? correction.record?.checkOutAt ?? null) }),
        },
        ipAddress,
      }, tx);
      return recordId;
    });
    if (recordId) await this.recompute(recordId);
    return this.correction(id);
  }

  private async createManualRecord(tx: Prisma.TransactionClient, employee: EmployeeRow, day: string, checkInAt: Date, checkOutAt: Date | null): Promise<string> {
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const shifts = await tx.shift.findMany({ where: { employeeId: employee.id, day: dayDate, isLeave: false } });
    // The shift it overlaps most, if any.
    const shift = shifts.sort((a, b) => Math.abs(a.startsAt.getTime() - checkInAt.getTime()) - Math.abs(b.startsAt.getTime() - checkInAt.getTime()))[0] ?? null;
    const record = await tx.attendanceRecord.create({
      data: { restaurantId: employee.restaurantId, branchId: employee.branchId, employeeId: employee.id, shiftId: shift?.id ?? null, day: dayDate, checkInAt, checkOutAt, checkInMethod: 'MANUAL', checkOutMethod: checkOutAt ? 'MANUAL' : null },
    });
    await tx.attendanceEvent.create({ data: { restaurantId: employee.restaurantId, employeeId: employee.id, recordId: record.id, type: 'CHECK_IN', at: checkInAt, method: 'MANUAL' } });
    if (checkOutAt) await tx.attendanceEvent.create({ data: { restaurantId: employee.restaurantId, employeeId: employee.id, recordId: record.id, type: 'CHECK_OUT', at: checkOutAt, method: 'MANUAL' } });
    return record.id;
  }

  private checkTimes(checkInAt: Date, checkOutAt: Date | null): void {
    if (checkOutAt && checkOutAt <= checkInAt) throw fail('bad', CODES.RECORD_NOT_FOUND, 'Check-out must be after check-in.');
    if (checkInAt.getTime() > Date.now() + 5 * MINUTE || (checkOutAt && checkOutAt.getTime() > Date.now() + 5 * MINUTE)) throw fail('bad', CODES.RECORD_NOT_FOUND, 'Times cannot be in the future.');
  }

  private span(checkInAt: Date | null, checkOutAt: Date | null): string {
    return `${checkInAt?.toISOString() ?? '—'} → ${checkOutAt?.toISOString() ?? '—'}`;
  }

  // --- Helpers -----------------------------------------------------------------------------------

  private async scopeWith(userId: string, permission: Parameters<BranchScopeService['require']>[1]): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, permission);
    return scope;
  }

  /** Rows of the range, in the caller's restaurant and branch (a requested branch is checked). */
  private async rangeWhere(scope: Scope, query: { from: string; to: string; branchId?: string }): Promise<{ restaurantId: string; branchId?: string; day: { gte: Date; lte: Date } }> {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T00:00:00.000Z`);
    if (to < from || to.getTime() - from.getTime() > ATTENDANCE_LIMITS.rangeDays * DAY) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Choose a range of up to ${ATTENDANCE_LIMITS.rangeDays} days.` });
    }
    return { ...(await this.scopes.branchWhere(scope, query.branchId)), day: { gte: from, lte: to } };
  }

  private async recordById(id: string): Promise<AttendanceRecord> {
    return this.toRecord(await this.prisma.attendanceRecord.findUniqueOrThrow({ where: { id }, include: recordInclude }));
  }

  /** A record as shown, with an open session's status as of now (it turns incomplete once past its deadline). */
  private async toRecord(row: RecordRow, now = new Date()): Promise<AttendanceRecord> {
    let status = row.status;
    if (!row.checkOutAt && status !== 'PENDING_CORRECTION') {
      const { rules } = await this.effective(row.restaurantId, row.branchId);
      const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: row.restaurantId }, select: { timezone: true } });
      status = computeRecord({ checkInAt: row.checkInAt, checkOutAt: null, shift: row.shift, rules, now, dayEndsAt: this.dayEnd(row.day.toISOString().slice(0, 10), restaurant.timezone) }).status;
      if (status !== 'INCOMPLETE') status = row.lateMinutes ? 'LATE' : 'PRESENT';
    }
    return {
      id: row.id,
      employee: { id: row.employee.id, fullName: row.employee.fullName, employeeNumber: row.employee.employeeNumber, jobTitle: row.employee.jobTitle },
      branchId: row.branchId, branchName: row.branch.name, day: row.day.toISOString().slice(0, 10),
      shift: row.shift ? { id: row.shift.id, startsAt: row.shift.startsAt.toISOString(), endsAt: row.shift.endsAt.toISOString(), name: row.shift.name } : null,
      checkInAt: row.checkInAt.toISOString(), checkOutAt: row.checkOutAt?.toISOString() ?? null, status,
      workedMinutes: row.workedMinutes, lateMinutes: row.lateMinutes, earlyLeaveMinutes: row.earlyLeaveMinutes, overtimeMinutes: row.overtimeMinutes,
      checkInMethod: row.checkInMethod, checkOutMethod: row.checkOutMethod, kioskName: row.kiosk?.name ?? null, flagged: row.flagged, managerNote: row.managerNote,
    };
  }

  private async correction(id: string): Promise<AttendanceCorrection> {
    const row = await this.prisma.attendanceCorrection.findUniqueOrThrow({
      where: { id },
      include: { employee: { include: { branch: { select: { name: true } } } }, record: true, reviewedBy: { select: { fullName: true } } },
    });
    return {
      id: row.id,
      employee: { id: row.employee.id, fullName: row.employee.fullName, employeeNumber: row.employee.employeeNumber, branchName: row.employee.branch.name },
      day: row.day.toISOString().slice(0, 10), recordId: row.recordId,
      current: row.record ? { checkInAt: row.record.checkInAt.toISOString(), checkOutAt: row.record.checkOutAt?.toISOString() ?? null } : null,
      requestedCheckIn: row.requestedCheckIn?.toISOString() ?? null, requestedCheckOut: row.requestedCheckOut?.toISOString() ?? null,
      reason: row.reason, status: row.status, reviewedBy: row.reviewedBy?.fullName ?? null, reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote, createdAt: row.createdAt.toISOString(),
    };
  }
}
