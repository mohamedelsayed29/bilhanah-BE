import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CASH_ERROR_CODES as CODES,
  CASH_LIMITS,
  COMMON_ERROR_CODES,
  type CashApprovalStatus,
  type cashCorrectionSchema,
  cashDiscrepancy,
  cashEffect,
  type CashRegister,
  type CashReport,
  type cashReportQuerySchema,
  type CashReportRow,
  type CashReviewStatus,
  type CashSettings,
  type cashSettingsSchema,
  type CashShift,
  type CashShiftDetail,
  type cashShiftsQuerySchema,
  type CashShiftSummary,
  type CashTransaction,
  type cashTransactionSchema,
  type CashTransactionKind,
  type closeCashShiftSchema,
  closingNoteRequired,
  type createCashRegisterSchema,
  DEFAULT_CASH_SETTINGS,
  discrepancyNeedsReview,
  type MyCashDrawer,
  type openCashShiftSchema,
  type Paginated,
  type PendingCashAdjustment,
  type Permission,
  type reviewCashSchema,
  type updateCashRegisterSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { zonedInstant } from '../attendance/attendance-rules.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';

type Tx = Prisma.TransactionClient;

const fail = (status: 'bad' | 'forbidden' | 'conflict' | 'notFound', code: string, message: string, details?: Record<string, unknown>) => {
  const body = { code, message, ...(details && { details }) };
  return status === 'bad' ? new BadRequestException(body) : status === 'forbidden' ? new ForbiddenException(body) : status === 'conflict' ? new ConflictException(body) : new NotFoundException(body);
};
const shiftNotFound = () => fail('notFound', CODES.SHIFT_NOT_FOUND, 'Cash shift not found.');
const notOpen = (status: string) =>
  status === 'CLOSED'
    ? fail('conflict', CODES.SHIFT_CLOSED, 'This shift is closed; it can only be changed through a correction.', { status })
    : fail('conflict', CODES.SHIFT_NOT_OPEN, 'This shift is not open.', { status });

const shiftInclude = {
  branch: { select: { name: true } },
  register: { select: { id: true, name: true } },
  closedBy: { select: { fullName: true } },
  reviewedBy: { select: { fullName: true } },
} satisfies Prisma.CashShiftInclude;
type ShiftRow = Prisma.CashShiftGetPayload<{ include: typeof shiftInclude }>;

const transactionInclude = {
  order: { select: { id: true, number: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
} satisfies Prisma.CashTransactionInclude;
type TransactionRow = Prisma.CashTransactionGetPayload<{ include: typeof transactionInclude }>;

const emptySummary = (openingPiastres: number): CashShiftSummary => ({
  openingPiastres, cashSalesPiastres: 0, cashSalesCount: 0, cashRefundsPiastres: 0, cashRefundsCount: 0, cashInPiastres: 0, cashOutPiastres: 0,
  adjustmentsPiastres: 0, pendingAdjustmentsCount: 0, pendingAdjustmentsPiastres: 0, expectedPiastres: openingPiastres,
});

/** Totals from grouped transaction sums. Expected cash counts approved movements only. */
export function summarize(openingPiastres: number, groups: { kind: CashTransactionKind; approvalStatus: CashApprovalStatus; sum: number; count: number }[]): CashShiftSummary {
  const summary = emptySummary(openingPiastres);
  for (const group of groups) {
    if (group.approvalStatus === 'PENDING') {
      summary.pendingAdjustmentsCount += group.count;
      summary.pendingAdjustmentsPiastres += group.sum;
      continue;
    }
    if (group.approvalStatus !== 'APPROVED') continue;
    if (group.kind === 'SALE') { summary.cashSalesPiastres += group.sum; summary.cashSalesCount += group.count; }
    else if (group.kind === 'REFUND') { summary.cashRefundsPiastres += group.sum; summary.cashRefundsCount += group.count; }
    else if (group.kind === 'CASH_IN') summary.cashInPiastres += group.sum;
    else if (group.kind === 'CASH_OUT') summary.cashOutPiastres += group.sum;
    else summary.adjustmentsPiastres += group.sum;
    summary.expectedPiastres += cashEffect(group.kind, group.sum);
  }
  return summary;
}

/** The order payment that reaches (or leaves) a drawer. */
export type OrderCashEvent = {
  scope: Scope;
  branchId: string;
  orderId: string;
  kind: 'SALE' | 'REFUND';
  amountPiastres: number;
  /** When the bill was marked paid: with the order and kind, it identifies the event, so it is counted once. */
  paidAt: Date;
};

/**
 * Cashier shifts: opening a drawer, cash movements during the shift, closing with a count, and the
 * manager's review. Every change locks the shift row first, so a payment arriving while the cashier
 * closes either lands before the count or is refused, never after it.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly audit: AuditService,
  ) {}

  // --- Settings and registers ------------------------------------------------------------------------

  async settings(restaurantId: string, tx: Tx = this.prisma): Promise<CashSettings> {
    const row = await tx.cashSettings.findUnique({ where: { restaurantId } });
    if (!row) return { ...DEFAULT_CASH_SETTINGS, currency: 'EGP', updatedAt: null };
    return {
      allowSharedRegister: row.allowSharedRegister,
      requireShiftForCash: row.requireShiftForCash,
      adjustmentsNeedApproval: row.adjustmentsNeedApproval,
      discrepancyTolerancePiastres: row.discrepancyTolerancePiastres,
      closingNote: row.closingNote,
      currency: row.currency,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getSettings(userId: string): Promise<CashSettings> {
    const scope = await this.scopeWithAny(userId, ['cash.operate', 'cash.view', 'cash.settings']);
    return this.settings(scope.restaurant.id);
  }

  async updateSettings(userId: string, input: z.output<typeof cashSettingsSchema>, ipAddress?: string): Promise<CashSettings> {
    const scope = await this.scopeWith(userId, 'cash.settings');
    const restaurantId = scope.restaurant.id;
    await this.prisma.$transaction(async (tx) => {
      await tx.cashSettings.upsert({ where: { restaurantId }, create: { restaurantId, ...input, updatedById: userId }, update: { ...input, updatedById: userId } });
      await this.audit.record({ actorId: userId, restaurantId, action: 'cash.settings', targetType: 'cash-settings', targetId: restaurantId, metadata: input, ipAddress }, tx);
    });
    return this.settings(restaurantId);
  }

  async registers(userId: string, branchId?: string): Promise<CashRegister[]> {
    const scope = await this.scopeWithAny(userId, ['cash.operate', 'cash.view', 'cash.settings']);
    return this.registersFor(scope, branchId, false);
  }

  async createRegister(userId: string, input: z.output<typeof createCashRegisterSchema>, ipAddress?: string): Promise<CashRegister> {
    const scope = await this.scopeWith(userId, 'cash.settings');
    const branch = await this.scopes.branch(scope, input.branchId);
    const count = await this.prisma.cashRegister.count({ where: { branchId: branch.id } });
    if (count >= CASH_LIMITS.registersPerBranch) throw fail('conflict', CODES.REGISTER_UNAVAILABLE, 'This branch has the most registers allowed.');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cashRegister.create({ data: { restaurantId: scope.restaurant.id, branchId: branch.id, name: input.name } });
        await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'cash.register_created', targetType: 'cash-register', targetId: created.id, metadata: { name: input.name, branchId: branch.id }, ipAddress }, tx);
        return created;
      });
      return (await this.registersFor(scope, branch.id, false)).find((register) => register.id === row.id)!;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw fail('conflict', CODES.REGISTER_NAME_TAKEN, 'Another register at this branch has this name.');
    }
  }

  async updateRegister(userId: string, id: string, input: z.output<typeof updateCashRegisterSchema>, ipAddress?: string): Promise<CashRegister> {
    const scope = await this.scopeWith(userId, 'cash.settings');
    const own = await this.scopes.branchWhere(scope);
    const current = await this.prisma.cashRegister.findFirst({ where: { id, ...own } });
    if (!current) throw fail('notFound', CODES.REGISTER_NOT_FOUND, 'Register not found.');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.cashRegister.update({ where: { id }, data: input });
        await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'cash.register_updated', targetType: 'cash-register', targetId: id, metadata: { from: { name: current.name, isActive: current.isActive }, to: input }, ipAddress }, tx);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw fail('conflict', CODES.REGISTER_NAME_TAKEN, 'Another register at this branch has this name.');
    }
    return (await this.registersFor(scope, current.branchId, false)).find((register) => register.id === id)!;
  }

  private async registersFor(scope: Scope, branchId: string | undefined, activeOnly: boolean): Promise<CashRegister[]> {
    const where = await this.scopes.branchWhere(scope, branchId);
    const rows = await this.prisma.cashRegister.findMany({
      where: { ...where, ...(activeOnly && { isActive: true }) },
      orderBy: [{ branch: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: {
        branch: { select: { name: true } },
        shifts: { where: { status: { not: 'CLOSED' } }, select: { id: true, cashierName: true, openedAt: true }, orderBy: { openedAt: 'asc' } },
      },
    });
    return rows.map((row) => ({
      id: row.id, branchId: row.branchId, branchName: row.branch.name, name: row.name, isActive: row.isActive,
      openShifts: row.shifts.map((shift) => ({ id: shift.id, cashierName: shift.cashierName, openedAt: shift.openedAt.toISOString() })),
    }));
  }

  // --- The caller's drawer ---------------------------------------------------------------------------

  async myDrawer(userId: string): Promise<MyCashDrawer> {
    const scope = await this.scopeWith(userId, 'cash.operate');
    const [row, settings, registers] = await Promise.all([
      this.prisma.cashShift.findFirst({ where: { cashierId: userId, restaurantId: scope.restaurant.id, status: { not: 'CLOSED' } }, include: shiftInclude }),
      this.settings(scope.restaurant.id),
      this.registersFor(scope, undefined, true),
    ]);
    return { shift: row ? (await this.toShifts([row]))[0]! : null, settings, registers };
  }

  async open(userId: string, input: z.output<typeof openCashShiftSchema>, ipAddress?: string): Promise<CashShift> {
    const scope = await this.scopeWith(userId, 'cash.operate');
    const branch = await this.scopes.branch(scope, input.branchId);
    if (!branch.isActive) throw fail('conflict', CODES.REGISTER_UNAVAILABLE, 'This branch is archived.');
    const activeRegisters = await this.prisma.cashRegister.findMany({ where: { branchId: branch.id, isActive: true }, select: { id: true } });
    if (input.registerId) {
      if (!activeRegisters.some((register) => register.id === input.registerId)) throw fail('conflict', CODES.REGISTER_UNAVAILABLE, 'This register is archived or at another branch.');
    } else if (activeRegisters.length) {
      throw fail('bad', CODES.REGISTER_REQUIRED, 'Choose the register you are opening.');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fullName: true } });
    const settings = await this.settings(scope.restaurant.id);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        // Serializes openings on the same register (or the same register-less branch).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-register:${input.registerId ?? branch.id}`}))`;
        const mine = await tx.cashShift.findFirst({ where: { cashierId: userId, status: { not: 'CLOSED' } }, select: { id: true } });
        if (mine) throw fail('conflict', CODES.SHIFT_ALREADY_OPEN, 'You already have an open shift.', { shiftId: mine.id });
        if (input.registerId && !settings.allowSharedRegister) {
          const busy = await tx.cashShift.findFirst({ where: { registerId: input.registerId, status: { not: 'CLOSED' } }, select: { id: true } });
          if (busy) throw fail('conflict', CODES.REGISTER_BUSY, 'Another shift is open on this register.', { shiftId: busy.id });
        }
        const created = await tx.cashShift.create({
          data: {
            restaurantId: scope.restaurant.id, branchId: branch.id, registerId: input.registerId, cashierId: userId, cashierName: user.fullName,
            currency: settings.currency, openingPiastres: input.openingPiastres, openingNote: input.note,
          },
        });
        await this.audit.record({
          actorId: userId, restaurantId: scope.restaurant.id, action: 'cash.shift_opened', targetType: 'cash-shift', targetId: created.id,
          metadata: { branchId: branch.id, registerId: input.registerId, openingPiastres: input.openingPiastres, currency: settings.currency, note: input.note }, ipAddress,
        }, tx);
        return created.id;
      });
      return this.shift(id);
    } catch (error) {
      // The partial unique index: a second device opened a shift for the same cashier at the same moment.
      if (isUniqueViolation(error)) throw fail('conflict', CODES.SHIFT_ALREADY_OPEN, 'You already have an open shift.');
      throw error;
    }
  }

  // --- Movements ---------------------------------------------------------------------------------------

  /** Cash in, cash out, or an adjustment, on the caller's shift (or any, for approvers). */
  async addTransaction(userId: string, shiftId: string, input: z.output<typeof cashTransactionSchema>, ipAddress?: string): Promise<CashShiftDetail> {
    const scope = await this.scopes.resolve(userId);
    const shift = await this.findShift(scope, shiftId);
    this.requireOperator(scope, shift.cashierId);
    if (input.kind === 'ADJUSTMENT' && !scope.permissions.has('cash.adjust') && !scope.permissions.has('cash.approve')) {
      this.scopes.require(scope, 'cash.adjust');
    }
    const settings = await this.settings(scope.restaurant.id);
    const approver = scope.permissions.has('cash.approve');
    const pending = input.kind === 'ADJUSTMENT' && settings.adjustmentsNeedApproval && !approver;
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, shiftId);
      if (status !== 'OPEN') throw notOpen(status);
      const created = await tx.cashTransaction.create({
        data: {
          restaurantId: shift.restaurantId, branchId: shift.branchId, shiftId, kind: input.kind, amountPiastres: input.amountPiastres, reason: input.reason,
          approvalStatus: pending ? 'PENDING' : 'APPROVED', createdById: userId,
          ...(input.kind === 'ADJUSTMENT' && !pending && { approvedById: userId, approvedAt: new Date() }),
        },
      });
      await tx.cashShift.update({ where: { id: shiftId }, data: { version: { increment: 1 } } });
      await this.audit.record({
        actorId: userId, restaurantId: shift.restaurantId, action: input.kind === 'ADJUSTMENT' ? 'cash.adjustment' : 'cash.movement', targetType: 'cash-shift', targetId: shiftId,
        metadata: { transactionId: created.id, kind: input.kind, amountPiastres: input.amountPiastres, reason: input.reason, approvalStatus: created.approvalStatus }, ipAddress,
      }, tx);
    });
    return this.detail(userId, shiftId);
  }

  /**
   * A bill paid (or reversed) in cash, inside the transaction that marks it: it goes to the caller's
   * open shift at the order's branch, or else the branch's only open shift. Without one it is not in
   * any drawer, unless the settings require a shift. The source key makes a repeat a no-op.
   */
  async recordOrderCash(tx: Tx, event: OrderCashEvent): Promise<void> {
    if (event.amountPiastres <= 0) return;
    const settings = await this.settings(event.scope.restaurant.id, tx);
    const shiftId = await this.drawerFor(tx, event.scope.userId, event.branchId);
    if (!shiftId) {
      if (settings.requireShiftForCash) throw fail('conflict', CODES.SHIFT_REQUIRED, 'Open your cash shift before taking or refunding cash.');
      return;
    }
    const status = await this.lock(tx, shiftId);
    if (status !== 'OPEN') {
      if (settings.requireShiftForCash) throw notOpen(status);
      return;
    }
    const sourceKey = `order:${event.orderId}:${event.kind.toLowerCase()}:${event.paidAt.getTime()}`;
    // ON CONFLICT DO NOTHING: a concurrent or retried request with the same event adds nothing.
    const { count } = await tx.cashTransaction.createMany({
      data: [{
        restaurantId: event.scope.restaurant.id, branchId: event.branchId, shiftId, kind: event.kind, amountPiastres: event.amountPiastres,
        orderId: event.orderId, sourceKey, createdById: event.scope.userId,
      }],
      skipDuplicates: true,
    });
    if (count) await tx.cashShift.update({ where: { id: shiftId }, data: { version: { increment: 1 } } });
  }

  private async drawerFor(tx: Tx, userId: string, branchId: string): Promise<string | null> {
    const mine = await tx.cashShift.findFirst({ where: { cashierId: userId, branchId, status: 'OPEN' }, select: { id: true } });
    if (mine) return mine.id;
    const open = await tx.cashShift.findMany({ where: { branchId, status: 'OPEN' }, select: { id: true }, take: 2 });
    return open.length === 1 ? open[0]!.id : null;
  }

  // --- Closing -----------------------------------------------------------------------------------------

  /** The cashier starts counting: the drawer takes no more movements until closed or reopened. */
  async startClosing(userId: string, shiftId: string, ipAddress?: string): Promise<CashShift> {
    return this.moveStatus(userId, shiftId, 'OPEN', 'CLOSING', 'cash.closing_started', ipAddress);
  }

  /** Back to work: the count was started by mistake. */
  async cancelClosing(userId: string, shiftId: string, ipAddress?: string): Promise<CashShift> {
    return this.moveStatus(userId, shiftId, 'CLOSING', 'OPEN', 'cash.closing_cancelled', ipAddress);
  }

  private async moveStatus(userId: string, shiftId: string, from: 'OPEN' | 'CLOSING', to: 'OPEN' | 'CLOSING', action: string, ipAddress?: string): Promise<CashShift> {
    const scope = await this.scopes.resolve(userId);
    const shift = await this.findShift(scope, shiftId);
    this.requireOperator(scope, shift.cashierId);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, shiftId);
      if (status !== from) throw notOpen(status);
      await tx.cashShift.update({ where: { id: shiftId }, data: { status: to, closingStartedAt: to === 'CLOSING' ? new Date() : null, version: { increment: 1 } } });
      await this.audit.record({ actorId: userId, restaurantId: shift.restaurantId, action, targetType: 'cash-shift', targetId: shiftId, ipAddress }, tx);
    });
    return this.shift(shiftId);
  }

  async close(userId: string, shiftId: string, input: z.output<typeof closeCashShiftSchema>, ipAddress?: string): Promise<CashShift> {
    const scope = await this.scopes.resolve(userId);
    const shift = await this.findShift(scope, shiftId);
    this.requireOperator(scope, shift.cashierId);
    const settings = await this.settings(scope.restaurant.id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, shiftId);
      if (status === 'CLOSED') throw notOpen(status);
      const current = await tx.cashShift.findUniqueOrThrow({ where: { id: shiftId }, select: { version: true, closingStartedAt: true, openingPiastres: true } });
      if (input.version !== undefined && input.version !== current.version) {
        throw fail('conflict', CODES.STALE, 'The shift changed since you opened it. Reload and count again.');
      }
      const summary = (await this.summaries(tx, [{ id: shiftId, openingPiastres: current.openingPiastres }])).get(shiftId)!;
      if (summary.pendingAdjustmentsCount) {
        throw fail('conflict', CODES.ADJUSTMENTS_PENDING, 'Adjustments are waiting for approval.', { count: summary.pendingAdjustmentsCount });
      }
      const discrepancy = cashDiscrepancy(summary.expectedPiastres, input.countedPiastres);
      if (!input.note && closingNoteRequired(settings.closingNote, discrepancy)) {
        throw fail('bad', CODES.NOTE_REQUIRED, 'Add a note explaining the count.', { discrepancyPiastres: discrepancy });
      }
      const reviewStatus: CashReviewStatus = discrepancyNeedsReview(discrepancy, settings.discrepancyTolerancePiastres) ? 'PENDING' : 'NOT_REQUIRED';
      const now = new Date();
      await tx.cashShift.update({
        where: { id: shiftId },
        data: {
          status: 'CLOSED', closingStartedAt: current.closingStartedAt ?? now, closedAt: now, closedById: userId,
          expectedPiastres: summary.expectedPiastres, countedPiastres: input.countedPiastres, discrepancyPiastres: discrepancy,
          closingNote: input.note, reviewStatus, version: { increment: 1 },
        },
      });
      await this.audit.record({
        actorId: userId, restaurantId: shift.restaurantId, action: 'cash.shift_closed', targetType: 'cash-shift', targetId: shiftId,
        metadata: { expectedPiastres: summary.expectedPiastres, countedPiastres: input.countedPiastres, discrepancyPiastres: discrepancy, reviewStatus, note: input.note }, ipAddress,
      }, tx);
    });
    return this.shift(shiftId);
  }

  // --- Review and corrections ---------------------------------------------------------------------------

  async reviewShift(userId: string, shiftId: string, input: z.output<typeof reviewCashSchema>, ipAddress?: string): Promise<CashShift> {
    const scope = await this.scopeWith(userId, 'cash.approve');
    const shift = await this.findShift(scope, shiftId);
    this.refuseSelfReview(scope, shift.cashierId);
    const reviewStatus = input.approve ? 'APPROVED' : 'REJECTED';
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.cashShift.updateMany({
        where: { id: shiftId, status: 'CLOSED', reviewStatus: 'PENDING' },
        data: { reviewStatus, reviewedById: userId, reviewedAt: new Date(), reviewNote: input.note, version: { increment: 1 } },
      });
      if (!count) throw fail('conflict', CODES.ALREADY_REVIEWED, 'This shift needs no review, or was already reviewed.');
      await this.audit.record({
        actorId: userId, restaurantId: shift.restaurantId, action: 'cash.shift_reviewed', targetType: 'cash-shift', targetId: shiftId,
        metadata: { reviewStatus, discrepancyPiastres: shift.discrepancyPiastres, note: input.note }, ipAddress,
      }, tx);
    });
    return this.shift(shiftId);
  }

  async pendingAdjustments(userId: string, branchId?: string): Promise<PendingCashAdjustment[]> {
    const scope = await this.scopeWith(userId, 'cash.approve');
    const where = await this.scopes.branchWhere(scope, branchId);
    const rows = await this.prisma.cashTransaction.findMany({
      where: { ...where, approvalStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { ...transactionInclude, shift: { select: { cashierName: true } }, branch: { select: { name: true } } },
    });
    return rows.map((row) => ({ ...this.toTransaction(row), shiftId: row.shiftId, cashierName: row.shift.cashierName, branchName: row.branch.name }));
  }

  async reviewTransaction(userId: string, transactionId: string, input: z.output<typeof reviewCashSchema>, ipAddress?: string): Promise<CashShiftDetail> {
    const scope = await this.scopeWith(userId, 'cash.approve');
    const where = await this.scopes.branchWhere(scope);
    const row = await this.prisma.cashTransaction.findFirst({ where: { id: transactionId, ...where }, select: { shiftId: true, createdById: true, approvalStatus: true, amountPiastres: true, kind: true } });
    if (!row) throw fail('notFound', CODES.TRANSACTION_NOT_FOUND, 'Transaction not found.');
    this.refuseSelfReview(scope, row.createdById);
    const approvalStatus = input.approve ? 'APPROVED' : 'REJECTED';
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, row.shiftId);
      if (status === 'CLOSED') throw notOpen(status);
      const { count } = await tx.cashTransaction.updateMany({
        where: { id: transactionId, approvalStatus: 'PENDING' },
        data: { approvalStatus, approvedById: userId, approvedAt: new Date() },
      });
      if (!count) throw fail('conflict', CODES.ALREADY_REVIEWED, 'This adjustment was already reviewed.');
      await tx.cashShift.update({ where: { id: row.shiftId }, data: { version: { increment: 1 } } });
      await this.audit.record({
        actorId: userId, restaurantId: scope.restaurant.id, action: 'cash.adjustment_reviewed', targetType: 'cash-shift', targetId: row.shiftId,
        metadata: { transactionId, approvalStatus, amountPiastres: row.amountPiastres, note: input.note }, ipAddress,
      }, tx);
    });
    return this.detail(userId, row.shiftId);
  }

  /** The authorized way to change a closed shift: a recount and/or a missed movement, with a reason. */
  async correct(userId: string, shiftId: string, input: z.output<typeof cashCorrectionSchema>, ipAddress?: string): Promise<CashShiftDetail> {
    const scope = await this.scopeWith(userId, 'cash.approve');
    const shift = await this.findShift(scope, shiftId);
    const settings = await this.settings(scope.restaurant.id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, shiftId);
      if (status !== 'CLOSED') throw fail('conflict', CODES.SHIFT_NOT_OPEN, 'Only a closed shift is corrected; change an open one directly.', { status });
      const before = await tx.cashShift.findUniqueOrThrow({ where: { id: shiftId } });
      if (input.adjustmentPiastres !== undefined) {
        await tx.cashTransaction.create({
          data: {
            restaurantId: before.restaurantId, branchId: before.branchId, shiftId, kind: 'CORRECTION', amountPiastres: input.adjustmentPiastres, reason: input.reason,
            createdById: userId, approvedById: userId, approvedAt: new Date(),
          },
        });
      }
      const summary = (await this.summaries(tx, [{ id: shiftId, openingPiastres: before.openingPiastres }])).get(shiftId)!;
      const counted = input.countedPiastres ?? before.countedPiastres ?? 0;
      const discrepancy = cashDiscrepancy(summary.expectedPiastres, counted);
      // The approver's correction settles the review, unless it is their own shift.
      const reviewStatus: CashReviewStatus = !discrepancyNeedsReview(discrepancy, settings.discrepancyTolerancePiastres) ? 'NOT_REQUIRED'
        : this.isSelf(scope, before.cashierId) ? 'PENDING' : 'APPROVED';
      await tx.cashShift.update({
        where: { id: shiftId },
        data: {
          expectedPiastres: summary.expectedPiastres, countedPiastres: counted, discrepancyPiastres: discrepancy, reviewStatus,
          ...(reviewStatus === 'APPROVED' ? { reviewedById: userId, reviewedAt: new Date(), reviewNote: input.reason } : { reviewedById: null, reviewedAt: null, reviewNote: null }),
          version: { increment: 1 },
        },
      });
      await this.audit.record({
        actorId: userId, restaurantId: shift.restaurantId, action: 'cash.correction', targetType: 'cash-shift', targetId: shiftId,
        metadata: {
          reason: input.reason, adjustmentPiastres: input.adjustmentPiastres ?? null,
          from: { expectedPiastres: before.expectedPiastres, countedPiastres: before.countedPiastres, discrepancyPiastres: before.discrepancyPiastres, reviewStatus: before.reviewStatus },
          to: { expectedPiastres: summary.expectedPiastres, countedPiastres: counted, discrepancyPiastres: discrepancy, reviewStatus },
        },
        ipAddress,
      }, tx);
    });
    return this.detail(userId, shiftId);
  }

  // --- Reading ------------------------------------------------------------------------------------------

  async list(userId: string, query: z.output<typeof cashShiftsQuerySchema>): Promise<Paginated<CashShift>> {
    const scope = await this.scopeWithAny(userId, ['cash.operate', 'cash.view', 'cash.approve']);
    const branch = await this.scopes.branchWhere(scope, query.branchId);
    const seesAll = scope.permissions.has('cash.view') || scope.permissions.has('cash.approve');
    const where: Prisma.CashShiftWhereInput = {
      ...branch,
      cashierId: seesAll ? query.cashierId : userId,
      ...(query.registerId && { registerId: query.registerId }),
      ...(query.status && { status: query.status }),
      ...(query.review && { reviewStatus: query.review }),
      ...((query.from || query.to) && { openedAt: this.range(scope, query.from, query.to) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.cashShift.findMany({ where, include: shiftInclude, orderBy: { openedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.cashShift.count({ where }),
    ]);
    return { items: await this.toShifts(rows), total, page: query.page, pageSize: query.pageSize };
  }

  async detail(userId: string, shiftId: string): Promise<CashShiftDetail> {
    const scope = await this.scopes.resolve(userId);
    await this.findShift(scope, shiftId);
    const [shift, transactions, logs] = await Promise.all([
      this.shift(shiftId),
      this.prisma.cashTransaction.findMany({ where: { shiftId }, include: transactionInclude, orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.findMany({ where: { targetType: 'cash-shift', targetId: shiftId }, include: { actor: { select: { fullName: true } } }, orderBy: { createdAt: 'asc' }, take: 500 }),
    ]);
    return {
      ...shift,
      transactions: transactions.map((row) => this.toTransaction(row)),
      history: logs.map((log) => ({ action: log.action, actorName: log.actor?.fullName ?? null, at: log.createdAt.toISOString(), metadata: (log.metadata as Record<string, unknown> | null) ?? null })),
    };
  }

  async report(userId: string, query: z.output<typeof cashReportQuerySchema>): Promise<CashReport> {
    const scope = await this.scopeWith(userId, 'cash.view');
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
    if (days < 0 || days >= CASH_LIMITS.reportDays) throw fail('bad', COMMON_ERROR_CODES.VALIDATION_FAILED, `Choose a range of 1 to ${CASH_LIMITS.reportDays} days.`);
    const branch = await this.scopes.branchWhere(scope, query.branchId);
    const shifts = await this.prisma.cashShift.findMany({
      where: { ...branch, ...(query.cashierId && { cashierId: query.cashierId }), openedAt: this.range(scope, query.from, query.to) },
      select: {
        id: true, branchId: true, cashierId: true, cashierName: true, status: true, openingPiastres: true, discrepancyPiastres: true, reviewStatus: true,
        closingStartedAt: true, closedAt: true, branch: { select: { name: true } },
      },
    });
    const summaries = await this.summaries(this.prisma, shifts);
    const byCashier = new Map<string, CashReportRow>();
    const byBranch = new Map<string, CashReportRow>();
    const closing = new Map<CashReportRow, number[]>();
    const totals = this.emptyRow('all', 'all');
    const add = (row: CashReportRow, shift: (typeof shifts)[number]) => {
      const summary = summaries.get(shift.id)!;
      row.shifts += 1;
      row.cashSalesPiastres += summary.cashSalesPiastres;
      row.cashRefundsPiastres += summary.cashRefundsPiastres;
      row.unapprovedAdjustments += summary.pendingAdjustmentsCount;
      if (shift.reviewStatus === 'PENDING') row.pendingReviews += 1;
      if (shift.status !== 'CLOSED') return;
      row.closedShifts += 1;
      const discrepancy = shift.discrepancyPiastres ?? 0;
      if (discrepancy) row.discrepancyShifts += 1;
      row.netDiscrepancyPiastres += discrepancy;
      if (discrepancy < 0) row.shortagePiastres += discrepancy;
      if (discrepancy > 0) row.overagePiastres += discrepancy;
      if (shift.closedAt && shift.closingStartedAt) {
        const list = closing.get(row) ?? [];
        list.push((shift.closedAt.getTime() - shift.closingStartedAt.getTime()) / 1000);
        closing.set(row, list);
      }
    };
    for (const shift of shifts) {
      const cashierKey = shift.cashierId ?? `name:${shift.cashierName}`;
      if (!byCashier.has(cashierKey)) byCashier.set(cashierKey, this.emptyRow(shift.cashierId ?? cashierKey, shift.cashierName));
      if (!byBranch.has(shift.branchId)) byBranch.set(shift.branchId, this.emptyRow(shift.branchId, shift.branch.name));
      add(byCashier.get(cashierKey)!, shift);
      add(byBranch.get(shift.branchId)!, shift);
      add(totals, shift);
    }
    for (const [row, seconds] of closing) row.averageClosingSeconds = Math.round(seconds.reduce((sum, value) => sum + value, 0) / seconds.length);
    const sort = (rows: Iterable<CashReportRow>) => [...rows].sort((a, b) => a.netDiscrepancyPiastres - b.netDiscrepancyPiastres || b.shifts - a.shifts);
    return {
      from: query.from,
      to: query.to,
      totals: {
        ...totals,
        discrepancyRate: totals.closedShifts ? totals.discrepancyShifts / totals.closedShifts : null,
        completionRate: totals.shifts ? totals.closedShifts / totals.shifts : null,
      },
      byCashier: sort(byCashier.values()),
      byBranch: sort(byBranch.values()),
    };
  }

  // --- Helpers ----------------------------------------------------------------------------------------

  private emptyRow(id: string, name: string): CashReportRow {
    return {
      id, name, shifts: 0, closedShifts: 0, discrepancyShifts: 0, netDiscrepancyPiastres: 0, shortagePiastres: 0, overagePiastres: 0,
      cashSalesPiastres: 0, cashRefundsPiastres: 0, pendingReviews: 0, unapprovedAdjustments: 0, averageClosingSeconds: null,
    };
  }

  /** Local days (restaurant time zone), both inclusive. */
  private range(scope: Scope, from?: string, to?: string): Prisma.DateTimeFilter {
    const zone = scope.restaurant.timezone;
    const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return { ...(from && { gte: zonedInstant(from, '00:00', zone) }), ...(to && { lt: zonedInstant(nextDay(to), '00:00', zone) }) };
  }

  /** Locks the shift row until the transaction ends, and returns its status. */
  private async lock(tx: Tx, shiftId: string): Promise<'OPEN' | 'CLOSING' | 'CLOSED'> {
    const rows = await tx.$queryRaw<{ status: 'OPEN' | 'CLOSING' | 'CLOSED' }[]>`SELECT status FROM cash_shifts WHERE id = ${shiftId}::uuid FOR UPDATE`;
    if (!rows[0]) throw shiftNotFound();
    return rows[0].status;
  }

  /** A shift the caller may see: their own, or any in their branches with cash.view or cash.approve. */
  private async findShift(scope: Scope, shiftId: string) {
    const where = await this.scopes.branchWhere(scope);
    const shift = await this.prisma.cashShift.findFirst({ where: { id: shiftId, ...where } });
    if (!shift) throw shiftNotFound();
    const seesAll = scope.permissions.has('cash.view') || scope.permissions.has('cash.approve');
    if (shift.cashierId !== scope.userId && !seesAll) throw shiftNotFound();
    return shift;
  }

  /** Cashiers work their own drawer; approvers may act on anyone's (a cashier who left without closing). */
  private requireOperator(scope: Scope, cashierId: string | null): void {
    if (cashierId === scope.userId) this.scopes.require(scope, 'cash.operate');
    else this.scopes.require(scope, 'cash.approve');
  }

  private isSelf(scope: Scope, userId: string | null): boolean {
    return scope.role !== 'OWNER' && userId === scope.userId;
  }

  private refuseSelfReview(scope: Scope, userId: string | null): void {
    if (this.isSelf(scope, userId)) throw fail('forbidden', CODES.SELF_REVIEW, 'Someone else must approve your own cash.');
  }

  private async scopeWith(userId: string, permission: Permission): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, permission);
    return scope;
  }

  private async scopeWithAny(userId: string, permissions: Permission[]): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    if (!permissions.some((permission) => scope.permissions.has(permission))) this.scopes.require(scope, permissions[0]!);
    return scope;
  }

  private async summaries(tx: Tx, shifts: { id: string; openingPiastres: number }[]): Promise<Map<string, CashShiftSummary>> {
    const groups = shifts.length
      ? await tx.cashTransaction.groupBy({ by: ['shiftId', 'kind', 'approvalStatus'], where: { shiftId: { in: shifts.map((shift) => shift.id) } }, _sum: { amountPiastres: true }, _count: { _all: true } })
      : [];
    return new Map(shifts.map((shift) => [shift.id, summarize(shift.openingPiastres, groups
      .filter((group) => group.shiftId === shift.id)
      .map((group) => ({ kind: group.kind, approvalStatus: group.approvalStatus, sum: group._sum.amountPiastres ?? 0, count: group._count._all })))]));
  }

  private async shift(id: string): Promise<CashShift> {
    const row = await this.prisma.cashShift.findUniqueOrThrow({ where: { id }, include: shiftInclude });
    return (await this.toShifts([row]))[0]!;
  }

  private async toShifts(rows: ShiftRow[]): Promise<CashShift[]> {
    const summaries = await this.summaries(this.prisma, rows);
    return rows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      register: row.register,
      cashier: { id: row.cashierId ?? '', name: row.cashierName },
      status: row.status,
      currency: row.currency,
      openingPiastres: row.openingPiastres,
      openingNote: row.openingNote,
      openedAt: row.openedAt.toISOString(),
      closingStartedAt: row.closingStartedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: row.closedBy?.fullName ?? null,
      expectedPiastres: row.expectedPiastres,
      countedPiastres: row.countedPiastres,
      discrepancyPiastres: row.discrepancyPiastres,
      closingNote: row.closingNote,
      reviewStatus: row.reviewStatus,
      reviewedBy: row.reviewedBy?.fullName ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      version: row.version,
      summary: summaries.get(row.id)!,
    }));
  }

  private toTransaction(row: TransactionRow): CashTransaction {
    return {
      id: row.id,
      kind: row.kind,
      amountPiastres: row.amountPiastres,
      effectPiastres: cashEffect(row.kind, row.amountPiastres, row.approvalStatus),
      reason: row.reason,
      order: row.order,
      approvalStatus: row.approvalStatus,
      approvedBy: row.approvedBy?.fullName ?? null,
      createdBy: row.createdBy?.fullName ?? null,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
