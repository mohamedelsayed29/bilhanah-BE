import { z } from 'zod';
import { PLAN_CODES, type PlanCode, type RestaurantAccess } from './plans.js';
import type { PublicPlan } from './public.js';

export const PAYMENT_METHODS = ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Billing periods an owner can pay for at once. */
export const BILLING_MONTHS = [1, 3, 6, 12] as const;
export type BillingMonths = (typeof BILLING_MONTHS)[number];

export const BILLING_ERROR_CODES = {
  PAYMENT_ALREADY_PENDING: 'PAYMENT_ALREADY_PENDING',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_NOT_PENDING: 'PAYMENT_NOT_PENDING',
  PAYMENT_METHOD_UNAVAILABLE: 'PAYMENT_METHOD_UNAVAILABLE',
} as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const submitPaymentSchema = z.strictObject({
  planCode: z.enum(PLAN_CODES),
  months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  method: z.enum(PAYMENT_METHODS),
  /** The transfer reference from the receipt or confirmation SMS. */
  reference: z.string().trim().min(3).max(100),
  payerName: optionalText(80),
  /** An image uploaded with POST /v1/media?kind=PAYMENT_PROOF. */
  proofId: z.uuid().nullable().optional(),
});

export const paymentIdParamSchema = z.uuid();

/** Where to send money; a method is offered only when its details are set. */
export type PaymentInstructions = {
  instapayAddress: string | null;
  vodafoneCashNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  notesAr: string | null;
  notesEn: string | null;
};

export type OwnerPayment = {
  id: string;
  planCode: PlanCode;
  months: number;
  amountPiastres: number;
  method: PaymentMethod;
  reference: string;
  payerName: string | null;
  status: PaymentStatus;
  hasProof: boolean;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  /** The paid period, once approved. */
  period: { startsAt: string; endsAt: string } | null;
};

export type BillingSummary = {
  access: RestaurantAccess;
  plans: PublicPlan[];
  months: readonly BillingMonths[];
  instructions: PaymentInstructions;
  availableMethods: PaymentMethod[];
  /** A new paid period starts here: the end of the current coverage, or now. */
  nextPeriodStartsAt: string;
  pendingPayment: OwnerPayment | null;
  payments: OwnerPayment[];
};
