import type { OrderItemStatus, OrderPriority } from './kitchen-display.js';
import { z } from 'zod';
import { orderLineRecommendationSchema } from './recommendations.js';
import type { ImageSet } from './media.js';
import { languageSchema } from './common.js';
import { isPushServiceEndpoint } from './push.js';
import { ORDER_PREP_MINUTES, type OrderingSettings } from './restaurants.js';
import { BRANCH_SLUG_PATTERN } from './branches.js';
import { ORDER_PAYMENT_METHODS, type OrderPaymentMethod } from './cash.js';
import type { OrderLoyalty } from './loyalty.js';

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
  /** Tables that cannot be merged as asked: another branch or area, switched off, already merged, or too many. */
  TABLE_GROUP_INVALID: 'TABLE_GROUP_INVALID',
  /** Two of the tables have different parties (open orders, guests or bookings): they cannot share one session. */
  TABLE_GROUP_CONFLICT: 'TABLE_GROUP_CONFLICT',
  /** Guests are at the merged tables: settle their bill before separating them. */
  TABLE_GROUP_BUSY: 'TABLE_GROUP_BUSY',
  TABLE_GROUP_NOT_FOUND: 'TABLE_GROUP_NOT_FOUND',
  /** A merged table cannot be switched off or deleted on its own: separate the group first. */
  TABLE_IN_GROUP: 'TABLE_IN_GROUP',
  /** Only dine-in orders still open on a table move: not rejected, cancelled, or completed and paid. */
  ORDER_NOT_TRANSFERABLE: 'ORDER_NOT_TRANSFERABLE',
  /** The destination cannot take the order: the same seating, switched off, being cleaned, held by a booking, or with other guests. details: { status } */
  TABLE_TRANSFER_INVALID: 'TABLE_TRANSFER_INVALID',
  /** A status change the table's current status does not allow (see TABLE_STATUS_TRANSITIONS). */
  TABLE_STATUS_INVALID: 'TABLE_STATUS_INVALID',
  /** details.menuItemIds lists the dishes that are sold out, hidden or gone. */
  ITEMS_UNAVAILABLE: 'ITEMS_UNAVAILABLE',
  /** 409: the branch's stock cannot cover these dishes' recipes (inventory BLOCK_ORDERS policy). details: { menuItemIds } */
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /** details: { from, to, allowed } */
  INVALID_STATUS_CHANGE: 'INVALID_STATUS_CHANGE',
  TABLE_LABEL_TAKEN: 'TABLE_LABEL_TAKEN',
  TABLE_LIMIT_REACHED: 'TABLE_LIMIT_REACHED',
  TABLE_AREA_NOT_FOUND: 'TABLE_AREA_NOT_FOUND',
  TABLE_AREA_NAME_TAKEN: 'TABLE_AREA_NAME_TAKEN',
  TABLE_AREA_LIMIT_REACHED: 'TABLE_AREA_LIMIT_REACHED',
  /** The area still has tables: say where they go (moveTo). details: { tables, activeOrders } */
  TABLE_AREA_NOT_EMPTY: 'TABLE_AREA_NOT_EMPTY',
  /** Rejected and cancelled orders have no bill to pay. */
  ORDER_NOT_PAYABLE: 'ORDER_NOT_PAYABLE',
} as const;

export const ORDER_LIMITS = { lines: 30, quantity: 50, tables: 300, bulkTables: 100, tableAreas: 30 } as const;

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
  /** Added from a suggestion (see recommendations.ts): kept for its conversion and revenue. */
  recommendation: orderLineRecommendationSchema.optional(),
});

/** The loyalty part of placing an order: the member card (signed pass) and the reward to apply. */
export const orderLoyaltySchema = z.strictObject({
  pass: z.string().trim().min(10).max(200).optional(),
  rewardId: z.uuid().optional(),
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
    /** Loyalty (docs/LOYALTY.md): the member card, and a reward to apply (needs the card). */
    loyalty: orderLoyaltySchema.optional(),
  })
  .superRefine((order, context) => {
    if (order.loyalty?.rewardId && !order.loyalty.pass) {
      context.addIssue({ code: 'custom', path: ['loyalty', 'pass'], message: 'Rewards need your member card.' });
    }
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
    /**
     * Minutes until it should be ready, from now: shown to the diner. When accepting without it, the
     * restaurant's usual time (orderPrepMinutes) is used. Accepting or preparing only.
     */
    prepMinutes: z.number().int().min(ORDER_PREP_MINUTES.min).max(ORDER_PREP_MINUTES.max).optional(),
  })
  .superRefine((change, context) => {
    if (change.prepMinutes !== undefined && change.status !== 'ACCEPTED' && change.status !== 'PREPARING') {
      context.addIssue({ code: 'custom', path: ['prepMinutes'], message: 'Only accepted or preparing orders take a preparation time.' });
    }
    if ((change.status === 'REJECTED' || change.status === 'CANCELLED') && !change.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Tell the customer why.' });
    }
  });

/** PATCH /v1/orders/:id/payment: the bill was paid (or the mark was a mistake). */
export const updateOrderPaymentSchema = z.strictObject({
  paid: z.boolean(),
  /** How the bill was paid (when marking it paid). Cash goes into the caller's open cash shift. */
  method: z.enum(ORDER_PAYMENT_METHODS).default('CASH'),
});

/** POST /v1/orders/tables/:tableId/settle: how the table paid. */
export const settleTableSchema = z.strictObject({ method: z.enum(ORDER_PAYMENT_METHODS).default('CASH') }).default({ method: 'CASH' });

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
  /** The kitchen station it was routed to (null: the default station) and its name then. */
  stationId: string | null;
  stationName: string | null;
  /** Its own preparation step on the kitchen display. */
  prepStatus: OrderItemStatus;
  startedAt: string | null;
  readyAt: string | null;
  /** The guest who added it in a shared table session; null otherwise. */
  guestName: string | null;
};

type OrderCore = {
  number: number;
  type: OrderType;
  tableLabel: string | null;
  customerName: string;
  status: OrderStatus;
  subtotalPiastres: number;
  /** Taken off by a loyalty reward (0 without one). */
  discountPiastres: number;
  /** POS orders: service charge and tax (tax included in prices is shown, not added); 0 otherwise. */
  serviceChargePiastres: number;
  taxPiastres: number;
  /** The bill: subtotal − discount + service charge (+ tax added on top). */
  totalPiastres: number;
  /** Points earned or spent; null when the order is not part of the loyalty program. */
  loyalty: OrderLoyalty | null;
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
  /** When the restaurant expects it ready; null without an estimate. Kept once ready (for comparison). */
  estimatedReadyAt: string | null;
  /** Every status the order went through, oldest first (starting with PLACED). */
  history: OrderStatusStep[];
  /** Changes on every update; the newer of two copies has the later value. */
  updatedAt: string;
};

/** One step of an order's history. */
export type OrderStatusStep = { status: OrderStatus; at: string; reason: string | null };

/** In the restaurant's view, who made the change: null for the diner placing it. */
export type OwnerOrderStatusStep = OrderStatusStep & { actorName: string | null };

/** The order moved to another table: from, to, when, by whom and why. */
export type OrderTableTransferStep = { fromTableLabel: string; toTableLabel: string; at: string; actorName: string | null; reason: string | null };

/**
 * POST /v1/orders/:id/transfer: moves a dine-in order still open on its table to another table of its branch that
 * is free (available, not held by a booking, not being cleaned, no other guests). Everything on the order stays as it
 * was; when nothing else is left on the old table, its guests' session and seated booking move along, and it is to be cleaned.
 */
export const transferOrderSchema = z.strictObject({
  tableId: z.uuid(),
  reason: z.string().trim().max(200).transform((value) => (value === '' ? null : value)).nullable().optional(),
});

/** An order as the restaurant sees it. */
export type OwnerOrder = Omit<OrderCore, 'history'> & {
  history: OwnerOrderStatusStep[];
  /** Every move to another table, oldest first. */
  transfers: OrderTableTransferStep[];
  id: string;
  branchId: string;
  branchName: string;
  customerPhone: string | null;
  /** The diner turned on Web Push for this order, so they hear when it is ready. */
  notifiesDiner: boolean;
  /** RUSH orders go first on the kitchen display. */
  priority: OrderPriority;
  /** How the bill was paid; null while unpaid. */
  paymentMethod: OrderPaymentMethod | null;
  /** Inventory WARN policy: dishes the branch's stock could not cover when it was placed (empty: none). */
  lowStockItemIds: string[];
  /** Taken on the diner's menu or at the POS, and by whom (POS orders). */
  channel: 'MENU' | 'POS';
  createdByName: string | null;
  discountReason: string | null;
};

/** An order as the diner sees it on the tracking page. */
export type PublicOrder = OrderCore & {
  /** phone is the branch's. */
  restaurant: { name: string; subdomain: string; phone: string; logo: ImageSet | null; brandColor: string | null };
  branch: { slug: string; name: string; phone: string; city: string; address: string; mapUrl: string | null; isMain: boolean };
};

export type PlaceOrderResponse = {
  trackingToken: string;
  order: PublicOrder;
  /** A new member card, when this checkout created the diner's loyalty membership (kept by the browser). */
  loyaltyPass?: string;
};

/** GET /v1/orders/tracking-stats: how diners follow their orders. */
export const trackingStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  branchId: z.uuid().optional(),
});

/**
 * Over the last `days` (orders that were not rejected or cancelled): how many diners opened the
 * tracking page, how many "ready" notifications reached a browser out of the orders that asked for
 * one, how often orders were ready by their estimate, and how many service requests came from a
 * table while its order was on the way (a sign diners asked the staff about it).
 */
export type OrderTrackingStats = {
  days: number;
  orders: number;
  tracked: number;
  trackingRate: number | null;
  /** Orders that reached ready with notifications turned on. */
  readyAlertOrders: number;
  readyNotified: number;
  readyDeliveryRate: number | null;
  /** Orders with an estimate that reached ready. */
  estimatedOrders: number;
  readyOnTime: number;
  onTimeRate: number | null;
  statusEnquiries: number;
};

// --- Ready alerts -------------------------------------------------------------

export const ORDER_PUSH_UPDATES = ['READY', 'ALL'] as const;
export type OrderPushUpdates = (typeof ORDER_PUSH_UPDATES)[number];

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
  /** READY: the order is ready (or will not come). ALL: also when it is accepted and being prepared. */
  updates: z.enum(ORDER_PUSH_UPDATES).default('READY'),
});

/** DELETE /v1/public/orders/:token/push */
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().max(2048) });

// --- Tables -----------------------------------------------------------------

/** How a table is drawn on the floor plan. */
export const TABLE_SHAPES = ['ROUND', 'SQUARE', 'RECTANGLE'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];
export const TABLE_SEATS = { min: 1, max: 20, default: 4 } as const;
/** Where a table stands: inside the restaurant, or outside (a terrace, the street). */
export const TABLE_LOCATIONS = ['INDOOR', 'OUTDOOR'] as const;
export type TableLocation = (typeof TABLE_LOCATIONS)[number];
const tableShape = z.enum(TABLE_SHAPES);
const tableLocation = z.enum(TABLE_LOCATIONS);
/** A table's area: an area of the same branch, or null for none. A table in an area takes the area's location. */
const tableAreaId = z.uuid().nullable();

/** What a table offers, shown on its details and used to seat the right guests. */
export const TABLE_ATTRIBUTES = ['WINDOW', 'SOFA', 'VIP', 'ACCESSIBLE', 'POWER_OUTLET', 'QUIET', 'SMOKING'] as const;
export type TableAttribute = (typeof TABLE_ATTRIBUTES)[number];
/** A table's minimum order, notes and attributes (all optional; null or [] clears them). */
const tableDetails = {
  minOrderPiastres: z.number().int().min(0).max(10_000_000).nullable().optional(),
  notes: optionalText(200),
  attributes: z.array(z.enum(TABLE_ATTRIBUTES)).max(TABLE_ATTRIBUTES.length).transform((list) => [...new Set(list)]).optional(),
};
/** A spot on the floor plan, in percent of its width and height. */
const floorCoordinate = z.number().min(0).max(100).nullable();
/** How far a table can be resized on the plan (1 = its natural size). */
export const TABLE_FLOOR_SCALE = { min: 0.6, max: 1.8 } as const;
const tableSeats = z.number().int().min(TABLE_SEATS.min).max(TABLE_SEATS.max);

export const createTableSchema = z.strictObject({
  /** The main branch (or the manager's) when omitted. */
  branchId: z.uuid().optional(),
  label: z.string().trim().min(1).max(40),
  shape: tableShape.default('SQUARE'),
  seats: tableSeats.default(TABLE_SEATS.default),
  location: tableLocation.default('INDOOR'),
  areaId: tableAreaId.optional(),
  ...tableDetails,
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
    location: tableLocation.default('INDOOR'),
    areaId: tableAreaId.optional(),
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
  location: tableLocation.optional(),
  /** Moves the table to another area of its branch, or out of any area (null). */
  areaId: tableAreaId.optional(),
  ...tableDetails,
  /** Where it was dropped on the floor plan; null puts it back to automatic placement. */
  floorX: floorCoordinate.optional(),
  floorY: floorCoordinate.optional(),
  /** Degrees clockwise; any whole number, kept as 0-359. */
  floorRotation: z.number().int().min(-3600).max(3600).transform((degrees) => ((degrees % 360) + 360) % 360).optional(),
  floorScale: z.number().min(TABLE_FLOOR_SCALE.min).max(TABLE_FLOOR_SCALE.max).optional(),
});

export type RestaurantTable = {
  id: string;
  branchId: string;
  label: string;
  shape: TableShape;
  seats: number;
  location: TableLocation;
  areaId: string | null;
  /** On the floor plan, in percent; null until the owner places it. */
  floorX: number | null;
  floorY: number | null;
  /** Degrees clockwise (0-359). */
  floorRotation: number;
  /** 1 = its natural size (TABLE_FLOOR_SCALE bounds it). */
  floorScale: number;
  minOrderPiastres: number | null;
  notes: string | null;
  attributes: TableAttribute[];
  /** Being cleaned (see TableOccupancy.cleaning). */
  cleaning: boolean;
  /** The merged seating group it belongs to now (see TableGroupView), or null. */
  groupId: string | null;
  publicCode: string;
  isActive: boolean;
  /** The URL printed in this table's QR code. */
  qrUrl: string;
  createdAt: string;
};

// --- Table areas --------------------------------------------------------------

/** How an area is drawn on the floor plan. Without one, indoor areas are a hall and outdoor ones a terrace. */
export const TABLE_AREA_THEMES = ['HALL', 'GARDEN', 'ROOFTOP', 'TERRACE', 'VIP', 'SMOKING'] as const;
export type TableAreaTheme = (typeof TABLE_AREA_THEMES)[number];

/** POST /v1/table-areas: a seating area of a branch (the main branch, or the manager's, when omitted). */
export const createTableAreaSchema = z.strictObject({
  branchId: z.uuid().optional(),
  name: z.string().trim().min(1).max(40),
  location: tableLocation.default('INDOOR'),
  theme: z.enum(TABLE_AREA_THEMES).optional(),
});

/** PATCH /v1/table-areas/:id. A new location applies to every table in the area. */
export const updateTableAreaSchema = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  location: tableLocation.optional(),
  theme: z.enum(TABLE_AREA_THEMES).optional(),
});

/**
 * DELETE /v1/table-areas/:id?moveTo=: where the area's tables go, another area of the same branch
 * or "none" (no area). Required while the area has tables; their orders stay with them.
 */
export const deleteTableAreaQuerySchema = z.object({ moveTo: z.union([z.uuid(), z.literal('none')]).optional() });

export type TableArea = {
  id: string;
  branchId: string;
  name: string;
  location: TableLocation;
  theme: TableAreaTheme;
  tableCount: number;
  /** Unpaid orders on its tables (as on the floor plan). */
  activeOrders: number;
  createdAt: string;
};

/** A pending or confirmed booking holds its table from this long before its time until this long after. */
export const TABLE_RESERVED_WINDOW = { beforeMinutes: 120, afterMinutes: 30 } as const;

/**
 * A table's status on the floor plan, in priority order: switched off (UNAVAILABLE), guests at it (OCCUPIED:
 * an unpaid order or a seated booking), being cleaned (CLEANING), held by a booking around its time (RESERVED),
 * or free (AVAILABLE). OCCUPIED and RESERVED follow orders and bookings; staff set the other three.
 */
export const TABLE_STATUSES = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'UNAVAILABLE'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];
/** What staff may set by hand (PATCH /v1/orders/tables/:id/status). */
export const MANUAL_TABLE_STATUSES = ['AVAILABLE', 'CLEANING', 'UNAVAILABLE'] as const satisfies readonly TableStatus[];
export type ManualTableStatus = (typeof MANUAL_TABLE_STATUSES)[number];
export const updateTableStatusSchema = z.strictObject({ status: z.enum(MANUAL_TABLE_STATUSES) });
/**
 * The hand changes allowed from each status: guests must be billed before their table is cleaned or switched
 * off, and a held table is only switched off (its booking stays). Setting a table to the status it has is a no-op.
 */
export const TABLE_STATUS_TRANSITIONS: Record<TableStatus, readonly ManualTableStatus[]> = {
  AVAILABLE: ['CLEANING', 'UNAVAILABLE'],
  RESERVED: ['CLEANING', 'UNAVAILABLE'],
  CLEANING: ['AVAILABLE', 'UNAVAILABLE'],
  UNAVAILABLE: ['AVAILABLE', 'CLEANING'],
  OCCUPIED: [],
};

// --- Merged tables ---------------------------------------------------------------

/** How many tables one group may merge. */
export const TABLE_GROUP_LIMITS = { tables: 8 } as const;

/**
 * POST /v1/table-groups: merges active tables of one branch and one area (or, outside areas, one location) into a
 * seating group. At most one of them may have a party (open orders, guests, a seated or upcoming booking); the
 * group then shares that table's session.
 */
export const createTableGroupSchema = z.strictObject({
  tableIds: z.array(z.uuid()).min(2).max(TABLE_GROUP_LIMITS.tables).transform((ids) => [...new Set(ids)]).refine((ids) => ids.length >= 2, { message: 'Pick at least two different tables.' }),
  label: z.string().trim().max(40).transform((value) => (value === '' ? null : value)).nullable().optional(),
});

export type TableGroupView = {
  id: string;
  branchId: string;
  label: string | null;
  leadTableId: string;
  tableIds: string[];
  tableLabels: string[];
  /** The merged capacity: every member's seats. */
  seats: number;
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
  location: TableLocation;
  areaId: string | null;
  /** Its status now (see TABLE_STATUSES). */
  status: TableStatus;
  /** Guests are at it: an unpaid order, or a seated booking (until its bill is settled; see SEATED_HOLD_HOURS). */
  occupied: boolean;
  /** Being cleaned: set when the bill is settled, cleared by staff. */
  cleaning: boolean;
  /** The booking that holds it now (see TABLE_RESERVED_WINDOW), when it is not occupied. */
  reservation: { id: string; customerName: string; reservedAt: string; guests: number } | null;
  /** The booked party seated at it, if any. */
  seated: { id: string; customerName: string; reservedAt: string; guests: number } | null;
  /** Merged with other tables: every member shows the group's status; the group's bill is all its members' orders. */
  group: { id: string; label: string | null; leadTableId: string; tableIds: string[]; seats: number } | null;
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
  /** /owner only: a table's status changed by hand, or its bill was settled; the floor plan fetches it again. */
  TABLE_UPDATED: 'table.updated',
} as const;

export type TableUpdatedEvent = { branchId: string; tableId: string; status: TableStatus };

export type OwnerOrderEvent = { order: OwnerOrder };
export type TrackedOrderEvent = { order: PublicOrder };
/** Ordering settings of one branch changed. */
export type RestaurantUpdatedEvent = { branchId: string; ordering: OrderingSettings };
