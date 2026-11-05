import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTIVE_RESERVATION_STATUSES,
  type createReservationSchema,
  RESERVATION_SLOT_MINUTES,
  type ReservationStatus,
  type listReservationsQuerySchema,
  ORDER_ERROR_CODES,
  RESERVATION_ERROR_CODES,
  type Reservation,
  type updateReservationSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';

const reservationNotFound = () => new NotFoundException({ code: RESERVATION_ERROR_CODES.RESERVATION_NOT_FOUND, message: 'Reservation not found.' });
const tableNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'Table not found.' });
const conflict = (other: { customerName: string; reservedAt: Date }) => new ConflictException({
  code: RESERVATION_ERROR_CODES.RESERVATION_CONFLICT,
  message: `This table is already booked within ${RESERVATION_SLOT_MINUTES} minutes of that time.`,
  details: { customerName: other.customerName, reservedAt: other.reservedAt.toISOString() },
});
const tableRequired = () => new ConflictException({ code: RESERVATION_ERROR_CODES.RESERVATION_TABLE_REQUIRED, message: 'Pick a table before seating the guests.' });
const tableUnavailable = () => new ConflictException({ code: RESERVATION_ERROR_CODES.RESERVATION_TABLE_UNAVAILABLE, message: 'This table is switched off.' });
const SLOT_MS = RESERVATION_SLOT_MINUTES * 60_000;
const holdsSlot = (status: ReservationStatus) => (ACTIVE_RESERVATION_STATUSES as readonly string[]).includes(status);

const withTable = { table: { select: { label: true } } } as const;
type Row = Prisma.ReservationGetPayload<{ include: typeof withTable }>;

/**
 * Bookings taken by staff. A pending or confirmed booking on a table shows that table as reserved
 * on the floor plan around its time (TABLE_RESERVED_WINDOW). Owners see every branch's bookings,
 * managers their own branch's.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
  ) {}

  async list(userId: string, query: z.output<typeof listReservationsQuerySchema>): Promise<Reservation[]> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope, query.branchId);
    const rows = await this.prisma.reservation.findMany({
      where: { ...where, reservedAt: { gte: new Date(query.from), lt: new Date(query.to) }, ...(query.status && { status: query.status }) },
      orderBy: { reservedAt: 'asc' },
      include: withTable,
    });
    return rows.map(toView);
  }

  async create(userId: string, input: z.output<typeof createReservationSchema>): Promise<Reservation> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, input.branchId);
    const { branchId: _branch, tableId, reservedAt, ...fields } = input;
    const at = new Date(reservedAt);
    if (fields.status === 'SEATED' && !tableId) throw tableRequired();
    const row = await this.prisma.$transaction(async (tx) => {
      if (tableId) await this.checkSlot(tx, { branchId: branch.id, tableId, at, status: fields.status });
      return tx.reservation.create({
        data: { ...fields, restaurantId: scope.restaurant.id, branchId: branch.id, tableId: tableId ?? null, reservedAt: at },
        include: withTable,
      });
    });
    return toView(row);
  }

  async update(userId: string, reservationId: string, input: z.output<typeof updateReservationSchema>): Promise<Reservation> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope);
    const current = await this.prisma.reservation.findFirst({
      where: { id: reservationId, ...where },
      select: { id: true, branchId: true, tableId: true, reservedAt: true, status: true },
    });
    if (!current) throw reservationNotFound();
    const { reservedAt, tableId, ...fields } = input;
    // The booking as it will be once saved: what the slot and seating checks look at.
    const next = {
      tableId: tableId !== undefined ? tableId : current.tableId,
      at: reservedAt ? new Date(reservedAt) : current.reservedAt,
      status: fields.status ?? current.status,
    };
    if (next.status === 'SEATED' && !next.tableId) throw tableRequired();
    // Only a change of table, time or status (back to an active one) can create a clash.
    const recheck = next.tableId && holdsSlot(next.status)
      && (tableId !== undefined || reservedAt !== undefined || (fields.status !== undefined && !holdsSlot(current.status)));
    const row = await this.prisma.$transaction(async (tx) => {
      if (recheck) await this.checkSlot(tx, { branchId: current.branchId, tableId: next.tableId!, at: next.at, status: next.status, exceptId: current.id });
      else if (tableId) await this.checkTable(tx, current.branchId, tableId);
      return tx.reservation.update({
        where: { id: current.id },
        data: { ...fields, ...(tableId !== undefined && { tableId }), ...(reservedAt && { reservedAt: next.at }) },
        include: withTable,
      });
    });
    return toView(row);
  }

  /** A booking's table must stand in the booking's branch and be switched on. */
  private async checkTable(tx: Prisma.TransactionClient, branchId: string, tableId: string) {
    const table = await tx.table.findFirst({ where: { id: tableId, branchId }, select: { isActive: true } });
    if (!table) throw tableNotFound();
    if (!table.isActive) throw tableUnavailable();
  }

  /**
   * No two active bookings on one table within RESERVATION_SLOT_MINUTES of each other. The table's row is
   * locked for the transaction, so two bookings made at the same moment cannot both take the slot.
   */
  private async checkSlot(tx: Prisma.TransactionClient, input: { branchId: string; tableId: string; at: Date; status: ReservationStatus; exceptId?: string }) {
    await tx.$queryRaw`SELECT id FROM tables WHERE id = ${input.tableId}::uuid FOR UPDATE`;
    await this.checkTable(tx, input.branchId, input.tableId);
    if (!holdsSlot(input.status)) return;
    const clash = await tx.reservation.findFirst({
      where: {
        tableId: input.tableId,
        status: { in: [...ACTIVE_RESERVATION_STATUSES] },
        reservedAt: { gt: new Date(input.at.getTime() - SLOT_MS), lt: new Date(input.at.getTime() + SLOT_MS) },
        ...(input.exceptId && { id: { not: input.exceptId } }),
      },
      orderBy: { reservedAt: 'asc' },
      select: { customerName: true, reservedAt: true },
    });
    if (clash) throw conflict(clash);
  }
}

function toView(row: Row): Reservation {
  return {
    id: row.id,
    branchId: row.branchId,
    tableId: row.tableId,
    tableLabel: row.table?.label ?? null,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    guests: row.guests,
    reservedAt: row.reservedAt.toISOString(),
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}
