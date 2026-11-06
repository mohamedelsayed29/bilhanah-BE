import { z } from 'zod';
import { PAYMENT_STATUSES } from './billing.js';
import type { OwnerPayment, PaymentInstructions } from './billing.js';
import { emailSchema } from './common.js';
import { type AccessStatus, PLAN_CODES, type PlanCode, type RestaurantAccess } from './plans.js';

export const ADMIN_ERROR_CODES = {
  /** The administrator has no authenticator set up; an operator must run admin:reset-mfa. */
  MFA_NOT_SET_UP: 'MFA_NOT_SET_UP',
  ALREADY_SUSPENDED: 'ALREADY_SUSPENDED',
  NOT_SUSPENDED: 'NOT_SUSPENDED',
} as const;

/** Password plus the 6-digit code from the administrator's authenticator app. */
export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  /** Required unless the API runs locally with ADMIN_MFA_DISABLED. */
  code: z.string().trim().regex(/^(\d{6})?$/, 'Enter the 6-digit code.').optional().transform((value) => value || undefined),
});

const reasonSchema = z.string().trim().min(3).max(300);

export const adminRestaurantsQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  access: z.enum(['TRIAL', 'PAID', 'INACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminPaymentsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const AUDIT_SCOPES = ['platform', 'restaurant'] as const;
/** platform: the admin console and payments; restaurant: what restaurants did themselves (their staff changes). */
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export const adminAuditQuerySchema = z.object({
  /** One kind of change; both when omitted. */
  scope: z.enum(AUDIT_SCOPES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const suspendRestaurantSchema = z.strictObject({ reason: reasonSchema });
export const rejectPaymentSchema = z.strictObject({ reason: reasonSchema });

/** A paid period granted by hand (e.g. cash, a correction or a gift); starts when current coverage ends. */
export const grantEntitlementSchema = z.strictObject({
  planCode: z.enum(PLAN_CODES),
  months: z.number().int().min(1).max(24),
  note: reasonSchema,
});

const optionalSetting = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const updatePaymentSettingsSchema = z.strictObject({
  instapayAddress: optionalSetting(100),
  vodafoneCashNumber: optionalSetting(20),
  bankName: optionalSetting(80),
  bankAccountName: optionalSetting(100),
  bankAccountNumber: optionalSetting(40),
  notesAr: optionalSetting(500),
  notesEn: optionalSetting(500),
});

export const updateTrialSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  planCode: z.enum(PLAN_CODES).optional(),
});

export const updatePlanPriceSchema = z.strictObject({
  priceMonthlyPiastres: z.number().int().min(0).max(10_000_000),
});

export const planCodeParamSchema = z.enum(PLAN_CODES);

export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };

export type AdminOverview = {
  restaurants: Record<AccessStatus, number> & { total: number };
  pendingPayments: number;
  /** Monthly revenue implied by restaurants on a paid plan right now. */
  monthlyRecurringPiastres: number;
  /** Trials and paid periods ending within 7 days. */
  expiringSoon: number;
  newRestaurantsLast30Days: number;
  /** Stand-shop orders placed or paid and not yet handled (status NEW). */
  newStandOrders: number;
};

export type AdminRestaurantRow = {
  id: string;
  name: string;
  subdomain: string;
  publicUrl: string;
  city: string;
  ownerName: string;
  ownerEmail: string;
  access: RestaurantAccess;
  createdAt: string;
};

export type AdminEntitlement = {
  id: string;
  kind: 'TRIAL' | 'PAID';
  planCode: PlanCode;
  startsAt: string;
  endsAt: string;
  note: string | null;
  grantedBy: string | null;
  paymentId: string | null;
};

export type AdminPayment = OwnerPayment & {
  restaurant: { id: string; name: string; subdomain: string };
  reviewedBy: string | null;
};

export type AdminRestaurantDetail = AdminRestaurantRow & {
  phone: string;
  address: string;
  whatsappNumber: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  ownerId: string;
  ownerStatus: 'ACTIVE' | 'SUSPENDED';
  menu: { categories: number; items: number };
  entitlements: AdminEntitlement[];
  payments: AdminPayment[];
};

export type AdminTrialSettings = { enabled: boolean; durationDays: number; planCode: PlanCode };

export type AdminSettings = {
  payment: PaymentInstructions;
  trial: AdminTrialSettings;
  plans: { code: PlanCode; priceMonthlyPiastres: number }[];
};

export type AuditEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  actor: { id: string; name: string; email: string } | null;
  ipAddress: string | null;
  createdAt: string;
  /** Where the change came from: the admin console (and payments), or a restaurant's own dashboard. */
  scope: AuditScope;
  /** The restaurant it concerns, by name, when there is one. */
  restaurant: { id: string; name: string } | null;
};
