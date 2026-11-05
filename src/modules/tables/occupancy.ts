import { SEATED_HOLD_HOURS, TABLE_OCCUPANCY_HOURS, TABLE_RESERVED_WINDOW, type TableStatus } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';

/** Orders that keep a table occupied: dine-in, not rejected or cancelled, unpaid, and recent (TABLE_OCCUPANCY_HOURS). */
export function openOrdersWhere(branchId: string, now: Date): Prisma.OrderWhereInput {
  return {
    branchId,
    type: 'DINE_IN',
    paidAt: null,
    status: { notIn: ['REJECTED', 'CANCELLED'] },
    placedAt: { gte: new Date(now.getTime() - TABLE_OCCUPANCY_HOURS * 60 * 60 * 1000) },
  };
}

/** One table's open orders: by its id, or by its name for orders typed in by hand ("Table 5"). */
export function openOrdersOnTableWhere(table: { id: string; label: string; branchId: string }, now: Date): Prisma.OrderWhereInput {
  return { ...openOrdersWhere(table.branchId, now), OR: [{ tableId: table.id }, { tableId: null, tableLabel: table.label }] };
}

/** Booked parties seated at a table: they keep it occupied until the bill is settled (at most SEATED_HOLD_HOURS). */
export function seatedWhere(branchId: string, now: Date): Prisma.ReservationWhereInput {
  return {
    branchId,
    tableId: { not: null },
    status: 'SEATED',
    reservedAt: { gte: new Date(now.getTime() - SEATED_HOLD_HOURS * 60 * 60_000), lte: new Date(now.getTime() + TABLE_RESERVED_WINDOW.beforeMinutes * 60_000) },
  };
}

/** The status shown for a table, from what is known about it (see TABLE_STATUSES for the order). */
export function tableStatusOf(input: { isActive: boolean; occupied: boolean; cleaning: boolean; reserved: boolean }): TableStatus {
  if (!input.isActive) return 'UNAVAILABLE';
  if (input.occupied) return 'OCCUPIED';
  if (input.cleaning) return 'CLEANING';
  if (input.reserved) return 'RESERVED';
  return 'AVAILABLE';
}
