import { z } from 'zod';

/** Bookings taken by staff for a branch: who, when, how many, and (optionally) which table. */
export const RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Bookings still to come: they hold their table (TABLE_RESERVED_WINDOW). */
export const UPCOMING_RESERVATION_STATUSES = ['PENDING', 'CONFIRMED'] as const satisfies readonly ReservationStatus[];

export const RESERVATION_LIMITS = { guests: 50, rangeDays: 31 } as const;

export const RESERVATION_ERROR_CODES = {
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
} as const;

const isoDateTime = z.iso.datetime({ offset: true });
const phone = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));
const optionalPhone = z.union([z.literal('').transform(() => null), phone]).nullable().optional();
const optionalNotes = z.string().trim().max(300).transform((value) => (value === '' ? null : value)).nullable().optional();

/** POST /v1/reservations: the branch defaults to the main one (or the manager's). */
export const createReservationSchema = z.strictObject({
  branchId: z.uuid().optional(),
  tableId: z.uuid().nullable().optional(),
  customerName: z.string().trim().min(1).max(80),
  customerPhone: optionalPhone,
  guests: z.number().int().min(1).max(RESERVATION_LIMITS.guests),
  reservedAt: isoDateTime,
  status: z.enum(RESERVATION_STATUSES).default('CONFIRMED'),
  notes: optionalNotes,
});

/** PATCH /v1/reservations/:id */
export const updateReservationSchema = z.strictObject({
  tableId: z.uuid().nullable().optional(),
  customerName: z.string().trim().min(1).max(80).optional(),
  customerPhone: optionalPhone,
  guests: z.number().int().min(1).max(RESERVATION_LIMITS.guests).optional(),
  reservedAt: isoDateTime.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  notes: optionalNotes,
});

/** GET /v1/reservations?from=&to=: bookings in [from, to), earliest first, up to RESERVATION_LIMITS.rangeDays apart. */
export const listReservationsQuerySchema = z
  .object({ branchId: z.uuid().optional(), from: isoDateTime, to: isoDateTime })
  .refine((range) => {
    const span = Date.parse(range.to) - Date.parse(range.from);
    return span > 0 && span <= RESERVATION_LIMITS.rangeDays * 24 * 60 * 60 * 1000;
  }, { message: `"to" must be after "from", at most ${RESERVATION_LIMITS.rangeDays} days later.`, path: ['to'] });

export type Reservation = {
  id: string;
  branchId: string;
  tableId: string | null;
  /** The table's current name, when it has one. */
  tableLabel: string | null;
  customerName: string;
  customerPhone: string | null;
  guests: number;
  reservedAt: string;
  status: ReservationStatus;
  notes: string | null;
  createdAt: string;
};
