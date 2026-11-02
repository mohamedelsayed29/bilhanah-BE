import { z } from 'zod';
import type { ImageSet } from './media.js';
import { languageSchema } from './common.js';
import { isPushServiceEndpoint } from './push.js';
import type { OrderingSettings } from './restaurants.js';
import { BRANCH_SLUG_PATTERN } from './branches.js';

export const ORDER_TYPES = ['DINE_IN', 'PICKUP'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Orders still on the restaurant's board. */
export const ACTIVE_ORDER_STATUSES = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'] as const satisfies readonly OrderStatus[];

/** What the restaurant may change an order's status to, from each status. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PLACED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const ORDER_ERROR_CODES = {
  /** The plan has no ordering, the owner has not switched it on, or orders are paused. */
  ORDERING_UNAVAILABLE: 'ORDERING_UNAVAILABLE',
  RESTAURANT_CLOSED: 'RESTAURANT_CLOSED',
  ORDER_TYPE_UNAVAILABLE: 'ORDER_TYPE_UNAVAILABLE',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  /** details.menuItemIds lists the dishes that are sold out, hidden or gone. */
  ITEMS_UNAVAILABLE: 'ITEMS_UNAVAILABLE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /** details: { from, to, allowed } */
  INVALID_STATUS_CHANGE: 'INVALID_STATUS_CHANGE',
  TABLE_LABEL_TAKEN: 'TABLE_LABEL_TAKEN',
  TABLE_LIMIT_REACHED: 'TABLE_LIMIT_REACHED',
  /** Rejected and cancelled orders have no bill to pay. */
  ORDER_NOT_PAYABLE: 'ORDER_NOT_PAYABLE',
} as const;

export const ORDER_LIMITS = { lines: 30, quantity: 50, tables: 300, bulkTables: 100 } as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

/** Digits with an optional leading +, as for restaurant phones. */
const customerPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));

export const orderLineSchema = z.strictObject({
  menuItemId: z.uuid(),
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(ORDER_LIMITS.quantity),
  note: optionalText(200),
});

/**
 * A diner's order. Dine-in needs the table (from its QR code, or typed in);
 * pickup needs a phone number so the restaurant can reach the customer.
 */
export const placeOrderSchema = z
  .strictObject({
    type: z.enum(ORDER_TYPES),
    tableCode: z.string().trim().min(4).max(16).optional(),
    /** The branch's slug; the main branch when omitted. A table code decides the branch by itself. */
    branch: z.string().trim().toLowerCase().max(40).regex(BRANCH_SLUG_PATTERN).optional(),
    tableLabel: optionalText(40),
    customerName: z.string().trim().min(2).max(60),
    customerPhone: customerPhoneSchema.optional(),
    note: optionalText(300),
    items: z.array(orderLineSchema).min(1).max(ORDER_LIMITS.lines),
  })
  .superRefine((order, context) => {
    if (order.type === 'DINE_IN' && !order.tableCode && !order.tableLabel) {
      context.addIssue({ code: 'custom', path: ['tableLabel'], message: 'Choose your table.' });
    }
    if (order.type === 'PICKUP' && !order.customerPhone) {
      context.addIssue({ code: 'custom', path: ['customerPhone'], message: 'Add a phone number for pickup orders.' });
    }
  });

/** Idempotency-Key header: generated once per checkout, reused on retries. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Send an Idempotency-Key header.');

export const updateOrderStatusSchema = z
  .strictObject({
    status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED']),
    /** Shown to the diner; required for rejected and cancelled orders. */
    reason: optionalText(300),
  })
  .superRefine((change, context) => {
    if ((change.status === 'REJECTED' || change.status === 'CANCELLED') && !change.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Tell the customer why.' });
    }
  });

/** PATCH /v1/orders/:id/payment: the bill was paid (or the mark was a mistake). */
export const updateOrderPaymentSchema = z.strictObject({ paid: z.boolean() });

export const ordersQuerySchema = z.object({
  /** active: the board (oldest first). history: closed orders (newest first). */
  view: z.enum(['active', 'history']).default('active'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  /** One branch; every branch the caller may see when omitted. */
  branchId: z.uuid().optional(),
});

/** GET /v1/orders/floor?branchId= and the table routes: one branch, the main one (or the staff account's) when omitted. */
export const branchQuerySchema = z.object({ branchId: z.uuid().optional() });

export const orderIdParamSchema = z.uuid();
export const trackingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{16,64}$/);

export type OrderLine = {
  id: string;
  menuItemId: string | null;
  nameAr: string;
  nameEn: string | null;
  variantNameAr: string | null;
  variantNameEn: string | null;
  unitPricePiastres: number;
  quantity: number;
  note: string | null;
  lineTotalPiastres: number;
};

type OrderCore = {
  number: number;
  type: OrderType;
  tableLabel: string | null;
  customerName: string;
  status: OrderStatus;
  subtotalPiastres: number;
  note: string | null;
  items: OrderLine[];
  placedAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  rejectionReason: string | null;
  /** When the restaurant marked the bill paid; null while unpaid. */
  paidAt: string | null;
  /** Changes on every update; the newer of two copies has the later value. */
  updatedAt: string;
};

/** An order as the restaurant sees it. */
export type OwnerOrder = OrderCore & {
  id: string;
  branchId: string;
  branchName: string;
  customerPhone: string | null;
  /** The diner turned on Web Push for this order, so they hear when it is ready. */
  notifiesDiner: boolean;
};

/** An order as the diner sees it on the tracking page. */
export type PublicOrder = OrderCore & {
  /** phone is the branch's. */
  restaurant: { name: string; subdomain: string; phone: string; logo: ImageSet | null; brandColor: string | null };
  branch: { slug: string; name: string; phone: string; city: string; address: string; mapUrl: string | null; isMain: boolean };
};

export type PlaceOrderResponse = { trackingToken: string; order: PublicOrder };

// --- Ready alerts -------------------------------------------------------------

const base64url = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * POST /v1/public/orders/:token/push. The browser's PushSubscription.toJSON(),
 * plus the language to write the notification in. Other fields are ignored.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isPushServiceEndpoint, { message: 'Not a browser push service.' }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(base64url).min(80).max(100),
    auth: z.string().regex(base64url).min(16).max(32),
  }),
  language: languageSchema.default('ar'),
});

/** DELETE /v1/public/orders/:token/push */
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().max(2048) });

// --- Tables -----------------------------------------------------------------

/** How a table is drawn on the floor plan. */
export const TABLE_SHAPES = ['ROUND', 'SQUARE', 'RECTANGLE'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];
export const TABLE_SEATS = { min: 1, max: 20, default: 4 } as const;
const tableShape = z.enum(TABLE_SHAPES);
const tableSeats = z.number().int().min(TABLE_SEATS.min).max(TABLE_SEATS.max);

export const createTableSchema = z.strictObject({
  /** The main branch (or the manager's) when omitted. */
  branchId: z.uuid().optional(),
  label: z.string().trim().min(1).max(40),
  shape: tableShape.default('SQUARE'),
  seats: tableSeats.default(TABLE_SEATS.default),
});

/** Creates tables "{prefix} {from}" ... "{prefix} {to}" (no space after a prefix ending in a symbol, e.g. "T-"), skipping labels that already exist. */
export const bulkCreateTablesSchema = z
  .strictObject({
    branchId: z.uuid().optional(),
    from: z.number().int().min(1).max(999),
    to: z.number().int().min(1).max(999),
    prefix: z.string().trim().max(20).default(''),
    shape: tableShape.default('SQUARE'),
    seats: tableSeats.default(TABLE_SEATS.default),
  })
  .refine((range) => range.to >= range.from && range.to - range.from < ORDER_LIMITS.bulkTables, {
    message: `Create up to ${ORDER_LIMITS.bulkTables} tables at a time.`,
    path: ['to'],
  });

export const updateTableSchema = z.strictObject({
  label: z.string().trim().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
  shape: tableShape.optional(),
  seats: tableSeats.optional(),
});

export type RestaurantTable = {
  id: string;
  branchId: string;
  label: string;
  shape: TableShape;
  seats: number;
  publicCode: string;
  isActive: boolean;
  /** The URL printed in this table's QR code. */
  qrUrl: string;
  createdAt: string;
};

/** Unpaid orders older than this no longer keep a table occupied (a forgotten bill must not block it forever). */
export const TABLE_OCCUPANCY_HOURS = 12;

/** An order still open on a table: placed, not rejected or cancelled, and not paid. */
export type TableOpenOrder = { id: string; number: number; status: OrderStatus; subtotalPiastres: number; placedAt: string };

/**
 * GET /v1/orders/floor: each active table and whether guests are sitting at it. A table is
 * occupied while it has an unpaid order (placed in the last TABLE_OCCUPANCY_HOURS hours).
 */
export type TableOccupancy = {
  id: string;
  label: string;
  shape: TableShape;
  seats: number;
  occupied: boolean;
  /** Oldest first. */
  openOrders: TableOpenOrder[];
  unpaidPiastres: number;
  /** When the oldest open order was placed. */
  since: string | null;
};

/** What a diner's phone learns from a table QR code. */
/** What a diner's phone learns from a table QR code: the table, and the branch it stands in. */
export type PublicTable = { label: string; branch: string };

// --- Realtime ---------------------------------------------------------------

/** Socket.IO path on the API host; clients connect with transports: ['websocket']. */
export const REALTIME_PATH = '/v1/realtime';

/**
 * Namespaces: "/owner" (auth: { token: accessToken }) receives events for the
 * owner's restaurant; "/track" (auth: { token: trackingToken }) receives
 * updates for one order.
 */
export const REALTIME_EVENTS = {
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  /** /owner only: ordering settings changed (e.g. paused on another device). */
  RESTAURANT_UPDATED: 'restaurant.updated',
} as const;

export type OwnerOrderEvent = { order: OwnerOrder };
export type TrackedOrderEvent = { order: PublicOrder };
/** Ordering settings of one branch changed. */
export type RestaurantUpdatedEvent = { branchId: string; ordering: OrderingSettings };
