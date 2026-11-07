import { ConflictException, Injectable } from '@nestjs/common';
import { type OrderPaymentMethod, POS_PAYMENT_ERROR_CODES as CODES, type PosOrderPayments, type PosPayment } from '@bilhanah/contracts';
import type { OrderPayment, OrderPaymentRefund, Prisma } from '@bilhanah/database';
import type { Scope } from '../branches/branch-scope.service.js';
import { CashService } from '../cash/cash.service.js';
import { LoyaltyCore } from '../loyalty/loyalty-core.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string | null } | null;
export type LedgerOrder = { id: string; restaurantId: string; branchId: string; status: string; totalPiastres: number; paidAt: Date | null };

const COUNTED = ['SUCCEEDED', 'PARTIALLY_REFUNDED'] as const;
export const paymentInvalid = (message: string, details?: Record<string, unknown>) => new ConflictException({ code: CODES.POS_PAYMENT_INVALID, message, ...(details && { details }) });

/**
 * Every order's payments (docs/POS.md, task 3): an order is paid in one or more payments, by one or
 * more methods; it is settled (paidAt) once they cover its bill, and unsettled again when refunds
 * leave it short. Cash goes through the cashier's drawer. Every operation locks the order first, so
 * concurrent payments never overpay it. Recording a refund here does not move money at a provider.
 */
@Injectable()
export class OrderPaymentsLedger {
  constructor(
    private readonly cash: CashService,
    private readonly loyalty: LoyaltyCore,
  ) {}

  /** Locks the order and returns it. */
  async lock(tx: Tx, orderId: string): Promise<LedgerOrder> {
    const [row] = await tx.$queryRaw<{ id: string; restaurant_id: string; branch_id: string; status: string; total_piastres: number; paid_at: Date | null }[]>`
      SELECT id, restaurant_id, branch_id, status::text, total_piastres, paid_at FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    if (!row) throw paymentInvalid('Order not found.');
    return { id: row.id, restaurantId: row.restaurant_id, branchId: row.branch_id, status: row.status, totalPiastres: row.total_piastres, paidAt: row.paid_at };
  }

  async paid(tx: Tx, orderId: string): Promise<number> {
    const rows = await tx.orderPayment.findMany({ where: { orderId, status: { in: [...COUNTED] } }, select: { amountPiastres: true, refundedPiastres: true } });
    return rows.reduce((sum, row) => sum + row.amountPiastres - row.refundedPiastres, 0);
  }

  /** Records a payment (or a declined one) and settles the order when it is fully covered. */
  async add(tx: Tx, order: LedgerOrder, input: {
    method: OrderPaymentMethod; amountPiastres: number; tenderedPiastres?: number; reference?: string | null; failed?: boolean; failureReason?: string | null;
    actor: Actor; scope: Scope | null; deviceId?: string | null; integrationId?: string | null; idempotencyKey: string; now: Date;
  }): Promise<{ payment: OrderPayment; settled: boolean }> {
    if (order.status === 'REJECTED' || order.status === 'CANCELLED') throw paymentInvalid('A rejected or cancelled order has nothing to pay.');
    const due = order.totalPiastres - (await this.paid(tx, order.id));
    if (!input.failed && input.amountPiastres > due) throw paymentInvalid('That is more than is due on this order.', { duePiastres: due });
    if (input.tenderedPiastres !== undefined && input.tenderedPiastres < input.amountPiastres) throw paymentInvalid('The cash handed over is less than the amount.');
    const cashChange = input.method === 'CASH' && input.tenderedPiastres !== undefined ? input.tenderedPiastres - input.amountPiastres : null;
    const payment = await tx.orderPayment.create({
      data: {
        restaurantId: order.restaurantId, orderId: order.id, branchId: order.branchId, method: input.method,
        status: input.failed ? 'FAILED' : 'SUCCEEDED', amountPiastres: input.amountPiastres,
        tenderedPiastres: input.method === 'CASH' ? (input.tenderedPiastres ?? null) : null, changePiastres: cashChange,
        reference: input.reference ?? null, failureReason: input.failed ? (input.failureReason ?? null) : null,
        integrationId: input.integrationId ?? null, cashierId: input.actor?.id ?? null, cashierName: input.actor?.name ?? null,
        deviceId: input.deviceId ?? null, idempotencyKey: input.idempotencyKey, createdAt: input.now,
      },
    });
    if (input.failed) return { payment, settled: false };
    // Cash taken by staff goes into their drawer; an external POS keeps its own.
    if (input.method === 'CASH' && input.scope) {
      await this.cash.recordOrderCash(tx, { scope: input.scope, branchId: order.branchId, orderId: order.id, kind: 'SALE', amountPiastres: input.amountPiastres, paidAt: input.now });
    }
    return { payment, settled: await this.settleIfPaid(tx, order, input.actor, input.now) };
  }

  /** Marks the order paid once its payments cover the bill. */
  async settleIfPaid(tx: Tx, order: LedgerOrder, actor: Actor, now: Date): Promise<boolean> {
    if (order.paidAt) return false;
    const payments = await tx.orderPayment.findMany({ where: { orderId: order.id, status: { in: [...COUNTED] } }, select: { method: true, amountPiastres: true, refundedPiastres: true } });
    const paid = payments.reduce((sum, row) => sum + row.amountPiastres - row.refundedPiastres, 0);
    if (paid < order.totalPiastres) return false;
    // The method that paid the most names the bill's method.
    const byMethod = new Map<OrderPaymentMethod, number>();
    for (const row of payments) byMethod.set(row.method, (byMethod.get(row.method) ?? 0) + row.amountPiastres - row.refundedPiastres);
    const method = [...byMethod.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'CASH';
    await tx.order.update({ where: { id: order.id }, data: { paidAt: now, paymentMethod: method, refundedAt: null } });
    await this.loyalty.syncOrder(tx, order.id, actor);
    return true;
  }

  /** Records a refund on a payment; the order becomes unpaid (refunded) when what remains no longer covers it. */
  async refund(tx: Tx, order: LedgerOrder, payment: OrderPayment, input: { amountPiastres: number; reason: string; actor: Actor; scope: Scope | null; now: Date }): Promise<OrderPaymentRefund> {
    if (payment.status === 'FAILED') throw new ConflictException({ code: CODES.POS_REFUND_INVALID, message: 'A declined payment has nothing to refund.' });
    const fresh = await tx.orderPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const refundable = fresh.amountPiastres - fresh.refundedPiastres;
    if (input.amountPiastres > refundable) throw new ConflictException({ code: CODES.POS_REFUND_INVALID, message: 'That is more than this payment has left to refund.', details: { refundablePiastres: refundable } });
    const refunded = fresh.refundedPiastres + input.amountPiastres;
    await tx.orderPayment.update({ where: { id: payment.id }, data: { refundedPiastres: refunded, status: refunded === fresh.amountPiastres ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    const row = await tx.orderPaymentRefund.create({ data: { paymentId: payment.id, amountPiastres: input.amountPiastres, reason: input.reason, actorId: input.actor?.id ?? null, actorName: input.actor?.name ?? null, createdAt: input.now } });
    if (fresh.method === 'CASH' && input.scope) {
      await this.cash.recordOrderCash(tx, { scope: input.scope, branchId: order.branchId, orderId: order.id, kind: 'REFUND', amountPiastres: input.amountPiastres, paidAt: input.now });
    }
    if (order.paidAt && (await this.paid(tx, order.id)) < order.totalPiastres) {
      await tx.order.update({ where: { id: order.id }, data: { paidAt: null, paymentMethod: null, refundedAt: input.now } });
      await this.loyalty.syncOrder(tx, order.id, input.actor);
    }
    return row;
  }

  async view(tx: Tx, order: { id: string; totalPiastres: number; paidAt: Date | null }): Promise<PosOrderPayments> {
    const rows = await tx.orderPayment.findMany({ where: { orderId: order.id }, include: { refunds: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'asc' } });
    const paid = rows.filter((row) => (COUNTED as readonly string[]).includes(row.status) || row.status === 'REFUNDED').reduce((sum, row) => sum + row.amountPiastres - row.refundedPiastres, 0);
    return {
      orderId: order.id,
      totalPiastres: order.totalPiastres,
      paidPiastres: paid,
      duePiastres: Math.max(0, order.totalPiastres - paid),
      settled: order.paidAt !== null,
      payments: rows.map((row): PosPayment => ({
        id: row.id, method: row.method, status: row.status, amountPiastres: row.amountPiastres, tenderedPiastres: row.tenderedPiastres, changePiastres: row.changePiastres,
        refundedPiastres: row.refundedPiastres, reference: row.reference, failureReason: row.failureReason, cashierName: row.cashierName, external: row.integrationId !== null,
        createdAt: row.createdAt.toISOString(),
        refunds: row.refunds.map((refund) => ({ id: refund.id, amountPiastres: refund.amountPiastres, reason: refund.reason, actorName: refund.actorName, createdAt: refund.createdAt.toISOString() })),
      })),
    };
  }
}
