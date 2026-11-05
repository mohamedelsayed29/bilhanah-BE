import { z } from 'zod';
import type { OrderStatus, PublicOrder } from './orders.js';

/**
 * Shared table sessions: the guests seated at one table scan its QR code (or tap its NFC tag, which
 * opens the same link), join the table's one active session, and build a shared order. Each guest's
 * phone holds a guest token; each guest adds, changes and removes their own dishes until they send
 * them, and a submission becomes an ordinary restaurant order (kitchen, board, payment unchanged)
 * whose dishes remember who added them.
 *
 * ACTIVE takes new dishes. CLOSING (the table asked for the bill) shows the session but takes no
 * more dishes; the staff may reopen it. CLOSED (bill settled, closed by the staff, or idle for
 * TABLE_SESSION_LIMITS.idleHours) ends it: the next scan starts a new one.
 */

export const TABLE_SESSION_ERROR_CODES = {
  /** 403: shared table ordering is off, or the branch takes no dine-in orders now. */
  UNAVAILABLE: 'TABLE_SESSION_UNAVAILABLE',
  /** 401: the guest token is missing, forged or unknown. Join again by scanning the table. */
  GUEST_INVALID: 'TABLE_GUEST_INVALID',
  /** 409: the session is closed (details.reason: SETTLED, EXPIRED or STAFF): scan again to start a new one. */
  SESSION_CLOSED: 'TABLE_SESSION_CLOSED',
  /** 409: the table asked for the bill; no new dishes until the staff reopen it. */
  SESSION_CLOSING: 'TABLE_SESSION_CLOSING',
  /** 409: the table has the most guests allowed. */
  GUESTS_FULL: 'TABLE_SESSION_GUESTS_FULL',
  /** 409: the shared order has the most dishes allowed. */
  ITEMS_FULL: 'TABLE_SESSION_ITEMS_FULL',
  ITEM_NOT_FOUND: 'TABLE_SESSION_ITEM_NOT_FOUND',
  /** 403: another guest added this dish (and the restaurant lets guests edit only their own). */
  ITEM_NOT_YOURS: 'TABLE_SESSION_ITEM_NOT_YOURS',
  /** 409: the dish was already sent to the restaurant; it can no longer change here. */
  ITEM_SUBMITTED: 'TABLE_SESSION_ITEM_SUBMITTED',
  /** 409: the dish changed on another phone since this one loaded it. Reload. details: { item } */
  ITEM_STALE: 'TABLE_SESSION_ITEM_STALE',
  /** 409: no unsent dishes to send. */
  NOTHING_TO_SUBMIT: 'TABLE_SESSION_NOTHING_TO_SUBMIT',
  /** 409: prices changed since the dishes were added; they were updated. Review and send again. details: { itemIds, totalPiastres } */
  PRICES_CHANGED: 'TABLE_SESSION_PRICES_CHANGED',
} as const;

export const TABLE_SESSION_LIMITS = {
  guests: 30,
  /** Unsent and sent dishes in one session. */
  items: 120,
  quantity: 50,
  nameLength: 30,
  /** A session nobody touched for this long is closed (same as service requests' sessions). */
  idleHours: 4,
} as const;

export const TABLE_SESSION_STATUSES = ['ACTIVE', 'CLOSING', 'CLOSED'] as const;
export type TableSessionStatus = (typeof TABLE_SESSION_STATUSES)[number];

export const TABLE_SESSION_CLOSE_REASONS = ['SETTLED', 'EXPIRED', 'STAFF'] as const;
export type TableSessionCloseReason = (typeof TABLE_SESSION_CLOSE_REASONS)[number];

export const TABLE_CART_ITEM_STATUSES = ['DRAFT', 'SUBMITTED'] as const;
export type TableCartItemStatus = (typeof TABLE_CART_ITEM_STATUSES)[number];

/** The guest's phone sends its token in this header on every call after joining. */
export const TABLE_GUEST_HEADER = 'x-table-guest';

/** Realtime: on the /table socket (session token), something in the session changed; fetch it again. */
export const TABLE_SESSION_EVENTS = { UPDATED: 'table-session.updated' } as const;
export type TableSessionUpdatedEvent = { reason: 'items' | 'submitted' | 'guests' | 'status'; status: TableSessionStatus };

const guestName = z.string().trim().min(1).max(TABLE_SESSION_LIMITS.nameLength);
const optionalNote = z.string().trim().max(200).nullish().transform((value) => value || null);

export const joinSharedTableSchema = z.strictObject({
  /** The token this phone got before: the same guest rejoins (same table, session still open). */
  guestToken: z.string().min(10).max(400).optional(),
  displayName: guestName.optional(),
});

export const updateTableGuestSchema = z.strictObject({ displayName: guestName });

export const addTableItemSchema = z.strictObject({
  menuItemId: z.uuid(),
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(TABLE_SESSION_LIMITS.quantity),
  note: optionalNote,
});

export const updateTableItemSchema = z.strictObject({
  quantity: z.number().int().min(1).max(TABLE_SESSION_LIMITS.quantity).optional(),
  note: optionalNote.optional(),
  /** The item's version this phone saw; a newer one on the server refuses the change (ITEM_STALE). */
  version: z.number().int().min(0),
});

export const submitTableSessionSchema = z.strictObject({
  /** MINE: the caller's unsent dishes. TABLE: every guest's unsent dishes, as one round. */
  scope: z.enum(['MINE', 'TABLE']).default('MINE'),
  /** The total the guest confirmed; a different total on the server refuses with PRICES_CHANGED. */
  expectedTotalPiastres: z.number().int().min(0).optional(),
  note: optionalNote,
});

export const updateTableSessionStatusSchema = z.strictObject({ status: z.enum(TABLE_SESSION_STATUSES) });

export const tableSessionStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  branchId: z.uuid().optional(),
});

/** `name` is what the guest typed; null shows "Guest {number}". */
export type TableGuest = { id: string; number: number; name: string | null; me: boolean };

export type TableSessionItem = {
  id: string;
  guest: { id: string; number: number; name: string | null };
  /** Added by this phone's guest. */
  mine: boolean;
  /** This guest may change or remove it now (unsent, and theirs or shared editing is on). */
  editable: boolean;
  menuItemId: string;
  variantId: string;
  nameAr: string;
  nameEn: string | null;
  variantNameAr: string | null;
  variantNameEn: string | null;
  unitPricePiastres: number;
  quantity: number;
  note: string | null;
  lineTotalPiastres: number;
  status: TableCartItemStatus;
  /** The restaurant order it was sent in, with its progress. */
  order: { number: number; status: OrderStatus; trackingToken: string } | null;
  version: number;
  addedAt: string;
};

export type TableSessionView = {
  status: TableSessionStatus;
  closedReason: TableSessionCloseReason | null;
  startedAt: string;
  table: { label: string };
  branch: { slug: string; name: string };
  me: TableGuest;
  guests: TableGuest[];
  /** Unsent first, then sent (newest order first); each group oldest first. */
  items: TableSessionItem[];
  draftTotalPiastres: number;
  myDraftTotalPiastres: number;
  /** Guests may change and remove each other's unsent dishes. */
  sharedEditing: boolean;
  /** This phone's guest token (send it in the x-table-guest header). */
  guestToken: string;
  /** The table's session token: service requests and the /table socket. */
  sessionToken: string;
};

export type SubmitTableSessionResponse = { order: PublicOrder; trackingToken: string; session: TableSessionView };

/** On the dashboard: a table's open session. */
export type OwnerTableSession = {
  id: string;
  tableId: string;
  tableLabel: string;
  branchId: string;
  status: TableSessionStatus;
  startedAt: string;
  lastActivityAt: string;
  guests: number;
  draftItems: number;
  orders: number;
};

/** Success metrics over the last `days` days. */
export type TableSessionStats = {
  days: number;
  sessions: number;
  /** Sessions with at least one guest. */
  joinedSessions: number;
  guests: number;
  /** guests / joinedSessions; null without sessions. */
  averageGuests: number | null;
  /** Sessions that sent at least one order (QR/NFC-to-order conversion). */
  sessionsWithOrders: number;
  conversionRate: number | null;
  dineInOrders: number;
  /** Dine-in orders sent from a shared session. */
  sharedOrders: number;
  /** sharedOrders / dineInOrders (table session adoption). */
  adoptionRate: number | null;
  /** Tables that had two open sessions at the same time (should stay 0). */
  duplicateIncidents: number;
};

export const TABLE_SESSION_STATUS_LABELS: Record<TableSessionStatus, [string, string]> = {
  ACTIVE: ['شغالة', 'Active'],
  CLOSING: ['طلبوا الحساب', 'Closing'],
  CLOSED: ['مقفولة', 'Closed'],
};
