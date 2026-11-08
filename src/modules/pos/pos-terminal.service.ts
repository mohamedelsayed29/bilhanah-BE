import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  CASH_ERROR_CODES, ORDER_ERROR_CODES, POS_DEVICE_ERROR_CODES, POS_PAIRING_MINUTES, type PosPairing, POS_PAYMENT_ERROR_CODES, type PosDevice, type PosDeviceRegistration, type PosOrderPayments, type PosReceipt,
  type posDeviceSchema, type posDeviceUpdateSchema, type posPaymentSchema, type posRefundSchema,
} from '@bilhanah/contracts';
import type { PosAccount, PosDevice as DeviceRow } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PosAccessService } from './pos-access.service.js';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const deviceNotFound = () => new NotFoundException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_NOT_FOUND, message: 'Device not found.' });

/**
 * The terminal's payments, receipts and devices (docs/POS.md, tasks 3 and 5). A terminal running on a
 * registered device sends its key (X-Pos-Device); payments and orders then record the device, and a
 * revoked device is refused.
 */
@Injectable()
export class PosTerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly access: PosAccessService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The caller's scope with an ACTIVE POS (subscription, plan, administrator and setup), for POS management.
   * Terminal operations go through onDevice(), which also requires a registered device.
   */
  async terminal(userId: string, _deviceKey: undefined, ...permissions: Perm[]): Promise<{ scope: Scope; account: PosAccount; device: null }> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, ...permissions);
    const account = await this.access.requireActive(scope.restaurant);
    return { scope, account, device: null };
  }

  /**
   * A terminal operation. Every check, in order: the signed-in account (resolve: active, its restaurant and
   * branch), its permissions, an ACTIVE POS for the restaurant, then the device key (X-Pos-Device), which must
   * name an ACTIVE device of the same restaurant and, for an account tied to a branch, of that branch.
   * Nothing the client sends about restaurant, branch or device is trusted beyond the key itself.
   */
  async onDevice(userId: string, deviceKey: string | undefined, ...permissions: Perm[]): Promise<{ scope: Scope; account: PosAccount; device: DeviceRow }> {
    const { scope, account } = await this.terminal(userId, undefined, ...permissions);
    if (!deviceKey) throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REQUIRED, message: 'The POS runs on a registered device. Ask a manager to register this one.' });
    const device = await this.prisma.posDevice.findUnique({ where: { keyHash: hashKey(deviceKey) } });
    if (!device || device.restaurantId !== scope.restaurant.id || device.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REVOKED, message: 'This device is not registered for the POS any more.' });
    }
    if (scope.fixedBranchId && scope.fixedBranchId !== device.branchId) {
      throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_WRONG_BRANCH, message: 'This device belongs to another branch.' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await this.prisma.posDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), lastUserName: user?.fullName ?? null } });
    return { scope, account, device };
  }

  /** An order handled on a device must be at the device's branch. */
  async requireDeviceBranch(device: DeviceRow, orderId: string, restaurantId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId }, select: { branchId: true } });
    if (order && order.branchId !== device.branchId) {
      throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_WRONG_BRANCH, message: 'This order belongs to another branch than this device.' });
    }
  }

  // --- Payments ------------------------------------------------------------------------

  async payments(userId: string, deviceKey: string | undefined, orderId: string): Promise<PosOrderPayments> {
    const { scope, device } = await this.onDevice(userId, deviceKey, 'pos.use');
    await this.requireDeviceBranch(device, orderId, scope.restaurant.id);
    return this.orders.payments(scope, orderId);
  }

  async pay(userId: string, deviceKey: string | undefined, orderId: string, idempotencyKey: string, input: z.output<typeof posPaymentSchema>): Promise<PosOrderPayments> {
    const { scope, account, device } = await this.onDevice(userId, deviceKey, 'pos.use', 'payments.process');
    await this.requireDeviceBranch(device, orderId, scope.restaurant.id);
    if (!account.paymentMethods.includes(input.method)) {
      throw new ConflictException({ code: POS_PAYMENT_ERROR_CODES.POS_PAYMENT_INVALID, message: 'The POS does not take this payment method.', details: { methods: account.paymentMethods } });
    }
    if (input.method === 'CASH' && !input.failed && account.requireOpenShift) {
      const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId: scope.restaurant.id }, select: { branchId: true } });
      const open = order && await this.prisma.cashShift.count({ where: { branchId: order.branchId, status: 'OPEN', cashierId: scope.userId } });
      if (order && !open) throw new ConflictException({ code: CASH_ERROR_CODES.SHIFT_REQUIRED, message: 'Open your cash shift before taking cash.' });
    }
    const result = await this.orders.recordPayment(scope, scope.restaurant.id, orderId, idempotencyKey, { ...input, deviceId: device.id });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.payment.recorded', targetType: 'order', targetId: orderId, metadata: { method: input.method, amountPiastres: input.amountPiastres, failed: input.failed ?? false, deviceId: device.id, branchId: device.branchId } });
    return result;
  }

  /** A refund with its reason (payments.refund), audited. Money at a card or wallet provider is returned there, not here. */
  async refund(userId: string, deviceKey: string | undefined, paymentId: string, input: z.output<typeof posRefundSchema>): Promise<PosOrderPayments> {
    const { scope, device } = await this.onDevice(userId, deviceKey, 'pos.use', 'payments.refund');
    const payment = await this.prisma.orderPayment.findFirst({ where: { id: paymentId, order: { restaurantId: scope.restaurant.id } }, select: { orderId: true } });
    if (payment) await this.requireDeviceBranch(device, payment.orderId, scope.restaurant.id);
    const result = await this.orders.refundPayment(scope, paymentId, input);
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.payment.refunded', targetType: 'order-payment', targetId: paymentId, metadata: { amountPiastres: input.amountPiastres, reason: input.reason, orderId: result.orderId, deviceId: device.id } });
    return result;
  }

  // --- Receipts --------------------------------------------------------------------------

  async receipt(userId: string, deviceKey: string | undefined, orderId: string): Promise<PosReceipt> {
    const { scope, account, device } = await this.onDevice(userId, deviceKey, 'pos.use');
    await this.requireDeviceBranch(device, orderId, scope.restaurant.id);
    const own = await this.scopes.branchWhere(scope);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...own },
      include: { items: { orderBy: { sortOrder: 'asc' } }, branch: true, restaurant: { include: { logo: true } }, payments: { where: { status: { not: 'FAILED' } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException({ code: ORDER_ERROR_CODES.ORDER_NOT_FOUND, message: 'Order not found.' });
    const paid = order.payments.reduce((sum, payment) => sum + payment.amountPiastres - payment.refundedPiastres, 0);
    const logo = order.restaurant.logo;
    return {
      restaurant: { name: order.restaurant.name, phone: order.branch.phone, logoUrl: logo ? this.storage.publicUrl(`${logo.storageKey}/${logo.variantWidths[0]}.webp`) : null },
      branch: { name: order.branch.name, address: order.branch.address, city: order.branch.city, phone: order.branch.phone },
      header: account.receiptHeader, footer: account.receiptFooter, showLogo: account.receiptShowLogo,
      order: {
        id: order.id, number: order.number, placedAt: order.placedAt.toISOString(), type: order.type, tableLabel: order.tableLabel, customerName: order.customerName,
        cashierName: order.createdByName, status: order.status,
        items: order.items.filter((item) => item.prepStatus !== 'CANCELLED').map((item) => ({
          name: item.nameAr, nameEn: item.nameEn, variant: item.variantNameAr, quantity: item.quantity, unitPricePiastres: item.unitPricePiastres, lineTotalPiastres: item.unitPricePiastres * item.quantity, note: item.note,
        })),
        subtotalPiastres: order.subtotalPiastres, discountPiastres: order.discountPiastres, discountReason: order.discountReason, serviceChargePiastres: order.serviceChargePiastres,
        taxPiastres: order.taxPiastres, taxInclusive: order.totalPiastres === order.subtotalPiastres - order.discountPiastres + order.serviceChargePiastres, totalPiastres: order.totalPiastres,
      },
      payments: order.payments.map((payment) => ({ method: payment.method, amountPiastres: payment.amountPiastres, tenderedPiastres: payment.tenderedPiastres, changePiastres: payment.changePiastres, refundedPiastres: payment.refundedPiastres })),
      paidPiastres: paid,
      duePiastres: Math.max(0, order.totalPiastres - paid),
      printedAt: new Date().toISOString(),
    };
  }

  // --- Devices ---------------------------------------------------------------------------

  async devices(userId: string): Promise<PosDevice[]> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const rows = await this.prisma.posDevice.findMany({ where: { restaurantId: scope.restaurant.id }, include: { branch: { select: { name: true } } }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
    return rows.map(deviceView);
  }

  /**
   * Registers a device, within the restaurant's device limit. On this browser (onThisDevice) the key is
   * returned once and kept by the terminal; for another device a one-time pairing code is returned instead,
   * to be typed on it (pair()). Only hashes are stored.
   */
  async register(userId: string, input: z.output<typeof posDeviceSchema>): Promise<PosDeviceRegistration> {
    const { scope, account } = await this.terminal(userId, undefined, 'pos.settings');
    await this.scopes.branch(scope, input.branchId);
    const deviceKey = newDeviceKey();
    const pairing = input.onThisDevice ? null : newPairingCode();
    const row = await this.prisma.$transaction(async (tx) => {
      // Serialises registrations for this restaurant, so two at once cannot both slip under the limit.
      await tx.$queryRaw`SELECT 1 FROM pos_accounts WHERE restaurant_id = ${scope.restaurant.id}::uuid FOR UPDATE`;
      const inUse = await tx.posDevice.count({ where: { restaurantId: scope.restaurant.id, status: { in: ['ACTIVE', 'DISABLED'] } } });
      if (inUse >= account.maxDevices) {
        throw new ConflictException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_LIMIT, message: 'The POS device limit for this restaurant is reached.', details: { maxDevices: account.maxDevices } });
      }
      const created = await tx.posDevice.create({
        data: { restaurantId: scope.restaurant.id, branchId: input.branchId, name: input.name, keyHash: hashKey(deviceKey), createdById: userId, ...(pairing && { pairingCodeHash: hashKey(pairing.code), pairingExpiresAt: pairing.expiresAt }) },
        include: { branch: { select: { name: true } } },
      });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.registered', targetType: 'pos-device', targetId: created.id, metadata: { name: input.name, branchId: input.branchId, paired: !input.onThisDevice } }, tx);
      return created;
    });
    return { device: deviceView(row), deviceKey: pairing ? null : deviceKey, pairing: pairing && { code: pairing.code, expiresAt: pairing.expiresAt.toISOString() } };
  }

  /** A fresh pairing code for an ACTIVE device (e.g. a new tablet replacing an old one); the old key keeps working until it is used. */
  async pairingCode(userId: string, id: string): Promise<PosPairing> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const pairing = newPairingCode();
    const { count } = await this.prisma.posDevice.updateMany({ where: { id, restaurantId: scope.restaurant.id, status: 'ACTIVE' }, data: { pairingCodeHash: hashKey(pairing.code), pairingExpiresAt: pairing.expiresAt } });
    if (!count) throw deviceNotFound();
    const row = await this.prisma.posDevice.findUniqueOrThrow({ where: { id }, include: { branch: { select: { name: true } } } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.pairing_issued', targetType: 'pos-device', targetId: id });
    return { device: deviceView(row), code: pairing.code, expiresAt: pairing.expiresAt.toISOString() };
  }

  /**
   * Pairs this browser with a device: the code (once, unexpired) is exchanged for a new device key, which
   * replaces the old one. The signed-in account must hold pos.use at that restaurant and may work at its branch.
   */
  async pair(userId: string, code: string): Promise<PosDeviceRegistration> {
    const { scope } = await this.terminal(userId, undefined, 'pos.use');
    const device = await this.prisma.posDevice.findUnique({ where: { pairingCodeHash: hashKey(code) } });
    if (!device || device.restaurantId !== scope.restaurant.id || device.status !== 'ACTIVE' || !device.pairingExpiresAt || device.pairingExpiresAt <= new Date()) {
      throw new BadRequestException({ code: POS_DEVICE_ERROR_CODES.POS_PAIRING_INVALID, message: 'This code is not valid any more. Ask for a new one.' });
    }
    await this.scopes.branch(scope, device.branchId);
    const deviceKey = newDeviceKey();
    const { count } = await this.prisma.posDevice.updateMany({ where: { id: device.id, pairingCodeHash: hashKey(code) }, data: { keyHash: hashKey(deviceKey), pairingCodeHash: null, pairingExpiresAt: null, lastSeenAt: new Date() } });
    if (!count) throw new BadRequestException({ code: POS_DEVICE_ERROR_CODES.POS_PAIRING_INVALID, message: 'This code was just used.' });
    const row = await this.prisma.posDevice.findUniqueOrThrow({ where: { id: device.id }, include: { branch: { select: { name: true } } } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.paired', targetType: 'pos-device', targetId: device.id });
    return { device: deviceView(row), deviceKey, pairing: null };
  }

  async updateDevice(userId: string, id: string, input: z.output<typeof posDeviceUpdateSchema>): Promise<PosDevice> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const device = await this.prisma.posDevice.findFirst({ where: { id, restaurantId: scope.restaurant.id } });
    if (!device) throw deviceNotFound();
    if (input.branchId) await this.scopes.branch(scope, input.branchId);
    if (input.status && device.status === 'REVOKED') throw new ConflictException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REVOKED, message: 'A revoked device cannot be switched back on; register it again.' });
    const row = await this.prisma.posDevice.update({ where: { id }, data: input, include: { branch: { select: { name: true } } } });
    const action = input.status === 'DISABLED' && device.status !== 'DISABLED' ? 'pos.device.disabled' : input.status === 'ACTIVE' && device.status === 'DISABLED' ? 'pos.device.enabled' : 'pos.device.updated';
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action, targetType: 'pos-device', targetId: id, metadata: { previous: { name: device.name, branchId: device.branchId, status: device.status }, next: input } });
    return deviceView(row);
  }

  /** Revokes a device: its key stops working at once. Its orders and payments keep naming it. */
  async revoke(userId: string, id: string): Promise<PosDevice> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const { count } = await this.prisma.posDevice.updateMany({ where: { id, restaurantId: scope.restaurant.id, status: { in: ['ACTIVE', 'DISABLED'] } }, data: { status: 'REVOKED', revokedAt: new Date(), pairingCodeHash: null, pairingExpiresAt: null } });
    const row = await this.prisma.posDevice.findFirst({ where: { id, restaurantId: scope.restaurant.id }, include: { branch: { select: { name: true } } } });
    if (!row) throw deviceNotFound();
    if (count) await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.revoked', targetType: 'pos-device', targetId: id });
    return deviceView(row);
  }
}

type Perm = 'pos.use' | 'payments.process' | 'payments.refund' | 'pos.settings';

const newDeviceKey = () => `posd_${randomBytes(24).toString('base64url')}`;
/** 8 characters without look-alikes (0/O, 1/I/L), valid for POS_PAIRING_MINUTES. */
function newPairingCode(): { code: string; expiresAt: Date } {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return { code, expiresAt: new Date(Date.now() + POS_PAIRING_MINUTES * 60_000) };
}

export function deviceView(row: DeviceRow & { branch: { name: string } }): PosDevice {
  return {
    id: row.id, name: row.name, branchId: row.branchId, branchName: row.branch.name, status: row.status,
    pairingPending: Boolean(row.pairingCodeHash && row.pairingExpiresAt && row.pairingExpiresAt > new Date()),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null, lastUserName: row.lastUserName, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
