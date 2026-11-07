import { ForbiddenException, Injectable } from '@nestjs/common';
import { COMMON_ERROR_CODES, type OverviewDish, type OverviewPeriod, type RestaurantOverview } from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { MediaService } from '../media/media.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_DAYS: Record<OverviewPeriod, number> = { today: 1, week: 7, month: 30 };
const SOLD_OUT_SHOWN = 4;

type Totals = { current: boolean; orders: bigint; revenue: bigint | null; dine_in: bigint; pickup: bigint };

/**
 * The dashboard's home: today's (or the last 7 or 30 days') figures against the period before,
 * sales hour by hour or day by day, income by menu category, the dishes ordering most, and what
 * is sold out now. Rejected and cancelled orders never count; amounts are bills after discounts.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly media: MediaService,
  ) {}

  async get(userId: string, period: OverviewPeriod, requestedBranchId?: string, now = new Date()): Promise<RestaurantOverview> {
    const scope = await this.scopes.resolve(userId);
    if (!scope.permissions.has('analytics.view') && !scope.permissions.has('dashboard.view')) {
      throw new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have permission to do this.' });
    }
    const financial = scope.permissions.has('analytics.financial');
    const money = (piastres: number) => (financial ? piastres : 0);
    const { restaurant } = scope;
    const tz = restaurant.timezone;
    const { branchId } = await this.scopes.branchWhere(scope, requestedBranchId);
    const days = PERIOD_DAYS[period];
    const unit = period === 'today' ? 'hour' : 'day';

    // The period starts at local midnight (days - 1 days ago); the previous one is as long and ends as far into it.
    const [periodStart] = await this.prisma.$queryRaw<{ start: Date }[]>`
      SELECT ((date_trunc('day', ${now}::timestamptz AT TIME ZONE ${tz}) - (${days - 1} * interval '1 day')) AT TIME ZONE ${tz}) AS start`;
    const start = periodStart!.start;
    const length = days * DAY_MS;
    const previousStart = new Date(start.getTime() - length);
    const previousEnd = new Date(now.getTime() - length);
    const branchSql = branchId ? Prisma.sql`AND o.branch_id = ${branchId}::uuid` : Prisma.empty;
    const counted = Prisma.sql`o.restaurant_id = ${restaurant.id}::uuid ${branchSql} AND o.status NOT IN ('REJECTED', 'CANCELLED')`;
    const step = unit === 'hour' ? Prisma.sql`interval '1 hour'` : Prisma.sql`interval '1 day'`;
    const format = unit === 'hour' ? 'YYYY-MM-DD"T"HH24:00' : 'YYYY-MM-DD';

    const [totals, sales, income, trending] = await Promise.all([
      this.prisma.$queryRaw<Totals[]>`
        SELECT o.placed_at >= ${start} AS current, COUNT(*) AS orders, SUM(o.subtotal_piastres - o.discount_piastres) AS revenue,
               COUNT(*) FILTER (WHERE o.type = 'DINE_IN') AS dine_in, COUNT(*) FILTER (WHERE o.type = 'PICKUP') AS pickup
        FROM orders o
        WHERE ${counted} AND ((o.placed_at >= ${start} AND o.placed_at <= ${now}) OR (o.placed_at >= ${previousStart} AND o.placed_at < ${previousEnd}))
        GROUP BY 1`,
      this.prisma.$queryRaw<{ at: string; orders: bigint; revenue: bigint | null }[]>`
        SELECT to_char(b.at, ${format}) AS at, COUNT(o.id) AS orders, SUM(o.subtotal_piastres - o.discount_piastres) AS revenue
        FROM generate_series(date_trunc(${unit}, ${start}::timestamptz AT TIME ZONE ${tz}), date_trunc(${unit}, ${now}::timestamptz AT TIME ZONE ${tz}), ${step}) AS b(at)
        LEFT JOIN orders o ON ${counted} AND o.placed_at >= ${start} AND o.placed_at <= ${now}
          AND date_trunc(${unit}, o.placed_at AT TIME ZONE ${tz}) = b.at
        GROUP BY b.at ORDER BY b.at`,
      this.prisma.$queryRaw<{ id: string | null; name_ar: string | null; name_en: string | null; revenue: bigint }[]>`
        SELECT c.id, c.name_ar, c.name_en, SUM(i.unit_price_piastres::bigint * i.quantity) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id
        LEFT JOIN menu_items m ON m.id = i.menu_item_id LEFT JOIN categories c ON c.id = m.category_id
        WHERE ${counted} AND o.placed_at >= ${start} AND o.placed_at <= ${now} AND i.prep_status <> 'CANCELLED'
        GROUP BY c.id, c.name_ar, c.name_en
        ORDER BY revenue DESC`,
      this.prisma.$queryRaw<{ menu_item_id: string | null; name_ar: string; name_en: string | null; quantity: bigint; revenue: bigint }[]>`
        SELECT i.menu_item_id, MIN(i.name_ar) AS name_ar, MIN(i.name_en) AS name_en, SUM(i.quantity) AS quantity, SUM(i.unit_price_piastres::bigint * i.quantity) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE ${counted} AND o.placed_at >= ${start} AND o.placed_at <= ${now} AND i.prep_status <> 'CANCELLED'
        GROUP BY i.menu_item_id, CASE WHEN i.menu_item_id IS NULL THEN i.name_ar END
        ORDER BY quantity DESC, revenue DESC
        LIMIT 4`,
    ]);
    const soldOut = await this.soldOut(restaurant.id, branchId);
    const images = await this.images([...trending.map((row) => row.menu_item_id), ...soldOut.items.map((row) => row.id)]);

    const figure = (pick: (row: Totals) => number) => ({
      value: totals.filter((row) => row.current).reduce((sum, row) => sum + pick(row), 0),
      previous: totals.filter((row) => !row.current).reduce((sum, row) => sum + pick(row), 0),
    });
    const revenue = figure((row) => Number(row.revenue ?? 0));
    const categories = income.map((row) => ({ id: row.id, nameAr: row.name_ar ?? 'غير مصنف', nameEn: row.name_en ?? (row.id ? null : 'Uncategorised'), revenuePiastres: money(Number(row.revenue)) }));
    return {
      period,
      financial,
      branchId: branchId ?? null,
      kpis: {
        revenuePiastres: { value: money(revenue.value), previous: money(revenue.previous) },
        orders: figure((row) => Number(row.orders)),
        dineIn: figure((row) => Number(row.dine_in)),
        pickup: figure((row) => Number(row.pickup)),
      },
      bucket: unit,
      sales: sales.map((row) => ({ at: row.at, orders: Number(row.orders), revenuePiastres: money(Number(row.revenue ?? 0)) })),
      income: { totalPiastres: categories.reduce((sum, row) => sum + row.revenuePiastres, 0), categories },
      trending: trending.map((row) => ({
        menuItemId: row.menu_item_id, nameAr: row.name_ar, nameEn: row.name_en, image: images.get(row.menu_item_id ?? '') ?? null,
        quantity: Number(row.quantity), revenuePiastres: money(Number(row.revenue)),
      })),
      soldOut: soldOut.items.map((row) => ({ menuItemId: row.id, nameAr: row.nameAr, nameEn: row.nameEn, image: images.get(row.id) ?? null, branchName: row.branchName, byInventory: row.byInventory })),
      soldOutTotal: soldOut.total,
    };
  }

  /** Dishes sold out now: on the shared menu, or at a branch (only the requested branch's when one is). */
  private async soldOut(restaurantId: string, branchId: string | undefined) {
    const [everywhere, atBranches] = await Promise.all([
      this.prisma.menuItem.findMany({ where: { restaurantId, isAvailable: false, isVisible: true }, select: { id: true, nameAr: true, nameEn: true }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.branchMenuItem.findMany({
        where: { isAvailable: false, isHidden: false, item: { restaurantId, isAvailable: true, isVisible: true }, branch: { isActive: true, ...(branchId && { id: branchId }) } },
        select: { soldOutByInventory: true, branch: { select: { name: true } }, item: { select: { id: true, nameAr: true, nameEn: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    const items = [
      ...everywhere.map((item) => ({ ...item, branchName: null as string | null, byInventory: false })),
      ...atBranches.map((row) => ({ ...row.item, branchName: row.branch.name, byInventory: row.soldOutByInventory })),
    ];
    return { items: items.slice(0, SOLD_OUT_SHOWN), total: items.length };
  }

  private async images(ids: (string | null)[]): Promise<Map<string, OverviewDish['image']>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.menuItem.findMany({ where: { id: { in: wanted } }, select: { id: true, image: true } });
    return new Map(rows.map((row) => [row.id, row.image ? this.media.toImageSet(row.image) : null]));
  }
}
