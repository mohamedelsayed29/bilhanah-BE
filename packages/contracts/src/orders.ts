import { z } from 'zod';
import type { ImageSet } from './media.js';
import type { OrderingSettings } from './restaurants.js';

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

export const ordersQuerySchema = z.object({
  /** active: the board (oldest first). history: closed orders (newest first). */
  view: z.enum(['active', 'history']).default('active'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

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
  /** Changes on every update; the newer of two copies has the later value. */
  updatedAt: string;
};

/** An order as the restaurant sees it. */
export type OwnerOrder = OrderCore & { id: string; customerPhone: string | null };

/** An order as the diner sees it on the tracking page. */
export type PublicOrder = OrderCore & {
  restaurant: { name: string; subdomain: string; phone: string; logo: ImageSet | null; brandColor: string | null };
};

export type PlaceOrderResponse = { trackingToken: string; order: PublicOrder };

// --- Tables -----------------------------------------------------------------

export const createTableSchema = z.strictObject({ label: z.string().trim().min(1).max(40) });

/** Creates tables "{prefix} {from}" ... "{prefix} {to}" (no space after a prefix ending in a symbol, e.g. "T-"), skipping labels that already exist. */
export const bulkCreateTablesSchema = z
  .strictObject({
    from: z.number().int().min(1).max(999),
    to: z.number().int().min(1).max(999),
    prefix: z.string().trim().max(20).default(''),
  })
  .refine((range) => range.to >= range.from && range.to - range.from < ORDER_LIMITS.bulkTables, {
    message: `Create up to ${ORDER_LIMITS.bulkTables} tables at a time.`,
    path: ['to'],
  });

export const updateTableSchema = z.strictObject({
  label: z.string().trim().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
});

export type RestaurantTable = {
  id: string;
  label: string;
  publicCode: string;
  isActive: boolean;
  /** The URL printed in this table's QR code. */
  qrUrl: string;
  createdAt: string;
};

/** What a diner's phone learns from a table QR code. */
export type PublicTable = { label: string };

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
export type RestaurantUpdatedEvent = { ordering: OrderingSettings };
