import type { RestaurantRole } from './permissions.js';
import { z } from 'zod';

/**
 * Table service requests: diners at a table call a waiter or ask for the bill, water, napkins,
 * cleaning, or anything else, from the menu; the staff take them on the dashboard.
 */
export const SERVICE_REQUEST_TYPES = ['CALL_WAITER', 'REQUEST_BILL', 'REQUEST_WATER', 'REQUEST_NAPKINS', 'REQUEST_CLEANING', 'CUSTOM'] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

export const SERVICE_REQUEST_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];
/** Still waiting on the staff. */
export const OPEN_SERVICE_REQUEST_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const satisfies readonly ServiceRequestStatus[];

/** Where the staff can move a request from each status; completed and cancelled ones stay as history. */
export const SERVICE_REQUEST_TRANSITIONS: Record<ServiceRequestStatus, readonly ServiceRequestStatus[]> = {
  PENDING: ['ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Throttling, set per restaurant: bounds and defaults. */
export const SERVICE_REQUEST_THROTTLE = {
  /** A closed request of the same type cannot be repeated from the table for this long. */
  cooldownSeconds: { min: 0, max: 3600, default: 120 },
  /** Requests one table can send in an hour. */
  hourlyLimit: { min: 1, max: 200, default: 20 },
} as const;

export const SERVICE_REQUEST_LIMITS = {
  note: 200,
  /** A table session with no activity for this long is over; the next scan starts a new one. */
  sessionIdleHours: 4,
} as const;

export const SERVICE_REQUEST_ERROR_CODES = {
  /** The restaurant does not take requests (switched off, or its plan has no table ordering). */
  SERVICE_REQUESTS_UNAVAILABLE: 'SERVICE_REQUESTS_UNAVAILABLE',
  /** The table session is unknown, over, or of another table. */
  TABLE_SESSION_INVALID: 'TABLE_SESSION_INVALID',
  SERVICE_REQUEST_NOT_FOUND: 'SERVICE_REQUEST_NOT_FOUND',
  /** details: { retryAfterSeconds, reason: 'COOLDOWN' | 'HOURLY_LIMIT' } */
  SERVICE_REQUEST_THROTTLED: 'SERVICE_REQUEST_THROTTLED',
  /** details: { from, to, allowed } */
  INVALID_SERVICE_REQUEST_TRANSITION: 'INVALID_SERVICE_REQUEST_TRANSITION',
  /** The assignee is not staff who can see this request's branch. */
  SERVICE_REQUEST_ASSIGNEE_INVALID: 'SERVICE_REQUEST_ASSIGNEE_INVALID',
} as const;

// --- Diners -----------------------------------------------------------------

/**
 * POST /v1/public/restaurants/:subdomain/tables/:code/session: joins the table's current session
 * (everyone at the table shares it) or starts one. Send the token you already hold to keep it.
 */
export const joinTableSessionSchema = z.strictObject({ sessionToken: z.string().max(200).optional() });

/** POST /v1/public/service-requests. A custom request needs a note. */
export const createServiceRequestSchema = z
  .strictObject({
    sessionToken: z.string().min(1).max(200),
    type: z.enum(SERVICE_REQUEST_TYPES),
    note: z.string().trim().max(SERVICE_REQUEST_LIMITS.note).transform((value) => (value === '' ? null : value)).nullable().optional(),
  })
  .refine((input) => input.type !== 'CUSTOM' || !!input.note, { message: 'Write what you need.', path: ['note'] });

/** POST /v1/public/service-requests/:id/cancel: the guests withdraw a request nobody has taken yet. */
export const cancelServiceRequestSchema = z.strictObject({ sessionToken: z.string().min(1).max(200) });

export const serviceSessionQuerySchema = z.object({ token: z.string().min(1).max(200) });

/** What the guests see of a request. */
export type PublicServiceRequest = {
  id: string;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

export type TableServiceSession = {
  sessionToken: string;
  table: { label: string };
  /** This session's requests, newest first. */
  requests: PublicServiceRequest[];
};

/** A new request, or the one already open of the same type (`duplicate`). */
export type CreateServiceRequestResponse = { request: PublicServiceRequest; duplicate: boolean };

// --- Staff ------------------------------------------------------------------

/** GET /v1/service-requests: open requests (oldest first) or history (newest first). */
export const listServiceRequestsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  view: z.enum(['active', 'history']).default('active'),
  status: z.enum(SERVICE_REQUEST_STATUSES).optional(),
  type: z.enum(SERVICE_REQUEST_TYPES).optional(),
  /** An area of the branch, or "none" for tables in no area. */
  areaId: z.union([z.uuid(), z.literal('none')]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** PATCH /v1/service-requests/:id: a permitted status change, and/or who handles it (null unassigns). */
export const updateServiceRequestSchema = z
  .strictObject({ status: z.enum(SERVICE_REQUEST_STATUSES).optional(), assigneeId: z.uuid().nullable().optional() })
  .refine((input) => input.status !== undefined || input.assigneeId !== undefined, { message: 'Nothing to change.' });

export const serviceRequestStatsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export type ServiceRequestStaff = { id: string; name: string; role: RestaurantRole };

export type OwnerServiceRequest = {
  id: string;
  branchId: string;
  tableId: string | null;
  tableLabel: string;
  /** The table's area now (null when it has none, or the table is gone). */
  areaId: string | null;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  assignee: ServiceRequestStaff | null;
  handledBy: ServiceRequestStaff | null;
  createdAt: string;
  assignedAt: string | null;
  acknowledgedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledByGuest: boolean;
};

/**
 * GET /v1/service-requests/stats over the last `days`: how fast the staff respond (created to the
 * first staff action), how fast requests are done (created to completed), and what is still open.
 */
export type ServiceRequestStats = {
  days: number;
  total: number;
  completed: number;
  cancelled: number;
  /** Open now, whatever their age. */
  unresolved: number;
  averageResponseSeconds: number | null;
  averageCompletionSeconds: number | null;
};

/** Realtime: /owner gets ServiceRequestEvent; /table (auth { token: sessionToken }) gets TableServiceEvent. */
export const SERVICE_REQUEST_EVENTS = {
  CREATED: 'service-request.created',
  UPDATED: 'service-request.updated',
} as const;
export type ServiceRequestEvent = { request: OwnerServiceRequest };
export type TableServiceEvent = { request: PublicServiceRequest };
