import { z } from 'zod';

/**
 * Cashier shifts and cash reconciliation. A cashier opens a shift on a register with the cash in the
 * drawer, the drawer then follows every cash movement (cash bills paid, cash refunds, cash in and
 * out, manual adjustments), and closing compares the expected cash with what was counted. Only
 * cash counts: bills paid by card or wallet never touch the drawer. Amounts are in piastres.
 */

export const CASH_ERROR_CODES = {
  SHIFT_NOT_FOUND: 'CASH_SHIFT_NOT_FOUND',
  REGISTER_NOT_FOUND: 'CASH_REGISTER_NOT_FOUND',
  REGISTER_NAME_TAKEN: 'CASH_REGISTER_NAME_TAKEN',
  /** 409: the caller already has an open shift. details: { shiftId } */
  SHIFT_ALREADY_OPEN: 'CASH_SHIFT_ALREADY_OPEN',
  /** 409: someone else's shift is open on this register (and the settings allow one at a time). details: { shiftId } */
  REGISTER_BUSY: 'CASH_REGISTER_BUSY',
  /** 409: the register is archived or belongs to another branch. */
  REGISTER_UNAVAILABLE: 'CASH_REGISTER_UNAVAILABLE',
  /** 400: the branch has registers, so the shift must name one. */
  REGISTER_REQUIRED: 'CASH_REGISTER_REQUIRED',
  /** 409: the shift is not in a state that allows this. details: { status } */
  SHIFT_NOT_OPEN: 'CASH_SHIFT_NOT_OPEN',
  /** 409: a closed shift changes only through a correction. */
  SHIFT_CLOSED: 'CASH_SHIFT_CLOSED',
  /** 409: a cash payment or refund needs an open shift (the settings say so). */
  SHIFT_REQUIRED: 'CASH_SHIFT_REQUIRED',
  /** 409: adjustments are waiting for approval; review them before closing. details: { count } */
  ADJUSTMENTS_PENDING: 'CASH_ADJUSTMENTS_PENDING',
  /** 400: the settings require a closing note (always, or when the count differs). */
  NOTE_REQUIRED: 'CASH_NOTE_REQUIRED',
  /** 409: the shift (or adjustment) was already reviewed, or needs no review. */
  ALREADY_REVIEWED: 'CASH_ALREADY_REVIEWED',
  /** 403: nobody approves their own shift or adjustment (the owner excepted). */
  SELF_REVIEW: 'CASH_SELF_REVIEW',
  TRANSACTION_NOT_FOUND: 'CASH_TRANSACTION_NOT_FOUND',
  /** 409: the shift changed meanwhile (another device closed it, ...). Reload and retry. */
  STALE: 'CASH_STALE',
} as const;

export const CASH_LIMITS = {
  /** 1,000,000 EGP: a guard against typos, not a business rule. */
  maxAmountPiastres: 100_000_000,
  registersPerBranch: 20,
  /** Reports cover at most this many days. */
  reportDays: 92,
  reasonLength: 300,
  noteLength: 500,
} as const;

export const CASH_SHIFT_STATUSES = ['OPEN', 'CLOSING', 'CLOSED'] as const;
export type CashShiftStatus = (typeof CASH_SHIFT_STATUSES)[number];

/** Whether a closed shift's count needed (and got) a manager's approval. */
export const CASH_REVIEW_STATUSES = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type CashReviewStatus = (typeof CASH_REVIEW_STATUSES)[number];

/**
 * SALE and REFUND come from bills paid (or reversed) in cash. CASH_IN and CASH_OUT are money put in
 * or taken out (change float, a supplier paid from the drawer). ADJUSTMENT fixes the drawer during
 * the shift, CORRECTION fixes a closed shift; both are signed and need a reason.
 */
export const CASH_TRANSACTION_KINDS = ['SALE', 'REFUND', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT', 'CORRECTION'] as const;
export type CashTransactionKind = (typeof CASH_TRANSACTION_KINDS)[number];

/** What a cashier may record by hand. */
export const MANUAL_CASH_KINDS = ['CASH_IN', 'CASH_OUT', 'ADJUSTMENT'] as const satisfies readonly CashTransactionKind[];
export type ManualCashKind = (typeof MANUAL_CASH_KINDS)[number];

export const CASH_APPROVAL_STATUSES = ['APPROVED', 'PENDING', 'REJECTED'] as const;
export type CashApprovalStatus = (typeof CASH_APPROVAL_STATUSES)[number];

/** How a bill was paid. Only CASH reaches the drawer. */
export const ORDER_PAYMENT_METHODS = ['CASH', 'CARD', 'WALLET', 'OTHER'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const CLOSING_NOTE_RULES = ['NEVER', 'ON_DISCREPANCY', 'ALWAYS'] as const;
export type ClosingNoteRule = (typeof CLOSING_NOTE_RULES)[number];

/** The effect of a transaction on the drawer: +1 adds cash, -1 removes it; signed kinds carry their own sign. */
export const CASH_KIND_SIGN: Record<CashTransactionKind, 1 | -1> = {
  SALE: 1, REFUND: -1, CASH_IN: 1, CASH_OUT: -1, ADJUSTMENT: 1, CORRECTION: 1,
};

/** Kinds stored with a sign (an adjustment may add or remove cash). */
export const SIGNED_CASH_KINDS: readonly CashTransactionKind[] = ['ADJUSTMENT', 'CORRECTION'];

/** A transaction's effect on the expected cash, in piastres (0 unless approved). */
export function cashEffect(kind: CashTransactionKind, amountPiastres: number, approval: CashApprovalStatus = 'APPROVED'): number {
  if (approval !== 'APPROVED') return 0;
  return SIGNED_CASH_KINDS.includes(kind) ? amountPiastres : CASH_KIND_SIGN[kind] * Math.abs(amountPiastres);
}

/** Counted minus expected: negative is a shortage, positive an overage. */
export const cashDiscrepancy = (expectedPiastres: number, countedPiastres: number) => countedPiastres - expectedPiastres;

/** Whether a closing note is needed under the rule. */
export function closingNoteRequired(rule: ClosingNoteRule, discrepancyPiastres: number): boolean {
  return rule === 'ALWAYS' || (rule === 'ON_DISCREPANCY' && discrepancyPiastres !== 0);
}

/** Whether a count needs a manager's approval: the difference is beyond the tolerance. */
export const discrepancyNeedsReview = (discrepancyPiastres: number, tolerancePiastres: number) => Math.abs(discrepancyPiastres) > tolerancePiastres;

const amount = z.number().int().min(0).max(CASH_LIMITS.maxAmountPiastres);
const positiveAmount = z.number().int().min(1).max(CASH_LIMITS.maxAmountPiastres);
const signedAmount = z.number().int().min(-CASH_LIMITS.maxAmountPiastres).max(CASH_LIMITS.maxAmountPiastres).refine((value) => value !== 0, 'Must not be zero');
const reason = z.string().trim().min(3).max(CASH_LIMITS.reasonLength);
const optionalNote = z.string().trim().max(CASH_LIMITS.noteLength).nullish().transform((value) => value || null);

// --- Settings and registers --------------------------------------------------------------------------

export const cashSettingsSchema = z.strictObject({
  /** More than one cashier's shift may be open on a register at once. */
  allowSharedRegister: z.boolean(),
  /** A cash bill can be marked paid (or reversed) only while the caller has an open shift. */
  requireShiftForCash: z.boolean(),
  /** Adjustments wait for a manager unless made by someone who may approve them. */
  adjustmentsNeedApproval: z.boolean(),
  /** Counts within this many piastres of the expected cash need no approval. */
  discrepancyTolerancePiastres: z.number().int().min(0).max(1_000_000),
  closingNote: z.enum(CLOSING_NOTE_RULES),
});
export type CashSettings = z.infer<typeof cashSettingsSchema> & { currency: string; updatedAt: string | null };

export const DEFAULT_CASH_SETTINGS: z.infer<typeof cashSettingsSchema> = {
  allowSharedRegister: false,
  requireShiftForCash: false,
  adjustmentsNeedApproval: true,
  discrepancyTolerancePiastres: 0,
  closingNote: 'ON_DISCREPANCY',
};

export const createCashRegisterSchema = z.strictObject({
  branchId: z.uuid(),
  name: z.string().trim().min(1).max(40),
});
export const updateCashRegisterSchema = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
});

export type CashRegister = {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  isActive: boolean;
  /** The shift(s) open on it now. */
  openShifts: { id: string; cashierName: string; openedAt: string }[];
};

// --- Shifts ------------------------------------------------------------------------------------------

export const openCashShiftSchema = z.strictObject({
  /** Defaults to the caller's branch (or the main branch for all-branch accounts). */
  branchId: z.uuid().optional(),
  /** Required when the branch has active registers. */
  registerId: z.uuid().nullish().transform((value) => value ?? null),
  openingPiastres: amount,
  note: optionalNote,
});

export const cashTransactionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CASH_IN'), amountPiastres: positiveAmount, reason }),
  z.strictObject({ kind: z.literal('CASH_OUT'), amountPiastres: positiveAmount, reason }),
  /** Signed: positive adds cash to the drawer, negative removes it. */
  z.strictObject({ kind: z.literal('ADJUSTMENT'), amountPiastres: signedAmount, reason }),
]);

export const closeCashShiftSchema = z.strictObject({
  countedPiastres: amount,
  note: optionalNote,
  /** The shift's version the cashier saw, so a stale screen cannot close it. */
  version: z.number().int().min(0).optional(),
});

export const reviewCashSchema = z.strictObject({
  approve: z.boolean(),
  note: optionalNote,
});

/** A change to a closed shift: a recount, a missed movement, or both. */
export const cashCorrectionSchema = z
  .strictObject({
    reason,
    countedPiastres: amount.optional(),
    adjustmentPiastres: signedAmount.optional(),
  })
  .refine((value) => value.countedPiastres !== undefined || value.adjustmentPiastres !== undefined, { message: 'Give a new count or an adjustment', path: ['countedPiastres'] });

export const cashShiftsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  registerId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(CASH_SHIFT_STATUSES).optional(),
  review: z.enum(CASH_REVIEW_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const cashReportQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  branchId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
});

/** The drawer's movements in totals. expectedPiastres = opening + sales − refunds + in − out + adjustments. */
export type CashShiftSummary = {
  openingPiastres: number;
  cashSalesPiastres: number;
  cashSalesCount: number;
  cashRefundsPiastres: number;
  cashRefundsCount: number;
  cashInPiastres: number;
  cashOutPiastres: number;
  /** Approved adjustments and corrections, signed. */
  adjustmentsPiastres: number;
  /** Adjustments waiting for approval (not in the expected cash). */
  pendingAdjustmentsCount: number;
  pendingAdjustmentsPiastres: number;
  expectedPiastres: number;
};

export type CashShift = {
  id: string;
  branchId: string;
  branchName: string;
  register: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  status: CashShiftStatus;
  currency: string;
  openingPiastres: number;
  openingNote: string | null;
  openedAt: string;
  closingStartedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  /** Recorded at closing (and after corrections); null while open. */
  expectedPiastres: number | null;
  countedPiastres: number | null;
  discrepancyPiastres: number | null;
  closingNote: string | null;
  reviewStatus: CashReviewStatus | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Bumped on every change; send it back when closing. */
  version: number;
  summary: CashShiftSummary;
};

export type CashTransaction = {
  id: string;
  kind: CashTransactionKind;
  /** As stored: positive for SALE, REFUND, CASH_IN, CASH_OUT; signed for ADJUSTMENT and CORRECTION. */
  amountPiastres: number;
  /** The effect on the drawer (0 while pending or when rejected). */
  effectPiastres: number;
  reason: string | null;
  order: { id: string; number: number } | null;
  approvalStatus: CashApprovalStatus;
  approvedBy: string | null;
  createdBy: string | null;
  /** Nobody approves their own adjustment (the owner excepted). */
  createdById: string | null;
  createdAt: string;
};

/** One line of a shift's audit trail. */
export type CashShiftEvent = { action: string; actorName: string | null; at: string; metadata: Record<string, unknown> | null };

export type CashShiftDetail = CashShift & { transactions: CashTransaction[]; history: CashShiftEvent[] };

/** The caller's own active shift (if any), what they may do, and the registers they may open on. */
export type MyCashDrawer = {
  shift: CashShift | null;
  settings: CashSettings;
  registers: CashRegister[];
};

export type PendingCashAdjustment = CashTransaction & { shiftId: string; cashierName: string; branchName: string };

// --- Reports -----------------------------------------------------------------------------------------

export type CashReportRow = {
  /** A cashier's or a branch's id. */
  id: string;
  name: string;
  shifts: number;
  closedShifts: number;
  /** Closed shifts whose count differed from the expected cash. */
  discrepancyShifts: number;
  /** Sum of shortages (negative) and overages (positive). */
  netDiscrepancyPiastres: number;
  shortagePiastres: number;
  overagePiastres: number;
  cashSalesPiastres: number;
  cashRefundsPiastres: number;
  pendingReviews: number;
  unapprovedAdjustments: number;
  /** From starting to close until closed; null without closed shifts. */
  averageClosingSeconds: number | null;
};

export type CashReport = {
  from: string;
  to: string;
  totals: CashReportRow & {
    /** discrepancyShifts / closedShifts; null without closed shifts. */
    discrepancyRate: number | null;
    /** closedShifts / shifts; null without shifts. */
    completionRate: number | null;
  };
  byCashier: CashReportRow[];
  byBranch: CashReportRow[];
};

/** Names on screen: [Arabic, English]. */
export const CASH_SHIFT_STATUS_LABELS: Record<CashShiftStatus, [string, string]> = {
  OPEN: ['مفتوح', 'Open'],
  CLOSING: ['بيتقفل', 'Closing'],
  CLOSED: ['مقفول', 'Closed'],
};

export const CASH_REVIEW_STATUS_LABELS: Record<CashReviewStatus, [string, string]> = {
  NOT_REQUIRED: ['مطابق', 'Balanced'],
  PENDING: ['مستني مراجعة', 'Awaiting review'],
  APPROVED: ['اتوافق عليه', 'Approved'],
  REJECTED: ['اترفض', 'Rejected'],
};

export const CASH_TRANSACTION_KIND_LABELS: Record<CashTransactionKind, [string, string]> = {
  SALE: ['بيع كاش', 'Cash sale'],
  REFUND: ['مرتجع كاش', 'Cash refund'],
  CASH_IN: ['إيداع في الدرج', 'Cash in'],
  CASH_OUT: ['سحب من الدرج', 'Cash out'],
  ADJUSTMENT: ['تسوية', 'Adjustment'],
  CORRECTION: ['تصحيح بعد القفل', 'Correction'],
};

export const ORDER_PAYMENT_METHOD_LABELS: Record<OrderPaymentMethod, [string, string]> = {
  CASH: ['كاش', 'Cash'],
  CARD: ['كارت', 'Card'],
  WALLET: ['محفظة', 'Wallet'],
  OTHER: ['أخرى', 'Other'],
};
