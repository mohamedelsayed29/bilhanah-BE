import { Injectable } from '@nestjs/common';
import { type TableAnalytics, type TableAnalyticsRow, type tableAnalyticsQuerySchema, type TableOccupancy } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { OrdersService } from '../orders/orders.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTED: Prisma.EnumOrderStatusFilter = { notIn: ['REJECTED', 'CANCELLED'] };

/** The UTC instant of local midnight starting `day` (YYYY-MM-DD) in `timeZone`. */
export function localMidnight(day: string, timeZone: string): Date {
  const guess = new Date(`${day}T00:00:00.000Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map((part) => [part.type, part.value]));
  const asLocal = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

type Seating = { tableId: string; minutes: number | null };

/**
 * How the tables are used and what they earn, for owners (analytics.view; revenue with analytics.financial).
 * A seating is one party at a table: a table session (from its start to its close, or its last activity when it
 * expired idle), or, for orders sent without a session, the orders up to the bill that paid them. Revenue is the
 * paid dine-in orders placed in the period (their restaurant day), so it matches the cash taken.
 */
@Injectable()
export class TableAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly orders: OrdersService,
  ) {}

  async get(userId: string, query: z.output<typeof tableAnalyticsQuerySchema>, now = new Date()): Promise<TableAnalytics> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'analytics.view');
    const financial = scope.permissions.has('analytics.financial');
    const where = await this.scopes.branchWhere(scope, query.branchId);
    const timeZone = scope.restaurant.timezone;
    const start = localMidnight(query.from, timeZone);
    const end = localMidnight(new Date(Date.parse(query.to) + DAY_MS).toISOString().slice(0, 10), timeZone);
    const fromDay = new Date(`${query.from}T00:00:00.000Z`);
    const toDay = new Date(`${query.to}T00:00:00.000Z`);
    const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;

    const tables = await this.prisma.table.findMany({
      where: { ...where, ...(query.areaId === 'NONE' ? { areaId: null } : query.areaId ? { areaId: query.areaId } : {}) },
      orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }],
      select: { id: true, label: true, seats: true, isActive: true, areaId: true, branchId: true, area: { select: { name: true } } },
    });
    const ids = tables.map((table) => table.id);
    const inPeriod = { tableId: { in: ids }, type: 'DINE_IN' as const, businessDay: { gte: fromDay, lte: toDay }, status: COUNTED };

    const [sessions, loose, orderCounts, paid, scans, firstScan] = await Promise.all([
      this.prisma.tableSession.findMany({
        where: { tableId: { in: ids }, startedAt: { gte: start, lt: end } },
        select: { tableId: true, status: true, closedReason: true, startedAt: true, endedAt: true, lastActivityAt: true },
      }),
      this.prisma.order.findMany({ where: { ...inPeriod, tableSessionId: null }, select: { tableId: true, placedAt: true, paidAt: true, businessDay: true } }),
      this.prisma.order.groupBy({ by: ['tableId'], where: inPeriod, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['tableId'], where: { ...inPeriod, paidAt: { not: null } }, _sum: { subtotalPiastres: true } }),
      this.prisma.tableDailyStat.groupBy({ by: ['tableId'], where: { tableId: { in: ids }, day: { gte: fromDay, lte: toDay } }, _sum: { scans: true } }),
      this.prisma.tableDailyStat.findFirst({ where: { restaurantId: scope.restaurant.id }, orderBy: { day: 'asc' }, select: { day: true } }),
    ]);

    const seatings: Seating[] = sessions.map((session) => {
      if (session.status !== 'CLOSED') return { tableId: session.tableId, minutes: null };
      // A session closed for being idle ended at its last use, not when it was swept.
      const ended = session.closedReason === 'EXPIRED' ? session.lastActivityAt : session.endedAt ?? session.lastActivityAt;
      return { tableId: session.tableId, minutes: Math.max(0, (ended.getTime() - session.startedAt.getTime()) / 60_000) };
    });
    // Orders without a session: those paid together are one party, from the first order to the payment.
    const parties = new Map<string, { tableId: string; firstAt: Date; paidAt: Date | null }>();
    for (const order of loose) {
      if (!order.tableId) continue;
      const key = order.paidAt ? `${order.tableId}|paid|${order.paidAt.getTime()}` : `${order.tableId}|open|${order.businessDay.getTime()}`;
      const party = parties.get(key);
      if (!party) parties.set(key, { tableId: order.tableId, firstAt: order.placedAt, paidAt: order.paidAt });
      else if (order.placedAt < party.firstAt) party.firstAt = order.placedAt;
    }
    for (const party of parties.values()) {
      seatings.push({ tableId: party.tableId, minutes: party.paidAt ? Math.max(0, (party.paidAt.getTime() - party.firstAt.getTime()) / 60_000) : null });
    }

    const average = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
    const rows: TableAnalyticsRow[] = tables.map((table) => {
      const own = seatings.filter((seating) => seating.tableId === table.id);
      return {
        id: table.id,
        label: table.label,
        areaId: table.areaId,
        areaName: table.area?.name ?? null,
        seats: table.seats,
        isActive: table.isActive,
        seatings: own.length,
        averageOccupancyMinutes: average(own.flatMap((seating) => (seating.minutes === null ? [] : [seating.minutes]))),
        turnoverRate: Math.round((own.length / days) * 100) / 100,
        orders: orderCounts.find((row) => row.tableId === table.id)?._count._all ?? 0,
        revenuePiastres: financial ? (paid.find((row) => row.tableId === table.id)?._sum.subtotalPiastres ?? 0) : null,
        scans: scans.find((row) => row.tableId === table.id)?._sum.scans ?? 0,
      };
    });
    rows.sort((a, b) => b.seatings - a.seatings || b.orders - a.orders || (b.revenuePiastres ?? 0) - (a.revenuePiastres ?? 0) || a.label.localeCompare(b.label));

    const active = tables.filter((table) => table.isActive).length;
    return {
      from: query.from,
      to: query.to,
      days,
      now: await this.liveCounts(userId, tables, now),
      summary: {
        seatings: seatings.length,
        averageOccupancyMinutes: average(seatings.flatMap((seating) => (seating.minutes === null ? [] : [seating.minutes]))),
        turnoverRate: active ? Math.round((seatings.length / (active * days)) * 100) / 100 : null,
        orders: rows.reduce((sum, row) => sum + row.orders, 0),
        revenuePiastres: financial ? rows.reduce((sum, row) => sum + (row.revenuePiastres ?? 0), 0) : null,
        scans: rows.reduce((sum, row) => sum + row.scans, 0),
        scanTrackingSince: firstScan ? firstScan.day.toISOString().slice(0, 10) : null,
      },
      tables: rows,
    };
  }

  /** Right now, as the floor plan shows the tables (switched-off ones are unavailable). */
  private async liveCounts(userId: string, tables: { id: string; branchId: string; isActive: boolean }[], now: Date): Promise<TableAnalytics['now']> {
    const counts = { total: tables.length, available: 0, occupied: 0, reserved: 0, cleaning: 0, unavailable: tables.filter((table) => !table.isActive).length };
    const branches = [...new Set(tables.filter((table) => table.isActive).map((table) => table.branchId))];
    const floors: TableOccupancy[] = (await Promise.all(branches.map((branchId) => this.orders.floor(userId, branchId, now)))).flat();
    const wanted = new Set(tables.map((table) => table.id));
    for (const row of floors) {
      if (!wanted.has(row.id)) continue;
      if (row.status === 'AVAILABLE') counts.available += 1;
      else if (row.status === 'OCCUPIED') counts.occupied += 1;
      else if (row.status === 'RESERVED') counts.reserved += 1;
      else if (row.status === 'CLEANING') counts.cleaning += 1;
    }
    return counts;
  }
}
