import { ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  effectivePermissions, POS_DEVICE_ERROR_CODES, POS_PIN_ERROR_CODES, POS_PIN_POLICY, STAFF_ROLES, type PosDeviceInfo, type PosPinStaff,
} from '@bilhanah/contracts';
import type { PosDevice as DeviceRow } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService, type ClientMeta, type IssuedSession } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { PosAccessService } from './pos-access.service.js';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const invalidPin = () => new UnauthorizedException({ code: POS_PIN_ERROR_CODES.POS_PIN_INVALID, message: 'Wrong PIN.' });

/**
 * PIN sign-in on a registered POS device (docs/POS.md). The device key (X-Pos-Device) is the trust anchor:
 * only staff of the device's restaurant, working at its branch (or all branches), holding pos.use, active,
 * with a PIN set, may sign in on it. Wrong PINs count per account; after POS_PIN_POLICY.maxAttempts the
 * account's PIN is locked for lockMinutes. Every outcome is audited (never the PIN itself).
 */
@Injectable()
export class PosAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /** The device the key names, if it is ACTIVE and its restaurant's POS is ACTIVE. */
  async device(deviceKey: string | undefined): Promise<DeviceRow & { branch: { name: string }; restaurant: { id: string; name: string; status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' } }> {
    if (!deviceKey) throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REQUIRED, message: 'This screen needs a registered POS device.' });
    const device = await this.prisma.posDevice.findUnique({
      where: { keyHash: hashKey(deviceKey) },
      include: { branch: { select: { name: true } }, restaurant: { select: { id: true, name: true, status: true } } },
    });
    if (!device || device.status !== 'ACTIVE') throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REVOKED, message: 'This device is not registered for the POS any more.' });
    await this.access.requireActive(device.restaurant);
    return device as typeof device & { restaurant: { status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' } };
  }

  /** The device and who may sign in on it with a PIN. */
  async info(deviceKey: string | undefined): Promise<{ device: PosDeviceInfo; staff: PosPinStaff[] }> {
    const device = await this.device(deviceKey);
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: { staffRestaurantId: device.restaurantId, role: { in: [...STAFF_ROLES] }, status: 'ACTIVE', posPinHash: { not: null }, OR: [{ staffBranchId: null }, { staffBranchId: device.branchId }] },
      select: { id: true, fullName: true, role: true, permissionGrants: true, posPinLockedUntil: true },
      orderBy: { fullName: 'asc' },
    });
    return {
      device: { id: device.id, name: device.name, branchId: device.branchId, branchName: device.branch.name, restaurantName: device.restaurant.name },
      staff: users.filter((user) => effectivePermissions(user.role, user.permissionGrants).includes('pos.use'))
        .map((user) => ({ id: user.id, fullName: user.fullName, role: user.role, locked: Boolean(user.posPinLockedUntil && user.posPinLockedUntil > now) })),
    };
  }

  async pinLogin(deviceKey: string | undefined, userId: string, pin: string, meta: ClientMeta): Promise<IssuedSession> {
    const device = await this.device(deviceKey);
    const user = await this.prisma.user.findFirst({ where: { id: userId, staffRestaurantId: device.restaurantId, role: { in: [...STAFF_ROLES] } } });
    const now = new Date();
    // Unknown, inactive, elsewhere, or without the POS: the same answer as a wrong PIN.
    if (!user || user.status !== 'ACTIVE' || !user.posPinHash || (user.staffBranchId && user.staffBranchId !== device.branchId)
      || !effectivePermissions(user.role, user.permissionGrants).includes('pos.use')) {
      await this.record(device, null, 'pos.pin.rejected', { userId });
      throw invalidPin();
    }
    if (user.posPinLockedUntil && user.posPinLockedUntil > now) throw locked(user.posPinLockedUntil);
    if (!(await this.passwords.verify(user.posPinHash, pin))) {
      const attempts = user.posPinFailedAttempts + 1;
      const lock = attempts >= POS_PIN_POLICY.maxAttempts ? new Date(now.getTime() + POS_PIN_POLICY.lockMinutes * 60_000) : null;
      await this.prisma.user.update({ where: { id: user.id }, data: lock ? { posPinFailedAttempts: 0, posPinLockedUntil: lock } : { posPinFailedAttempts: attempts } });
      await this.record(device, user.id, lock ? 'pos.pin.locked' : 'pos.pin.failed', { attempts });
      if (lock) throw locked(lock);
      throw invalidPin();
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { posPinFailedAttempts: 0, posPinLockedUntil: null } });
    await this.prisma.posDevice.update({ where: { id: device.id }, data: { lastSeenAt: now, lastUserName: user.fullName } });
    await this.record(device, user.id, 'pos.login', { method: 'pin' });
    return this.auth.startPosSession(user, meta);
  }

  /** A cashier leaving the terminal (the session itself ends through /v1/auth/logout). */
  async recordLogout(userId: string, deviceKey: string | undefined): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { staffRestaurantId: true, restaurant: { select: { id: true } } } });
    const restaurantId = user?.staffRestaurantId ?? user?.restaurant?.id ?? null;
    const device = deviceKey ? await this.prisma.posDevice.findUnique({ where: { keyHash: hashKey(deviceKey) }, select: { id: true, restaurantId: true, branchId: true } }) : null;
    const own = device && device.restaurantId === restaurantId ? device : null;
    await this.audit.record({ actorId: userId, restaurantId, action: 'pos.logout', targetType: 'pos-device', targetId: own?.id ?? null, metadata: { branchId: own?.branchId ?? null } });
  }

  private record(device: DeviceRow, userId: string | null, action: string, metadata: Record<string, unknown>) {
    return this.audit.record({ actorId: userId, restaurantId: device.restaurantId, action, targetType: 'pos-device', targetId: device.id, metadata: { ...metadata, branchId: device.branchId } });
  }
}

function locked(until: Date) {
  return new HttpException({ code: POS_PIN_ERROR_CODES.POS_PIN_LOCKED, message: 'Too many wrong PINs. Try again later.', details: { until: until.toISOString() } }, HttpStatus.LOCKED);
}
