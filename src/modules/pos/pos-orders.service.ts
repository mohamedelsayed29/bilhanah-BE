import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  type OwnerOrder, POS_DEVICE_ERROR_CODES, POS_ERROR_CODES, POS_ORDER_ERROR_CODES, type PosTotals, posDiscountPiastres, posTotals, type posOrderSchema,
} from '@bilhanah/contracts';
import type { PosAccount } from '@bilhanah/database';
import type { z } from 'zod';
import type { Scope } from '../branches/branch-scope.service.js';
import { OrdersService, type StaffBill } from '../orders/orders.service.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PosTerminalService } from './pos-terminal.service.js';

type Input = z.output<typeof posOrderSchema>;

/**
 * Orders at the POS terminal: pos.use and orders.create, an ACTIVE POS whose mode includes
 * Bilhanah's POS. Totals are always worked out here from the menu and the POS settings; a discount
 * above the cashier limit needs pos.discount.
 */
@Injectable()
export class PosOrdersService {
  constructor(
    private readonly terminals: PosTerminalService,
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async quote(userId: string, input: Input, deviceKey?: string): Promise<PosTotals> {
    const { scope, account } = await this.terminal(userId, deviceKey);
    return this.orders.staffQuote(scope, input, (subtotal) => this.bill(scope, account, input, subtotal));
  }

  async place(userId: string, idempotencyKey: string, input: Input, deviceKey?: string): Promise<OwnerOrder> {
    const { scope, account, device } = await this.terminal(userId, deviceKey);
    // The order is taken at the device's branch: a branch or table elsewhere is refused.
    if (input.branchId && input.branchId !== device.branchId) throw wrongBranch();
    if (input.tableId) {
      const table = await this.prisma.table.findFirst({ where: { id: input.tableId, restaurantId: scope.restaurant.id }, select: { branchId: true } });
      if (table && table.branchId !== device.branchId) throw wrongBranch();
    }
    const order = await this.orders.placeStaff(scope, idempotencyKey, { ...input, branchId: input.tableId ? input.branchId : device.branchId, deviceId: device.id }, (subtotal): StaffBill => {
      const totals = this.bill(scope, account, input, subtotal);
      return { ...totals, discountReason: totals.discountPiastres > 0 ? (input.discount?.reason ?? null) : null };
    });
    await this.audit.record({
      actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.order.created', targetType: 'order', targetId: order.id,
      metadata: { number: order.number, branchId: device.branchId, deviceId: device.id, totalPiastres: order.totalPiastres, discountPiastres: order.discountPiastres, discountReason: order.discountReason ?? null },
    });
    return order;
  }

  private async terminal(userId: string, deviceKey?: string) {
    const { scope, account, device } = await this.terminals.onDevice(userId, deviceKey, 'pos.use');
    if (!scope.permissions.has('orders.create')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have permission to do this.' });
    if (account.mode === 'EXTERNAL') {
      throw new ConflictException({ code: POS_ERROR_CODES.POS_UNAVAILABLE, message: 'This restaurant uses an external POS; the Bilhanah terminal is off.', details: { status: 'ACTIVE', mode: account.mode } });
    }
    return { scope, account, device };
  }

  private bill(scope: Scope, account: PosAccount, input: Input, subtotal: number): PosTotals {
    const discount = posDiscountPiastres(input.discount, subtotal);
    if (discount > 0 && subtotal > 0 && (discount / subtotal) * 100 > account.cashierMaxDiscountPercent + 1e-9 && !scope.permissions.has('pos.discount')) {
      throw new ForbiddenException({ code: POS_ORDER_ERROR_CODES.POS_DISCOUNT_NOT_ALLOWED, message: 'This discount needs a manager.', details: { maxPercent: account.cashierMaxDiscountPercent } });
    }
    return posTotals({ subtotalPiastres: subtotal, discountPiastres: discount, dineIn: input.type === 'DINE_IN' }, account);
  }
}

const wrongBranch = () => new ForbiddenException({ code: POS_DEVICE_ERROR_CODES.POS_DEVICE_WRONG_BRANCH, message: 'This device belongs to another branch.' });
