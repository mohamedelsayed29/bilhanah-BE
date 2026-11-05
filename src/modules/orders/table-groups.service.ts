import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createTableGroupSchema,
  ORDER_ERROR_CODES,
  TABLE_RESERVED_WINDOW,
  type TableGroupView,
  UPCOMING_RESERVATION_STATUSES,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { liveSessionWhere } from '../table-sessions/session-lifecycle.js';
import { openOrdersOnTableWhere, seatedWhere } from '../tables/occupancy.js';

const invalid = (message: string, details?: unknown) => new ConflictException({ code: ORDER_ERROR_CODES.TABLE_GROUP_INVALID, message, ...(details !== undefined && { details }) });
const notFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_GROUP_NOT_FOUND, message: 'These tables are not merged (any more).' });

type Member = { id: string; label: string; branchId: string; restaurantId: string; areaId: string | null; location: string; isActive: boolean; seats: number; sortOrder: number; groupId: string | null };

/**
 * Merging tables for a larger party, and separating them again. A group shares the lead table's session (so every
 * member's QR code joins the same guests and shared order), one status and one bill. Orders keep the table they
 * were placed at, so separating the group leaves every table's history as it was.
 */
@Injectable()
export class TableGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(userId: string, input: z.output<typeof createTableGroupSchema>, now = new Date()): Promise<TableGroupView> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'tables.status');
    const own = await this.scopes.branchWhere(scope);
    const group = await this.prisma.$transaction(async (tx) => {
      // Lock the tables (in a fixed order): two merges of the same table cannot both go through.
      const ids = [...input.tableIds].sort();
      await tx.$queryRaw`SELECT id FROM tables WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const tables: Member[] = await tx.table.findMany({
        where: { id: { in: ids }, ...own },
        select: { id: true, label: true, branchId: true, restaurantId: true, areaId: true, location: true, isActive: true, seats: true, sortOrder: true, groupId: true },
        orderBy: { sortOrder: 'asc' },
      });
      if (tables.length !== ids.length) throw new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'One of these tables was not found.' });
      const [first] = tables as [Member, ...Member[]];
      if (tables.some((table) => table.branchId !== first.branchId)) throw invalid('Only tables of one branch can be merged.');
      if (tables.some((table) => table.areaId !== first.areaId || (first.areaId === null && table.location !== first.location))) {
        throw invalid('Only tables in the same area can be merged.');
      }
      const off = tables.filter((table) => !table.isActive);
      if (off.length) throw invalid('Switched-off tables cannot be merged.', { tables: off.map((table) => table.label) });
      const merged = tables.filter((table) => table.groupId);
      if (merged.length) throw invalid('One of these tables is already merged.', { tables: merged.map((table) => table.label) });

      // At most one party among them: the group takes over that table's session and booking.
      const parties = await this.parties(tx, tables, now);
      if (parties.length > 1) {
        throw new ConflictException({
          code: ORDER_ERROR_CODES.TABLE_GROUP_CONFLICT,
          message: 'Two of these tables have different guests or bookings: they cannot share one seating.',
          details: { tables: parties.map((party) => party.label) },
        });
      }
      const lead = parties[0] ?? first;
      const created = await tx.tableGroup.create({
        data: { restaurantId: first.restaurantId, branchId: first.branchId, leadTableId: lead.id, tableIds: tables.map((table) => table.id), label: input.label ?? null, createdAt: now },
      });
      await tx.table.updateMany({ where: { id: { in: ids } }, data: { groupId: created.id } });
      return { ...created, tables };
    });
    this.announce(group.restaurantId, group.branchId, group.tableIds);
    return this.view(group.id);
  }

  /** Separates merged tables. Guests at them must be billed first, so no party is split between tables. */
  async dissolve(userId: string, groupId: string, now = new Date()): Promise<void> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'tables.status');
    const own = await this.scopes.branchWhere(scope);
    const group = await this.prisma.tableGroup.findFirst({ where: { id: groupId, dissolvedAt: null, ...own }, include: { tables: { select: { id: true, label: true, branchId: true } } } });
    if (!group) throw notFound();
    const busy = await this.prisma.$transaction(async (tx) => {
      const occupied = (await Promise.all(group.tables.map(async (table) => {
        const [orders, seated] = await Promise.all([
          tx.order.count({ where: openOrdersOnTableWhere(table, now) }),
          tx.reservation.count({ where: { ...seatedWhere(table.branchId, now), tableId: table.id } }),
        ]);
        return orders + seated > 0;
      }))).some(Boolean);
      const guests = await tx.tableGuest.count({ where: { session: { tableId: group.leadTableId, ...liveSessionWhere(now) } } });
      if (occupied || guests > 0) return true;
      await tx.table.updateMany({ where: { groupId: group.id }, data: { groupId: null } });
      await tx.tableGroup.update({ where: { id: group.id }, data: { dissolvedAt: now } });
      return false;
    });
    if (busy) throw new ConflictException({ code: ORDER_ERROR_CODES.TABLE_GROUP_BUSY, message: 'Guests are at these tables: settle their bill before separating them.' });
    this.announce(group.restaurantId, group.branchId, group.tables.map((table) => table.id));
  }

  /** The tables among these with a party: guests (open orders, a live session with guests, a seated booking) or an upcoming booking. */
  private async parties(tx: Prisma.TransactionClient, tables: Member[], now: Date): Promise<Member[]> {
    const found = await Promise.all(tables.map(async (table) => {
      const [orders, seated, guests, booked] = await Promise.all([
        tx.order.count({ where: openOrdersOnTableWhere(table, now) }),
        tx.reservation.count({ where: { ...seatedWhere(table.branchId, now), tableId: table.id } }),
        tx.tableGuest.count({ where: { session: { tableId: table.id, ...liveSessionWhere(now) } } }),
        tx.reservation.count({
          where: {
            tableId: table.id,
            status: { in: [...UPCOMING_RESERVATION_STATUSES] },
            reservedAt: { gte: new Date(now.getTime() - TABLE_RESERVED_WINDOW.afterMinutes * 60_000), lte: new Date(now.getTime() + TABLE_RESERVED_WINDOW.beforeMinutes * 60_000) },
          },
        }),
      ]);
      return orders + seated + guests + booked > 0 ? table : null;
    }));
    return found.filter((table): table is Member => table !== null);
  }

  private async view(groupId: string): Promise<TableGroupView> {
    const group = await this.prisma.tableGroup.findUniqueOrThrow({ where: { id: groupId }, include: { tables: { select: { id: true, label: true, seats: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } } } });
    return {
      id: group.id,
      branchId: group.branchId,
      label: group.label,
      leadTableId: group.leadTableId,
      tableIds: group.tables.map((table) => table.id),
      tableLabels: group.tables.map((table) => table.label),
      seats: group.tables.reduce((sum, table) => sum + table.seats, 0),
      createdAt: group.createdAt.toISOString(),
    };
  }

  /** Every dashboard of the branch fetches its floor again. */
  private announce(restaurantId: string, branchId: string, tableIds: string[]) {
    for (const tableId of tableIds) this.realtime.emitTableUpdated(restaurantId, { branchId, tableId, status: 'AVAILABLE' });
  }
}
