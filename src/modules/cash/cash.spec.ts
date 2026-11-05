import { cashDiscrepancy, cashEffect, closingNoteRequired, discrepancyNeedsReview } from '@bilhanah/contracts';
import { summarize } from './cash.service.js';

describe('cash reconciliation', () => {
  it('adds sales and cash in, removes refunds and cash out', () => {
    expect(cashEffect('SALE', 5000)).toBe(5000);
    expect(cashEffect('CASH_IN', 1000)).toBe(1000);
    expect(cashEffect('REFUND', 2000)).toBe(-2000);
    expect(cashEffect('CASH_OUT', 300)).toBe(-300);
    expect(cashEffect('ADJUSTMENT', -150)).toBe(-150);
    expect(cashEffect('CORRECTION', 400)).toBe(400);
  });

  it('ignores adjustments until approved', () => {
    expect(cashEffect('ADJUSTMENT', 500, 'PENDING')).toBe(0);
    expect(cashEffect('ADJUSTMENT', 500, 'REJECTED')).toBe(0);
  });

  it('expects opening + sales − refunds + in − out + approved adjustments', () => {
    const summary = summarize(10_000, [
      { kind: 'SALE', approvalStatus: 'APPROVED', sum: 25_000, count: 3 },
      { kind: 'REFUND', approvalStatus: 'APPROVED', sum: 4_000, count: 1 },
      { kind: 'CASH_IN', approvalStatus: 'APPROVED', sum: 2_000, count: 1 },
      { kind: 'CASH_OUT', approvalStatus: 'APPROVED', sum: 7_000, count: 2 },
      { kind: 'ADJUSTMENT', approvalStatus: 'APPROVED', sum: -500, count: 1 },
      { kind: 'ADJUSTMENT', approvalStatus: 'PENDING', sum: 900, count: 1 },
      { kind: 'ADJUSTMENT', approvalStatus: 'REJECTED', sum: 10_000, count: 1 },
    ]);
    expect(summary.expectedPiastres).toBe(10_000 + 25_000 - 4_000 + 2_000 - 7_000 - 500);
    expect(summary).toMatchObject({ cashSalesCount: 3, cashRefundsPiastres: 4_000, pendingAdjustmentsCount: 1, pendingAdjustmentsPiastres: 900, adjustmentsPiastres: -500 });
  });

  it('measures the count against the expected cash', () => {
    expect(cashDiscrepancy(20_000, 19_500)).toBe(-500);
    expect(discrepancyNeedsReview(-500, 500)).toBe(false);
    expect(discrepancyNeedsReview(-501, 500)).toBe(true);
    expect(closingNoteRequired('ON_DISCREPANCY', 0)).toBe(false);
    expect(closingNoteRequired('ON_DISCREPANCY', 1)).toBe(true);
    expect(closingNoteRequired('ALWAYS', 0)).toBe(true);
    expect(closingNoteRequired('NEVER', -9_000)).toBe(false);
  });
});
