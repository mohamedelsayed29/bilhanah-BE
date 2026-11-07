import { z } from 'zod';
import { ORDER_PAYMENT_METHODS, type OrderPaymentMethod } from './cash.js';
import type { PlanCode } from './plans.js';

/** Point of sale (docs/POS.md). */

export const POS_ACCESS = ['ENABLED', 'DISABLED', 'SUSPENDED'] as const;
export type PosAccess = (typeof POS_ACCESS)[number];

export const POS_MODES = ['BILHANAH', 'EXTERNAL', 'BOTH'] as const;
export type PosMode = (typeof POS_MODES)[number];

/** Worked out from the platform, the plan, the administrator and the owner's setup, in that order. */
export const POS_STATUSES = ['NOT_ACTIVATED', 'PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type PosStatus = (typeof POS_STATUSES)[number];

/** Why the POS is disabled for a restaurant. */
export const POS_DISABLED_REASONS = ['PLATFORM', 'PLAN', 'ADMIN'] as const;
export type PosDisabledReason = (typeof POS_DISABLED_REASONS)[number];

export const POS_ERROR_CODES = {
  /** The POS is disabled, suspended, or not set up yet (409; details.status). */
  POS_UNAVAILABLE: 'POS_UNAVAILABLE',
  /** The mode chosen is not one the administrator allows (409). */
  POS_MODE_NOT_ALLOWED: 'POS_MODE_NOT_ALLOWED',
} as const;

export const posSettingsSchema = z.strictObject({
  /** Basis points: 1400 = 14 %. */
  taxRateBps: z.number().int().min(0).max(5000),
  taxInclusive: z.boolean(),
  serviceChargeBps: z.number().int().min(0).max(5000),
  serviceChargeDineInOnly: z.boolean(),
  paymentMethods: z.array(z.enum(ORDER_PAYMENT_METHODS)).min(1).max(ORDER_PAYMENT_METHODS.length),
  cashierMaxDiscountPercent: z.number().int().min(0).max(100),
  requireOpenShift: z.boolean(),
  receiptHeader: z.string().trim().max(200).nullable(),
  receiptFooter: z.string().trim().max(300).nullable(),
  receiptShowLogo: z.boolean(),
});
export type PosSettingsInput = z.input<typeof posSettingsSchema>;
export type PosSettings = z.output<typeof posSettingsSchema>;

export const DEFAULT_POS_SETTINGS: PosSettings = {
  taxRateBps: 0,
  taxInclusive: true,
  serviceChargeBps: 0,
  serviceChargeDineInOnly: true,
  paymentMethods: ['CASH', 'CARD'] satisfies OrderPaymentMethod[],
  cashierMaxDiscountPercent: 0,
  requireOpenShift: true,
  receiptHeader: null,
  receiptFooter: null,
  receiptShowLogo: true,
};

/** POST /v1/pos/activate: step 1 of the wizard. */
export const posActivateSchema = z.strictObject({ mode: z.enum(POS_MODES) });

/** GET /v1/pos: the restaurant's POS. */
export type PosOverview = {
  status: PosStatus;
  /** Set while DISABLED. */
  disabledReason: PosDisabledReason | null;
  /** The administrator's note on a suspension or disabling. */
  accessReason: string | null;
  allowedModes: PosMode[];
  mode: PosMode | null;
  activatedAt: string | null;
  setupCompletedAt: string | null;
  settings: PosSettings;
  updatedAt: string | null;
};

// --- Administrators ------------------------------------------------------------------

export type PosPlatformSettings = { enabled: boolean; plans: PlanCode[]; updatedAt: string };

export const posPlatformSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  plans: z.array(z.enum(['MENU', 'ORDERS', 'ADVANCED'])).max(3),
});

export const adminPosRestaurantsQuerySchema = z.object({
  status: z.enum(POS_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminPosRestaurant = {
  id: string;
  name: string;
  subdomain: string;
  planCode: PlanCode | null;
  status: PosStatus;
  disabledReason: PosDisabledReason | null;
  access: PosAccess;
  accessReason: string | null;
  allowedModes: PosMode[];
  mode: PosMode | null;
  activatedAt: string | null;
};

export const adminPosAccountSchema = z.strictObject({
  access: z.enum(POS_ACCESS),
  reason: z.string().trim().max(300).nullable().optional(),
  allowedModes: z.array(z.enum(POS_MODES)).min(1).max(POS_MODES.length),
});

export const POS_STATUS_LABELS: Record<PosStatus, [string, string]> = {
  NOT_ACTIVATED: ['غير مفعّل', 'Not activated'],
  PENDING_SETUP: ['محتاج إعداد', 'Pending setup'],
  ACTIVE: ['شغال', 'Active'],
  SUSPENDED: ['موقوف مؤقتًا', 'Suspended'],
  DISABLED: ['مقفول', 'Disabled'],
};

export const POS_MODE_LABELS: Record<PosMode, [string, string]> = {
  BILHANAH: ['كاشير بالهنا', 'Bilhanah POS'],
  EXTERNAL: ['ربط سيستم كاشير موجود', 'External POS integration'],
  BOTH: ['الاتنين', 'Both'],
};

// --- POS orders (task 2) -----------------------------------------------------------------

/** Where an order was taken: the diner's menu (QR or link) or the restaurant's POS. */
export const ORDER_CHANNELS = ['MENU', 'POS'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const posDiscountSchema = z.strictObject({
  kind: z.enum(['PERCENT', 'AMOUNT']),
  /** Percent (1–100), or piastres. */
  value: z.number().int().min(1).max(10_000_000),
  reason: z.string().trim().min(2).max(200),
});

export const posOrderLineSchema = z.strictObject({
  menuItemId: z.uuid(),
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(99),
  note: z.string().trim().max(200).optional(),
});

/** POST /v1/pos/orders (Idempotency-Key header). Prices and totals always come from the server. */
export const posOrderSchema = z.strictObject({
  type: z.enum(['DINE_IN', 'PICKUP']),
  /** Required for DINE_IN unless tableLabel is given; decides the branch. */
  tableId: z.uuid().optional(),
  /** Takeaway (or a table not in Bilhanah): the branch taking it; the caller's own when tied to one. */
  branchId: z.uuid().optional(),
  customerName: z.string().trim().max(60).optional(),
  customerPhone: z.string().trim().transform((value) => value.replace(/[\s().-]/g, '')).pipe(z.string().regex(/^\+?\d{7,15}$/)).optional(),
  note: z.string().trim().max(300).optional(),
  items: z.array(posOrderLineSchema).min(1).max(50),
  discount: posDiscountSchema.optional(),
}).superRefine((order, context) => {
  if (order.type === 'DINE_IN' && !order.tableId) context.addIssue({ code: 'custom', path: ['tableId'], message: 'Choose the table.' });
});
export type PosOrderInput = z.input<typeof posOrderSchema>;

/** POST /v1/pos/orders/quote: the same body, priced without ordering. */
export type PosTotals = {
  subtotalPiastres: number;
  discountPiastres: number;
  serviceChargePiastres: number;
  taxPiastres: number;
  /** The bill: subtotal − discount + service charge (+ tax when it is added on top). */
  totalPiastres: number;
  taxInclusive: boolean;
};

/**
 * A POS bill. The service charge applies after the discount; tax applies to that plus the service
 * charge, either included in the prices (shown only) or added on top. Rounded to the piastre.
 */
export function posTotals(input: { subtotalPiastres: number; discountPiastres: number; dineIn: boolean }, settings: { taxRateBps: number; taxInclusive: boolean; serviceChargeBps: number; serviceChargeDineInOnly: boolean }): PosTotals {
  const discount = Math.min(Math.max(0, input.discountPiastres), input.subtotalPiastres);
  const net = input.subtotalPiastres - discount;
  const service = !settings.serviceChargeDineInOnly || input.dineIn ? Math.round((net * settings.serviceChargeBps) / 10_000) : 0;
  const base = net + service;
  const rate = settings.taxRateBps / 10_000;
  const tax = settings.taxInclusive ? Math.round(base - base / (1 + rate)) : Math.round(base * rate);
  return { subtotalPiastres: input.subtotalPiastres, discountPiastres: discount, serviceChargePiastres: service, taxPiastres: tax, totalPiastres: base + (settings.taxInclusive ? 0 : tax), taxInclusive: settings.taxInclusive };
}

/** The discount a POS order asks for, in piastres (a percentage of the subtotal, or an amount, never more than it). */
export const posDiscountPiastres = (discount: { kind: 'PERCENT' | 'AMOUNT'; value: number } | undefined, subtotalPiastres: number) =>
  !discount ? 0 : Math.min(subtotalPiastres, discount.kind === 'PERCENT' ? Math.round((subtotalPiastres * Math.min(100, discount.value)) / 100) : discount.value);

export const POS_ORDER_ERROR_CODES = {
  /** The discount is above the cashier's limit and the caller lacks pos.discount (403). */
  POS_DISCOUNT_NOT_ALLOWED: 'POS_DISCOUNT_NOT_ALLOWED',
} as const;

// --- Payments (task 3) ---------------------------------------------------------------

export const POS_PAYMENT_STATUSES = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED'] as const;
export type PosPaymentStatus = (typeof POS_PAYMENT_STATUSES)[number];

/** POST /v1/pos/orders/:id/payments (Idempotency-Key header). */
export const posPaymentSchema = z.strictObject({
  method: z.enum(ORDER_PAYMENT_METHODS),
  /** What this payment covers; at most what is still due. */
  amountPiastres: z.number().int().min(1).max(100_000_000),
  /** Cash handed over (for the change). */
  tenderedPiastres: z.number().int().min(1).max(100_000_000).optional(),
  /** The card terminal's approval code or wallet reference. Never card numbers. */
  reference: z.string().trim().max(100).regex(/^(?!.*\d{13,19}).*$/, 'Do not enter card numbers.').optional(),
  /** A declined card: recorded for the record, not counted. */
  failed: z.boolean().optional(),
  failureReason: z.string().trim().max(200).optional(),
});

export const posRefundSchema = z.strictObject({
  amountPiastres: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(3).max(200),
});

export type PosPayment = {
  id: string;
  method: OrderPaymentMethod;
  status: PosPaymentStatus;
  amountPiastres: number;
  tenderedPiastres: number | null;
  changePiastres: number | null;
  refundedPiastres: number;
  reference: string | null;
  failureReason: string | null;
  cashierName: string | null;
  external: boolean;
  createdAt: string;
  refunds: { id: string; amountPiastres: number; reason: string; actorName: string | null; createdAt: string }[];
};

/** An order's payments and what is still due. */
export type PosOrderPayments = {
  orderId: string;
  totalPiastres: number;
  /** Payments that went through, less what was refunded. */
  paidPiastres: number;
  duePiastres: number;
  /** Fully paid (paidAt set). */
  settled: boolean;
  payments: PosPayment[];
};

export const POS_DEVICE_ERROR_CODES = {
  POS_DEVICE_NOT_FOUND: 'POS_DEVICE_NOT_FOUND',
  /** The device key is unknown or the device was revoked (403). */
  POS_DEVICE_REVOKED: 'POS_DEVICE_REVOKED',
} as const;

export const POS_PAYMENT_ERROR_CODES = {
  /** More than is due, a method the POS does not take, or a closed order (409). */
  POS_PAYMENT_INVALID: 'POS_PAYMENT_INVALID',
  /** The refund is more than what was paid and not refunded (409). */
  POS_REFUND_INVALID: 'POS_REFUND_INVALID',
  /** The order is paid through POS payments: mark-paid toggles do not apply (409). */
  POS_PAYMENTS_IN_USE: 'POS_PAYMENTS_IN_USE',
} as const;

// --- Devices (task 5) ------------------------------------------------------------------

export const posDeviceSchema = z.strictObject({ name: z.string().trim().min(2).max(60), branchId: z.uuid() });
export const posDeviceUpdateSchema = z.strictObject({ name: z.string().trim().min(2).max(60).optional(), branchId: z.uuid().optional() });

export type PosDevice = {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  status: 'ACTIVE' | 'REVOKED';
  lastSeenAt: string | null;
  lastUserName: string | null;
  createdAt: string;
  revokedAt: string | null;
};

/** The device key, shown once when the device is registered. */
export type PosDeviceRegistration = { device: PosDevice; deviceKey: string };

/** The receipt for an order: everything printed, from the server. */
export type PosReceipt = {
  restaurant: { name: string; logoUrl: string | null; phone: string };
  branch: { name: string; address: string; city: string; phone: string };
  header: string | null;
  footer: string | null;
  showLogo: boolean;
  order: {
    id: string; number: number; placedAt: string; type: 'DINE_IN' | 'PICKUP'; tableLabel: string | null; customerName: string; cashierName: string | null; status: string;
    items: { name: string; nameEn: string | null; variant: string | null; quantity: number; unitPricePiastres: number; lineTotalPiastres: number; note: string | null }[];
    subtotalPiastres: number; discountPiastres: number; discountReason: string | null; serviceChargePiastres: number; taxPiastres: number; taxInclusive: boolean; totalPiastres: number;
  };
  payments: { method: OrderPaymentMethod; amountPiastres: number; tenderedPiastres: number | null; changePiastres: number | null; refundedPiastres: number }[];
  paidPiastres: number;
  duePiastres: number;
  printedAt: string;
};

// --- Integrations (task 6) ---------------------------------------------------------------

export const POS_PROVIDER_CAPABILITIES = ['testConnection', 'fetchMenu', 'syncMenu', 'createOrder', 'cancelOrder', 'fetchOrderStatus', 'handleWebhook', 'syncPaymentStatus'] as const;
export type PosProviderCapability = (typeof POS_PROVIDER_CAPABILITIES)[number];

/** What a provider adapter can do, and what each entity's source of truth is. */
export type PosProviderInfo = {
  key: string;
  name: [string, string];
  description: [string, string];
  capabilities: PosProviderCapability[];
  sourceOfTruth: { menu: 'BILHANAH' | 'EXTERNAL'; orders: 'BILHANAH' | 'EXTERNAL'; orderStatus: 'BILHANAH' | 'EXTERNAL'; payments: 'BILHANAH' | 'EXTERNAL' };
};

/** The generic webhook provider's settings (other providers add their own). */
export const posWebhookConfigSchema = z.strictObject({
  /** Where Bilhanah sends orders. HTTPS in production. */
  endpointUrl: z.url().max(500),
  /** Which orders are sent. */
  pushChannels: z.array(z.enum(ORDER_CHANNELS)).max(2),
  pushCancellations: z.boolean(),
  /** The external POS may move order statuses (it is then the source of truth for status). */
  acceptStatusUpdates: z.boolean(),
  /** The external POS may record payments on orders. */
  acceptPayments: z.boolean(),
});
export type PosWebhookConfig = z.output<typeof posWebhookConfigSchema>;

export const posIntegrationCreateSchema = z.strictObject({
  provider: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(60),
  branchId: z.uuid().nullable(),
  config: posWebhookConfigSchema,
});

export const posIntegrationUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(60).optional(),
  branchId: z.uuid().nullable().optional(),
  config: posWebhookConfigSchema.optional(),
});

export type PosIntegration = {
  id: string;
  provider: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DISCONNECTED';
  branchId: string | null;
  config: PosWebhookConfig;
  /** Where the external POS sends its events. */
  webhookUrl: string;
  lastSyncAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  jobs: { pending: number; dead: number; succeeded: number };
  mappings: number;
  createdAt: string;
};

/** Secrets, shown once when the integration is created (or rotated). */
export type PosIntegrationSecrets = {
  /** Bilhanah signs what it sends with this (X-Bilhanah-Signature: sha256=…). */
  outboundSecret: string;
  /** The external POS signs what it sends to Bilhanah with this. */
  inboundSecret: string;
};

export type PosSyncJob = {
  id: string; kind: string; entityId: string | null; status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'DEAD';
  attempts: number; maxAttempts: number; nextRunAt: string; lastError: string | null; lastStatusCode: number | null; completedAt: string | null; createdAt: string;
};

export type PosWebhookLog = { id: string; eventId: string; type: string; outcome: string; error: string | null; receivedAt: string };

export const posMappingSchema = z.strictObject({
  entity: z.enum(['BRANCH', 'CATEGORY', 'MENU_ITEM', 'VARIANT']),
  localId: z.uuid(),
  externalId: z.string().trim().min(1).max(120),
});
export type PosMapping = { id: string; entity: string; localId: string; externalId: string; updatedAt: string };

export const POS_INTEGRATION_ERROR_CODES = {
  POS_INTEGRATION_NOT_FOUND: 'POS_INTEGRATION_NOT_FOUND',
  POS_PROVIDER_UNKNOWN: 'POS_PROVIDER_UNKNOWN',
  /** The provider adapter does not support this operation (409; details.capability). */
  POS_CAPABILITY_UNSUPPORTED: 'POS_CAPABILITY_UNSUPPORTED',
  POS_MAPPING_CONFLICT: 'POS_MAPPING_CONFLICT',
  POS_WEBHOOK_INVALID: 'POS_WEBHOOK_INVALID',
} as const;

// --- Reports and admin (task 7) ------------------------------------------------------------

export const posReportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  channel: z.enum(ORDER_CHANNELS).optional(),
}).refine((query) => query.from <= query.to, { path: ['to'], message: 'End date must follow start date.' });

export type PosReport = {
  from: string; to: string;
  /** Orders not rejected or cancelled. */
  orders: number;
  grossPiastres: number;
  discountPiastres: number;
  /** Gross − discounts. */
  netPiastres: number;
  serviceChargePiastres: number;
  taxPiastres: number;
  /** What the bills came to. */
  billedPiastres: number;
  /** Payments that went through, less refunds. */
  collectedPiastres: number;
  refundedPiastres: number;
  /** Billed − collected, on orders that are not settled. */
  outstandingPiastres: number;
  averageOrderPiastres: number;
  byChannel: { channel: OrderChannel; orders: number; netPiastres: number }[];
  byMethod: { method: OrderPaymentMethod; payments: number; collectedPiastres: number }[];
  byCashier: { cashierId: string | null; name: string; orders: number; netPiastres: number }[];
  shifts: { id: string; cashierName: string; openedAt: string; closedAt: string | null; status: string; expectedPiastres: number | null; countedPiastres: number | null; discrepancyPiastres: number | null }[];
};

export type AdminPosHealth = {
  restaurants: Record<PosStatus, number>;
  devices: { active: number; revoked: number };
  integrations: { active: number; paused: number; disconnected: number };
  jobs: { pending: number; dead: number; succeededLastDay: number };
  failing: { integrationId: string; restaurantId: string; restaurantName: string; name: string; provider: string; dead: number; lastError: string | null }[];
};
