import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  ATTENDANCE_ERROR_CODES as CODES,
  ATTENDANCE_LIMITS,
  type AttendanceKiosk,
  type createKioskSchema,
  type KioskActivation,
  type KioskActivationCode,
  type kioskChangePinSchema,
  type kioskPunchSchema,
  type KioskState,
  type PunchResult,
  SERVICE_ERROR_CODES,
} from '@bilhanah/contracts';
import type { AttendanceKiosk as KioskRow, Employee as EmployeeRow } from '@bilhanah/database';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { readServiceStates } from '../services/service-states.js';
import { AttendanceService } from './attendance.service.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unauthorized = () => new UnauthorizedException({ code: CODES.KIOSK_UNAUTHORIZED, message: 'This kiosk is not activated.' });
const notFound = () => new NotFoundException({ code: CODES.RECORD_NOT_FOUND, message: 'Kiosk not found.' });

/**
 * Shared branch screens for PIN attendance. A manager creates a kiosk and gets a one-time six-digit
 * code; typing it on the screen gives the screen its own long-lived token (stored hashed here). The
 * screen then only does attendance for its branch: employee number + PIN, with wrong PINs counted
 * per kiosk and per employee number, and a temporary lock after too many.
 */
@Injectable()
export class AttendanceKioskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly attendance: AttendanceService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // --- Managing kiosks -------------------------------------------------------------------------------

  async list(userId: string): Promise<AttendanceKiosk[]> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.manage');
    const rows = await this.prisma.attendanceKiosk.findMany({
      where: { restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) },
      include: { branch: { select: { name: true } } }, orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toKiosk(row));
  }

  async create(userId: string, input: z.output<typeof createKioskSchema>, ipAddress?: string): Promise<{ kiosk: AttendanceKiosk; activation: KioskActivationCode }> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.manage');
    await this.scopes.branch(scope, input.branchId);
    const { code, hash, expiresAt } = this.newCode();
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.attendanceKiosk.create({
        data: { restaurantId: scope.restaurant.id, branchId: input.branchId, name: input.name, activationCodeHash: hash, activationExpiresAt: expiresAt },
        include: { branch: { select: { name: true } } },
      });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'attendance.kiosk_created', targetType: 'attendance-kiosk', targetId: created.id, metadata: { kioskName: input.name, branchId: input.branchId }, ipAddress }, tx);
      return created;
    });
    return { kiosk: this.toKiosk(row), activation: { code, expiresAt: expiresAt.toISOString() } };
  }

  /** A new one-time code (moving the kiosk to another screen signs the old one out). */
  async newActivationCode(userId: string, id: string): Promise<KioskActivationCode> {
    const kiosk = await this.findManaged(userId, id);
    const { code, hash, expiresAt } = this.newCode();
    await this.prisma.attendanceKiosk.update({ where: { id: kiosk.id }, data: { activationCodeHash: hash, activationExpiresAt: expiresAt, tokenHash: null, activatedAt: null, disabledAt: null } });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async setDisabled(userId: string, id: string, disabled: boolean, ipAddress?: string): Promise<AttendanceKiosk> {
    const kiosk = await this.findManaged(userId, id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.attendanceKiosk.update({
        where: { id: kiosk.id }, data: { disabledAt: disabled ? new Date() : null, ...(disabled && { tokenHash: null, activationCodeHash: null }) },
        include: { branch: { select: { name: true } } },
      });
      await this.audit.record({ actorId: userId, restaurantId: kiosk.restaurantId, action: disabled ? 'attendance.kiosk_disabled' : 'attendance.kiosk_enabled', targetType: 'attendance-kiosk', targetId: kiosk.id, metadata: { kioskName: kiosk.name, branchId: kiosk.branchId }, ipAddress }, tx);
      return updated;
    });
    return this.toKiosk(row);
  }

  private async findManaged(userId: string, id: string): Promise<KioskRow> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'attendance.manage');
    const kiosk = await this.prisma.attendanceKiosk.findFirst({ where: { id, restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) } });
    if (!kiosk) throw notFound();
    return kiosk;
  }

  private newCode() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { code, hash: sha256(code), expiresAt: new Date(Date.now() + ATTENDANCE_LIMITS.kioskCodeMinutes * 60_000) };
  }

  private toKiosk(row: KioskRow & { branch: { name: string } }): AttendanceKiosk {
    return { id: row.id, name: row.name, branchId: row.branchId, branchName: row.branch.name, activated: row.tokenHash !== null, disabled: row.disabledAt !== null, lastSeenAt: row.lastSeenAt?.toISOString() ?? null };
  }

  // --- The kiosk screen ---------------------------------------------------------------------------

  async activate(code: string): Promise<KioskActivation> {
    const kiosk = await this.prisma.attendanceKiosk.findFirst({ where: { activationCodeHash: sha256(code), activationExpiresAt: { gt: new Date() }, disabledAt: null } });
    if (!kiosk) throw new HttpException({ code: CODES.KIOSK_CODE_INVALID, message: 'This code is wrong or has expired.' }, HttpStatus.BAD_REQUEST);
    const token = randomBytes(32).toString('base64url');
    await this.prisma.attendanceKiosk.update({ where: { id: kiosk.id }, data: { tokenHash: sha256(token), activatedAt: new Date(), activationCodeHash: null, activationExpiresAt: null, lastSeenAt: new Date() } });
    return { token, state: await this.state(token) };
  }

  /** The kiosk behind a token (refused when unknown or disabled). */
  async kiosk(token: string | undefined): Promise<KioskRow> {
    if (!token || token.length > 100) throw unauthorized();
    const kiosk = await this.prisma.attendanceKiosk.findUnique({ where: { tokenHash: sha256(token) } });
    if (!kiosk || kiosk.disabledAt) throw unauthorized();
    // A restaurant that switched attendance off keeps its kiosks, but they stop taking punches.
    if (!(await readServiceStates(this.prisma, kiosk.restaurantId)).ATTENDANCE) {
      throw new ConflictException({ code: SERVICE_ERROR_CODES.SERVICE_INACTIVE, message: 'Attendance is switched off for this restaurant.', details: { service: 'ATTENDANCE' } });
    }
    // Seen at most once a minute, to keep writes down.
    if (!kiosk.lastSeenAt || Date.now() - kiosk.lastSeenAt.getTime() > 60_000) {
      await this.prisma.attendanceKiosk.update({ where: { id: kiosk.id }, data: { lastSeenAt: new Date() } });
    }
    return kiosk;
  }

  async state(token: string | undefined): Promise<KioskState> {
    const kiosk = await this.kiosk(token);
    const [branch, restaurant, { rules }] = await Promise.all([
      this.prisma.branch.findUniqueOrThrow({ where: { id: kiosk.branchId }, select: { name: true } }),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: kiosk.restaurantId }, select: { name: true } }),
      this.attendance.effective(kiosk.restaurantId, kiosk.branchId),
    ]);
    return {
      kiosk: { name: kiosk.name, branchName: branch.name, restaurantName: restaurant.name },
      methods: rules.methods,
      qr: await this.attendance.currentQr(kiosk.restaurantId, kiosk.branchId),
    };
  }

  async punch(token: string | undefined, input: z.output<typeof kioskPunchSchema>): Promise<PunchResult> {
    const kiosk = await this.kiosk(token);
    const employee = await this.verifyPin(kiosk, input.employeeNumber, input.pin);
    return this.attendance.punch({ employee, method: 'KIOSK', action: 'TOGGLE', idempotencyKey: input.idempotencyKey, kioskId: kiosk.id });
  }

  async changePin(token: string | undefined, input: z.output<typeof kioskChangePinSchema>): Promise<void> {
    const kiosk = await this.kiosk(token);
    const employee = await this.verifyPin(kiosk, input.employeeNumber, input.pin);
    await this.prisma.employee.update({ where: { id: employee.id }, data: { pinHash: await this.passwords.hash(input.newPin), pinMustChange: false } });
  }

  /**
   * The employee of this kiosk's branch with that number and PIN. A wrong number and a wrong PIN get
   * the same answer (and take as long); repeated failures lock the kiosk and the number for a while.
   */
  private async verifyPin(kiosk: KioskRow, employeeNumber: string, pin: string): Promise<EmployeeRow> {
    const keys = [`att:pin:kiosk:${kiosk.id}`, `att:pin:emp:${kiosk.restaurantId}:${employeeNumber.toLowerCase()}`];
    const counts = await this.redis.mget(...keys);
    if (counts.some((value) => Number(value ?? 0) >= ATTENDANCE_LIMITS.pinAttempts)) {
      const ttl = Math.max(...await Promise.all(keys.map((key) => this.redis.ttl(key))));
      throw new HttpException({ code: CODES.KIOSK_LOCKED, message: 'Too many wrong PINs. Try again in a few minutes.', details: { retryAfterSeconds: Math.max(ttl, 1) } }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const employee = await this.prisma.employee.findUnique({ where: { restaurantId_employeeNumber: { restaurantId: kiosk.restaurantId, employeeNumber } } });
    const ok = await this.passwords.verify(employee?.pinHash ?? undefined, pin);
    if (!employee || !ok || employee.branchId !== kiosk.branchId) {
      const pipeline = this.redis.multi();
      for (const key of keys) pipeline.incr(key).expire(key, ATTENDANCE_LIMITS.pinLockSeconds);
      await pipeline.exec();
      throw new UnauthorizedException({ code: CODES.PIN_INVALID, message: 'Wrong employee number or PIN.' });
    }
    await this.redis.del(keys[1]!);
    return employee;
  }
}
