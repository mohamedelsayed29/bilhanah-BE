import { ForbiddenException, Injectable } from '@nestjs/common';
import { type BranchComparison, COMMON_ERROR_CODES, type PlatformStats, type RestaurantStats } from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { businessDay } from '../orders/business-day.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { dayKey, VisitsService } from './visits.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Platform reports use Egypt's calendar. */
const PLATFORM_TIME_ZONE = 'Africa/Cairo';
const COUNTED_ORDER: Prisma.EnumOrderStatusFilter = { notIn: ['REJECTED', 'CANCELLED'] };

/** The `days` local dates ending today, oldest first, as UTC-midnight Dates. */
function periodDays(days: number, timeZone: string, now: Date): Date[] {
  const today = businessDay(now, timeZone);
  return Array.from({ length: days }, (_, index) => new Date(today.getTime() - (days - 1 - index) * DAY_MS));
}

/** Visits and orders over time, for a restaurant's owner and for administrators. */
@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visits: VisitsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly scopes: BranchScopeService,
  ) {}

  /** The whole restaurant, or one branch's orders (managers always get their branch). Visits are restaurant-wide. */
  async restaurant(userId: string, days: number, requestedBranchId?: string, now = new Date()): Promise<RestaurantStats> {
    const scope = await this.scopes.resolve(userId);
    if (!scope.permissions.has('analytics.view') && !scope.permissions.has('dashboard.view')) {
      throw new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have permission to do this.' });
    }
    // Revenue is only for those allowed to see the restaurant's finances.
    const financial = scope.permissions.has('analytics.financial');
    const money = (piastres: number) => (financial ? piastres : 0);
    const restaurant = scope.restaurant;
    const { branchId } = await this.scopes.branchWhere(scope, requestedBranchId);
    await this.visits.flush(now, restaurant.id);

    const dates = periodDays(days, restaurant.timezone, now);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const counted = { restaurantId: restaurant.id, ...(branchId && { branchId }), businessDay: { gte: from, lte: to }, status: COUNTED_ORDER };
    const branchSql = branchId ? Prisma.sql`AND o.branch_id = ${branchId}::uuid` : Prisma.empty;
    const [visitRows, orderRows, typeRows, topItems, access] = await Promise.all([
      this.prisma.restaurantDailyStat.findMany({ where: { restaurantId: restaurant.id, day: { gte: from, lte: to } } }),
      this.prisma.order.groupBy({ by: ['businessDay'], where: counted, _count: { _all: true }, _sum: { subtotalPiastres: true } }),
      this.prisma.order.groupBy({ by: ['type'], where: counted, _count: { _all: true } }),
      this.prisma.$queryRaw<{ nameAr: string; nameEn: string | null; quantity: bigint; revenue: bigint }[]>`
        SELECT i.name_ar AS "nameAr", i.name_en AS "nameEn", SUM(i.quantity) AS quantity, SUM(i.quantity * i.unit_price_piastres) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.restaurant_id = ${restaurant.id}::uuid AND o.business_day BETWEEN ${from} AND ${to}
          AND o.status NOT IN ('REJECTED', 'CANCELLED') ${branchSql}
        GROUP BY i.name_ar, i.name_en
        ORDER BY quantity DESC, revenue DESC, i.name_ar
        LIMIT 5`,
      this.subscriptions.accessFor(restaurant, now),
    ]);

    const visitsByDay = new Map(visitRows.map((row) => [dayKey(row.day), row]));
    const ordersByDay = new Map(orderRows.map((row) => [dayKey(row.businessDay), row]));
    const series = dates.map((date) => {
      const key = dayKey(date);
      const orders = ordersByDay.get(key);
      return { date: key, visits: visitsByDay.get(key)?.visits ?? 0, orders: orders?._count._all ?? 0, revenuePiastres: money(orders?._sum.subtotalPiastres ?? 0) };
    });
    const totals = series.reduce((sum, day) => ({ visits: sum.visits + day.visits, orders: sum.orders + day.orders, revenuePiastres: sum.revenuePiastres + day.revenuePiastres }), { visits: 0, orders: 0, revenuePiastres: 0 });
    return {
      days: series,
      totals: { ...totals, averageOrderPiastres: totals.orders ? Math.round(totals.revenuePiastres / totals.orders) : 0 },
      sources: visitRows.reduce((sum, row) => ({ qr: sum.qr + row.qrVisits, table: sum.table + row.tableVisits, link: sum.link + row.linkVisits }), { qr: 0, table: 0, link: 0 }),
      ordersByType: {
        DINE_IN: typeRows.find((row) => row.type === 'DINE_IN')?._count._all ?? 0,
        PICKUP: typeRows.find((row) => row.type === 'PICKUP')?._count._all ?? 0,
      },
      topItems: topItems.map((item) => ({ nameAr: item.nameAr, nameEn: item.nameEn, quantity: Number(item.quantity), revenuePiastres: money(Number(item.revenue)) })),
      ordering: access.features.ordering,
      branchId: branchId ?? null,
      financial,
    };
  }

  /** Every branch side by side over the period: orders, revenue, average ticket, prep time and order types. */
  async branches(userId: string, days: number, now = new Date()): Promise<BranchComparison> {
    const scope = await this.scopes.resolve(userId);
    if (!scope.permissions.has('analytics.financial')) throw new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have permission to do this.' });
    const dates = periodDays(days, scope.restaurant.timezone, now);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const [branches, rows] = await Promise.all([
      this.scopes.visibleBranches(scope),
      this.prisma.$queryRaw<{ branchId: string; orders: bigint; revenue: bigint | null; dineIn: bigint; pickup: bigint; prepMinutes: number | null }[]>`
        SELECT o.branch_id AS "branchId", COUNT(*) AS orders, SUM(o.subtotal_piastres) AS revenue,
          COUNT(*) FILTER (WHERE o.type = 'DINE_IN') AS "dineIn", COUNT(*) FILTER (WHERE o.type = 'PICKUP') AS pickup,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.ready_at - o.placed_at)) / 60)
            FILTER (WHERE o.ready_at IS NOT NULL) AS "prepMinutes"
        FROM orders o
        WHERE o.restaurant_id = ${scope.restaurant.id}::uuid AND o.business_day BETWEEN ${from} AND ${to}
          AND o.status NOT IN ('REJECTED', 'CANCELLED')
        GROUP BY o.branch_id`,
    ]);
    const total = rows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0);
    return {
      days,
      branches: branches.map((branch) => {
        const row = rows.find((candidate) => candidate.branchId === branch.id);
        const orders = Number(row?.orders ?? 0);
        const revenuePiastres = Number(row?.revenue ?? 0);
        return {
          id: branch.id,
          name: branch.name,
          slug: branch.slug,
          isActive: branch.isActive,
          orders,
          revenuePiastres,
          averageOrderPiastres: orders ? Math.round(revenuePiastres / orders) : 0,
          medianPrepMinutes: row?.prepMinutes == null ? null : Math.round(Number(row.prepMinutes) * 10) / 10,
          dineIn: Number(row?.dineIn ?? 0),
          pickup: Number(row?.pickup ?? 0),
          revenueShare: total ? revenuePiastres / total : 0,
        };
      }),
    };
  }

  async platform(days: number, now = new Date()): Promise<PlatformStats> {
    await this.visits.flush(now);
    const dates = periodDays(days, PLATFORM_TIME_ZONE, now);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const cairoDay = (column: Prisma.Sql) => Prisma.sql`(${column} AT TIME ZONE ${PLATFORM_TIME_ZONE})::date`;

    const [visitRows, orderRows, restaurantRows, revenueRows, stand, topVisits] = await Promise.all([
      this.prisma.restaurantDailyStat.groupBy({ by: ['day'], where: { day: { gte: from, lte: to } }, _sum: { visits: true } }),
      this.prisma.order.groupBy({ by: ['businessDay'], where: { businessDay: { gte: from, lte: to }, status: COUNTED_ORDER }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT ${cairoDay(Prisma.sql`created_at`)} AS day, COUNT(*) AS count FROM restaurants
        WHERE ${cairoDay(Prisma.sql`created_at`)} BETWEEN ${from}::date AND ${to}::date GROUP BY 1`,
      this.prisma.$queryRaw<{ day: Date; amount: bigint }[]>`
        SELECT ${cairoDay(Prisma.sql`reviewed_at`)} AS day, SUM(amount_piastres) AS amount FROM subscription_payments
        WHERE status = 'APPROVED' AND ${cairoDay(Prisma.sql`reviewed_at`)} BETWEEN ${from}::date AND ${to}::date GROUP BY 1`,
      // Stand orders placed in the period that went ahead (paid online, or cash orders not cancelled).
      this.prisma.$queryRaw<{ count: bigint; amount: bigint | null }[]>`
        SELECT COUNT(*) AS count, SUM(total_piastres) AS amount FROM stand_orders
        WHERE status NOT IN ('AWAITING_PAYMENT', 'CANCELLED') AND ${cairoDay(Prisma.sql`created_at`)} BETWEEN ${from}::date AND ${to}::date`,
      this.prisma.restaurantDailyStat.groupBy({
        by: ['restaurantId'],
        where: { day: { gte: from, lte: to } },
        _sum: { visits: true },
        orderBy: { _sum: { visits: 'desc' } },
        take: 10,
      }),
    ]);

    const visitsByDay = new Map(visitRows.map((row) => [dayKey(row.day), row._sum.visits ?? 0]));
    const ordersByDay = new Map(orderRows.map((row) => [dayKey(row.businessDay), row._count._all]));
    const restaurantsByDay = new Map(restaurantRows.map((row) => [dayKey(row.day), Number(row.count)]));
    const revenueByDay = new Map(revenueRows.map((row) => [dayKey(row.day), Number(row.amount)]));
    const series = dates.map((date) => {
      const key = dayKey(date);
      return {
        date: key,
        visits: visitsByDay.get(key) ?? 0,
        orders: ordersByDay.get(key) ?? 0,
        newRestaurants: restaurantsByDay.get(key) ?? 0,
        revenuePiastres: revenueByDay.get(key) ?? 0,
      };
    });

    const topIds = topVisits.map((row) => row.restaurantId);
    const [topRestaurants, topOrders] = await Promise.all([
      this.prisma.restaurant.findMany({ where: { id: { in: topIds } }, select: { id: true, name: true, subdomain: true } }),
      this.prisma.order.groupBy({ by: ['restaurantId'], where: { restaurantId: { in: topIds }, businessDay: { gte: from, lte: to }, status: COUNTED_ORDER }, _count: { _all: true } }),
    ]);

    return {
      days: series,
      totals: {
        visits: series.reduce((sum, day) => sum + day.visits, 0),
        orders: series.reduce((sum, day) => sum + day.orders, 0),
        newRestaurants: series.reduce((sum, day) => sum + day.newRestaurants, 0),
        revenuePiastres: series.reduce((sum, day) => sum + day.revenuePiastres, 0),
        standOrders: Number(stand[0]?.count ?? 0),
        standRevenuePiastres: Number(stand[0]?.amount ?? 0),
      },
      topRestaurants: topVisits.flatMap((row) => {
        const restaurant = topRestaurants.find((candidate) => candidate.id === row.restaurantId);
        if (!restaurant) return [];
        return [{ ...restaurant, visits: row._sum.visits ?? 0, orders: topOrders.find((orders) => orders.restaurantId === row.restaurantId)?._count._all ?? 0 }];
      }),
    };
  }
}
