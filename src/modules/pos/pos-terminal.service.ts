import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  CASH_ERROR_CODES, ORDER_ERROR_CODES, POS_DEVICE_ERROR_CODES, POS_PAYMENT_ERROR_CODES, type PosDevice, type PosDeviceRegistration, type PosOrderPayments, type PosReceipt,
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

  /** The caller's scope with an ACTIVE POS, and the device the request comes from (if any). */
  async terminal(userId: string, deviceKey: string | undefined, ...permissions: ('pos.use' | 'payments.process' | 'payments.refund' | 'pos.settings')[]): Promise<{ scope: Scope; account: PosAccount; device: DeviceRow | null }> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, ...permissions);
    const account = await this.access.requireActive(scope.restaurant);
    let device: DeviceRow | null = null;
    if (deviceKey) {
      device = await this.prisma.posDevice.findUnique({ where: { keyHash: hashKey(deviceKey) } });
      if (!device || device.restaurantId !== scope.restaurant.id || device.status !== 'ACTIVE') {
        throw new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_REVOKED, message: 'This device is not registered for the POS any more.' });
      }
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await this.prisma.posDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), lastUserName: user?.fullName ?? null } });
    }
    return { scope, account, device };
  }

  // --- Payments ------------------------------------------------------------------------

  async payments(userId: string, orderId: string): Promise<PosOrderPayments> {
    const { scope } = await this.terminal(userId, undefined, 'pos.use');
    return this.orders.payments(scope, orderId);
  }

  async pay(userId: string, deviceKey: string | undefined, orderId: string, idempotencyKey: string, input: z.output<typeof posPaymentSchema>): Promise<PosOrderPayments> {
    const { scope, account, device } = await this.terminal(userId, deviceKey, 'pos.use', 'payments.process');
    if (!account.paymentMethods.includes(input.method)) {
      throw new ConflictException({ code: POS_PAYMENT_ERROR_CODES.POS_PAYMENT_INVALID, message: 'The POS does not take this payment method.', details: { methods: account.paymentMethods } });
    }
    if (input.method === 'CASH' && !input.failed && account.requireOpenShift) {
      const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId: scope.restaurant.id }, select: { branchId: true } });
      const open = order && await this.prisma.cashShift.count({ where: { branchId: order.branchId, status: 'OPEN', cashierId: scope.userId } });
      if (order && !open) throw new ConflictException({ code: CASH_ERROR_CODES.SHIFT_REQUIRED, message: 'Open your cash shift before taking cash.' });
    }
    return this.orders.recordPayment(scope, scope.restaurant.id, orderId, idempotencyKey, { ...input, deviceId: device?.id ?? null });
  }

  /** A refund with its reason (payments.refund), audited. Money at a card or wallet provider is returned there, not here. */
  async refund(userId: string, paymentId: string, input: z.output<typeof posRefundSchema>): Promise<PosOrderPayments> {
    const { scope } = await this.terminal(userId, undefined, 'pos.use', 'payments.refund');
    const result = await this.orders.refundPayment(scope, paymentId, input);
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.payment.refunded', targetType: 'order-payment', targetId: paymentId, metadata: { amountPiastres: input.amountPiastres, reason: input.reason, orderId: result.orderId } });
    return result;
  }

  // --- Receipts --------------------------------------------------------------------------

  async receipt(userId: string, orderId: string): Promise<PosReceipt> {
    const { scope, account } = await this.terminal(userId, undefined, 'pos.use');
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

  /** Registers a device: its key is shown once (the terminal keeps it); only its hash is stored. */
  async register(userId: string, input: z.output<typeof posDeviceSchema>): Promise<PosDeviceRegistration> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    await this.scopes.branch(scope, input.branchId);
    const deviceKey = `posd_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.posDevice.create({ data: { restaurantId: scope.restaurant.id, branchId: input.branchId, name: input.name, keyHash: hashKey(deviceKey), createdById: userId }, include: { branch: { select: { name: true } } } });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.registered', targetType: 'pos-device', targetId: created.id, metadata: { name: input.name, branchId: input.branchId } }, tx);
      return created;
    });
    return { device: deviceView(row), deviceKey };
  }

  async updateDevice(userId: string, id: string, input: z.output<typeof posDeviceUpdateSchema>): Promise<PosDevice> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const device = await this.prisma.posDevice.findFirst({ where: { id, restaurantId: scope.restaurant.id } });
    if (!device) throw deviceNotFound();
    if (input.branchId) await this.scopes.branch(scope, input.branchId);
    const row = await this.prisma.posDevice.update({ where: { id }, data: input, include: { branch: { select: { name: true } } } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.updated', targetType: 'pos-device', targetId: id, metadata: { previous: { name: device.name, branchId: device.branchId }, next: input } });
    return deviceView(row);
  }

  /** Revokes a device: its key stops working at once. Its orders and payments keep naming it. */
  async revoke(userId: string, id: string): Promise<PosDevice> {
    const { scope } = await this.terminal(userId, undefined, 'pos.settings');
    const { count } = await this.prisma.posDevice.updateMany({ where: { id, restaurantId: scope.restaurant.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    const row = await this.prisma.posDevice.findFirst({ where: { id, restaurantId: scope.restaurant.id }, include: { branch: { select: { name: true } } } });
    if (!row) throw deviceNotFound();
    if (count) await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.device.revoked', targetType: 'pos-device', targetId: id });
    return deviceView(row);
  }
}

function deviceView(row: DeviceRow & { branch: { name: string } }): PosDevice {
  return {
    id: row.id, name: row.name, branchId: row.branchId, branchName: row.branch.name, status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null, lastUserName: row.lastUserName, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
