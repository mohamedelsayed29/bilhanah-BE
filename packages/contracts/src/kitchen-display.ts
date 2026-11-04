import { z } from 'zod';
import type { Permission } from './permissions.js';

/**
 * The kitchen display: orders reach preparation stations (main kitchen, grill, drinks, desserts...)
 * dish by dish, and each dish moves through its own steps. The order follows its dishes (see
 * KitchenReadyRule); the order's own status changes move its dishes too.
 */

export const KITCHEN_DISPLAY_ERROR_CODES = {
  /** 409: a dish cannot move from its step to the one asked. details: { itemId, from, to, allowed } */
  INVALID_ITEM_STATUS_CHANGE: 'INVALID_ITEM_STATUS_CHANGE',
  STATION_NOT_FOUND: 'STATION_NOT_FOUND',
  ORDER_ITEM_NOT_FOUND: 'ORDER_ITEM_NOT_FOUND',
  /** 409: the default station cannot be deleted or switched off (make another one the default first). */
  DEFAULT_STATION_LOCKED: 'DEFAULT_STATION_LOCKED',
  STATION_LIMIT_REACHED: 'STATION_LIMIT_REACHED',
} as const;

export const KITCHEN_STATION_LIMITS = { stations: 12, targetMinutes: { min: 1, max: 180 } } as const;

export const ORDER_ITEM_STATUSES = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

/** Dishes still in the kitchen's hands. */
export const ACTIVE_ITEM_STATUSES = ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] as const satisfies readonly OrderItemStatus[];

/** Where a dish may go from each step. READY → PREPARING recalls it (while the order is not ready yet). */
export const ORDER_ITEM_TRANSITIONS: Record<OrderItemStatus, readonly OrderItemStatus[]> = {
  NEW: ['ACCEPTED', 'PREPARING', 'READY', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['SERVED', 'PREPARING'],
  SERVED: [],
  CANCELLED: [],
};

/** The permission each dish step needs (the same as the matching order step). */
export const ORDER_ITEM_STATUS_PERMISSION: Record<OrderItemStatus, Permission> = {
  NEW: 'orders.update',
  ACCEPTED: 'orders.update',
  PREPARING: 'orders.update',
  READY: 'orders.update',
  SERVED: 'orders.complete',
  CANCELLED: 'orders.cancel',
};

export const ORDER_PRIORITIES = ['NORMAL', 'RUSH'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export const KITCHEN_READY_RULES = ['ALL_ITEMS', 'MANUAL'] as const;
/** ALL_ITEMS: the order turns ready once every dish is ready. MANUAL: only by marking the order ready. */
export type KitchenReadyRule = (typeof KITCHEN_READY_RULES)[number];

export const KITCHEN_STATION_KINDS = ['MAIN', 'GRILL', 'DRINKS', 'DESSERTS', 'COLD', 'BAKERY', 'OTHER'] as const;
export type KitchenStationKind = (typeof KITCHEN_STATION_KINDS)[number];

export type KitchenStation = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  kind: KitchenStationKind;
  /** Minutes a dish here usually takes; past them the order shows as late. */
  targetMinutes: number;
  /** Dishes without a station go here. */
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
};

/** GET /v1/kitchen-stations */
export type KitchenStationList = { stations: KitchenStation[]; readyRule: KitchenReadyRule };

const stationName = z.string().trim().min(1).max(40);
const targetMinutes = z.number().int().min(KITCHEN_STATION_LIMITS.targetMinutes.min).max(KITCHEN_STATION_LIMITS.targetMinutes.max);

export const createKitchenStationSchema = z.strictObject({
  nameAr: stationName,
  nameEn: stationName.nullable().optional(),
  kind: z.enum(KITCHEN_STATION_KINDS).default('OTHER'),
  targetMinutes: targetMinutes.default(15),
});

export const updateKitchenStationSchema = z.strictObject({
  nameAr: stationName.optional(),
  nameEn: stationName.nullable().optional(),
  kind: z.enum(KITCHEN_STATION_KINDS).optional(),
  targetMinutes: targetMinutes.optional(),
  isActive: z.boolean().optional(),
  /** true makes it the default (the previous default stops being one). */
  isDefault: z.literal(true).optional(),
});

export const updateKitchenSettingsSchema = z.strictObject({ readyRule: z.enum(KITCHEN_READY_RULES) });

/** PATCH /v1/orders/:id/items/status: several dishes of one order at once (a station "bumping" its part). */
export const updateOrderItemsStatusSchema = z.strictObject({
  itemIds: z.array(z.uuid()).min(1).max(50).transform((ids) => [...new Set(ids)]),
  status: z.enum(ORDER_ITEM_STATUSES),
});

export const updateOrderPrioritySchema = z.strictObject({ priority: z.enum(ORDER_PRIORITIES) });

/** One step of a dish on the kitchen display. */
export type OrderItemEvent = {
  itemId: string;
  status: OrderItemStatus;
  actorName: string | null;
  at: string;
};

export const kitchenStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  branchId: z.uuid().optional(),
});

/**
 * GET /v1/kitchen-stations/stats: how the kitchen did over the last `days` (orders that reached
 * ready). Minutes are averages; rates are 0..1, null without orders.
 */
export type KitchenStats = {
  days: number;
  orders: number;
  /** From accepting (or the first dish started) to ready. */
  averagePrepMinutes: number | null;
  /** From placing to ready. */
  averagePlacedToReadyMinutes: number | null;
  /** Ready after their estimate (or the slowest station's target without one). */
  delayed: number;
  delayRate: number | null;
  /** Orders whose dishes were never recalled nor cancelled once started. */
  accurate: number;
  accuracyRate: number | null;
  stations: { id: string | null; name: string; items: number; averagePrepMinutes: number | null; delayed: number }[];
};
