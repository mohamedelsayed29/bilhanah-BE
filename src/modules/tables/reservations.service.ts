import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type createReservationSchema,
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
      where: { ...where, reservedAt: { gte: new Date(query.from), lt: new Date(query.to) } },
      orderBy: { reservedAt: 'asc' },
      include: withTable,
    });
    return rows.map(toView);
  }

  async create(userId: string, input: z.output<typeof createReservationSchema>): Promise<Reservation> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, input.branchId);
    const { branchId: _branch, tableId, reservedAt, ...fields } = input;
    if (tableId) await this.checkTable(branch.id, tableId);
    const row = await this.prisma.reservation.create({
      data: { ...fields, restaurantId: scope.restaurant.id, branchId: branch.id, tableId: tableId ?? null, reservedAt: new Date(reservedAt) },
      include: withTable,
    });
    return toView(row);
  }

  async update(userId: string, reservationId: string, input: z.output<typeof updateReservationSchema>): Promise<Reservation> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope);
    const current = await this.prisma.reservation.findFirst({ where: { id: reservationId, ...where }, select: { id: true, branchId: true } });
    if (!current) throw reservationNotFound();
    const { reservedAt, tableId, ...fields } = input;
    if (tableId) await this.checkTable(current.branchId, tableId);
    const row = await this.prisma.reservation.update({
      where: { id: current.id },
      data: { ...fields, ...(tableId !== undefined && { tableId }), ...(reservedAt && { reservedAt: new Date(reservedAt) }) },
      include: withTable,
    });
    return toView(row);
  }

  /** A booking's table must stand in the booking's branch. */
  private async checkTable(branchId: string, tableId: string) {
    const exists = await this.prisma.table.count({ where: { id: tableId, branchId } });
    if (!exists) throw tableNotFound();
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
