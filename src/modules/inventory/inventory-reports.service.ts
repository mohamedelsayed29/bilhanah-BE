import { Injectable } from '@nestjs/common';
import {
  BASE_UNITS,
  COMMON_ERROR_CODES,
  type FoodCostReport,
  type LowStockReport,
  type lowStockQuerySchema,
  type FoodCostRow,
  type foodCostQuerySchema,
  INVENTORY_LIMITS,
  type menuEngineeringQuerySchema,
  type MenuEngineeringReport,
  type ReorderLine,
  type ReorderReport,
  type StockMovementType,
  type ValuationReport,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { fail, InventoryAccess, localDayRange } from './inventory-access.service.js';
import { InventoryCatalogService } from './inventory-catalog.service.js';
import { InventoryEngine } from './inventory-engine.service.js';
import { classifyMenu, type Decimal, foodCostFigures, type MovementTotals, num, reorderSuggestion, roundValue, ZERO } from './inventory-math.js';

/**
 * Valuation, reorder suggestions, food cost (theoretical vs actual) and menu engineering. Costs
 * need inventory.costs; the reorder list needs inventory.view (with estimated costs when allowed).
 */
@Injectable()
export class InventoryReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InventoryAccess,
    private readonly engine: InventoryEngine,
    private readonly catalog: InventoryCatalogService,
  ) {}

  /**
   * Stock value by category at a branch: on hand × the settings' basis (average, else standard
   * cost; or standard, else average); negative stock is counted, not valued.
   */
  async valuation(userId: string, branchId?: string): Promise<ValuationReport> {
    const scope = await this.access.scope(userId, 'inventory.costs');
    const branch = await this.access.branches.branch(scope, branchId);
    const basis = (await this.engine.settings(scope.restaurant.id)).valuationBasis;
    const rows = await this.prisma.inventoryStock.findMany({
      where: { branchId: branch.id, ingredient: { kind: 'RAW' } },
      include: { ingredient: { select: { category: true, standardCost: true } } },
    });
    const byCategory = new Map<string | null, { items: number; value: Decimal }>();
    let total = ZERO;
    let negativeItems = 0;
    for (const row of rows) {
      if (row.onHand.lt(0)) negativeItems++;
      if (row.onHand.lte(0)) continue;
      const cost = basis === 'STANDARD' ? (row.ingredient.standardCost ?? row.avgCost) : (row.avgCost ?? row.ingredient.standardCost);
      const value = roundValue(row.onHand.mul(cost ?? ZERO));
      const group = byCategory.get(row.ingredient.category) ?? { items: 0, value: ZERO };
      group.items++;
      group.value = group.value.plus(value);
      byCategory.set(row.ingredient.category, group);
      total = total.plus(value);
    }
    return {
      branchId: branch.id,
      branchName: branch.name,
      total: num(roundValue(total)),
      byCategory: [...byCategory].map(([category, group]) => ({ category, items: group.items, value: num(roundValue(group.value)) })).sort((a, b) => b.value - a.value),
      negativeItems,
    };
  }

  /**
   * Ingredients at or below their reorder point (the branch's, else the ingredient's default), with
   * how much to order, grouped by preferred supplier.
   */
  async reorder(userId: string, branchId?: string): Promise<ReorderReport> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const branch = await this.access.branches.branch(scope, branchId);
    const basis = (await this.engine.settings(scope.restaurant.id)).valuationBasis;
    const ingredients = await this.prisma.ingredient.findMany({
      where: { restaurantId: scope.restaurant.id, kind: 'RAW', isActive: true },
      select: {
        id: true, nameAr: true, nameEn: true, dimension: true, standardCost: true, defaultReorderPoint: true,
        preferredSupplier: { select: { id: true, name: true, phone: true } },
        units: { orderBy: { sortOrder: 'asc' }, take: 1, select: { id: true, nameAr: true, nameEn: true, factor: true } },
        stock: { where: { branchId: branch.id }, select: { onHand: true, avgCost: true, reorderPoint: true, parLevel: true } },
      },
      orderBy: { nameAr: 'asc' },
    });
    const groups = new Map<string | null, ReorderReport['groups'][number]>();
    for (const ingredient of ingredients) {
      const row = ingredient.stock[0];
      const onHand = row?.onHand ?? ZERO;
      const reorderPoint = row?.reorderPoint ?? ingredient.defaultReorderPoint ?? null;
      const parLevel = row?.parLevel ?? null;
      const unit = ingredient.units[0] ?? null;
      const suggestion = reorderSuggestion(onHand, reorderPoint, parLevel, unit?.factor ?? null);
      if (!suggestion) continue;
      const cost = basis === 'STANDARD' ? (ingredient.standardCost ?? row?.avgCost ?? null) : (row?.avgCost ?? ingredient.standardCost ?? null);
      const estimated = scope.costs && cost ? roundValue(suggestion.quantity.mul(cost)) : null;
      const line: ReorderLine = {
        ingredientId: ingredient.id, nameAr: ingredient.nameAr, nameEn: ingredient.nameEn, baseUnit: BASE_UNITS[ingredient.dimension].code,
        onHand: num(onHand), reorderPoint: num(reorderPoint!), parLevel: parLevel === null ? null : num(parLevel),
        suggestedQuantity: num(suggestion.quantity),
        suggestedUnits: unit && suggestion.units ? { unitId: unit.id, unitNameAr: unit.nameAr, unitNameEn: unit.nameEn, quantity: num(suggestion.units) } : null,
        estimatedCost: estimated === null ? null : num(estimated),
      };
      const supplier = ingredient.preferredSupplier;
      const group = groups.get(supplier?.id ?? null) ?? { supplier, lines: [], estimatedCost: scope.costs ? 0 : null };
      group.lines.push(line);
      if (group.estimatedCost !== null) group.estimatedCost = Math.round((group.estimatedCost + (line.estimatedCost ?? 0)) * 100) / 100;
      groups.set(supplier?.id ?? null, group);
    }
    // Suppliers by name, the lines without one last.
    const sorted = [...groups.values()].sort((a, b) => (a.supplier === null ? 1 : b.supplier === null ? -1 : a.supplier.name.localeCompare(b.supplier.name)));
    return { branchId: branch.id, branchName: branch.name, groups: sorted };
  }

  /** What is LOW or OUT at a branch, and the orders the WARN policy flagged over the last `days`. */
  async lowStock(userId: string, query: z.output<typeof lowStockQuerySchema>, now = new Date()): Promise<LowStockReport> {
    // The stock list checks the plan, the permission and the branch.
    const stock = await this.catalog.stock(userId, query.branchId);
    const orders = await this.prisma.order.findMany({
      where: { branchId: stock.branchId, lowStockItemIds: { isEmpty: false }, placedAt: { gte: new Date(now.getTime() - query.days * 86_400_000) } },
      orderBy: { placedAt: 'desc' },
      take: 100,
      select: { id: true, number: true, status: true, placedAt: true, lowStockItemIds: true, items: { select: { menuItemId: true, nameAr: true, nameEn: true } } },
    });
    return {
      branchId: stock.branchId,
      branchName: stock.branchName,
      rows: stock.rows.filter((row) => row.status !== 'OK' && row.isActive),
      warnedOrders: orders.map((order) => ({
        orderId: order.id, number: order.number, status: order.status, placedAt: order.placedAt.toISOString(),
        items: order.lowStockItemIds.map((menuItemId) => {
          const item = order.items.find((line) => line.menuItemId === menuItemId);
          return { menuItemId, nameAr: item?.nameAr ?? '', nameEn: item?.nameEn ?? null };
        }),
      })),
    };
  }

  /** Revenue, theoretical cost, waste, count variance and purchases over restaurant business days. */
  async foodCost(userId: string, query: z.output<typeof foodCostQuerySchema>): Promise<FoodCostReport> {
    const scope = await this.access.scope(userId, 'inventory.costs');
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
    if (days < 0 || days >= INVENTORY_LIMITS.reportDays) throw fail('bad', COMMON_ERROR_CODES.VALIDATION_FAILED, `Choose a range of 1 to ${INVENTORY_LIMITS.reportDays} days.`);
    const where = await this.access.branches.branchWhere(scope, query.branchId);
    const branches = where.branchId
      ? await this.prisma.branch.findMany({ where: { id: where.branchId } })
      : await this.access.branches.visibleBranches(scope);
    const [revenue, movements] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['branchId'],
        where: { ...where, status: { notIn: ['REJECTED', 'CANCELLED'] }, businessDay: { gte: new Date(`${query.from}T00:00:00Z`), lte: new Date(`${query.to}T00:00:00Z`) } },
        _sum: { subtotalPiastres: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['branchId', 'type'],
        where: { ...where, createdAt: localDayRange(scope.restaurant.timezone, query.from, query.to) },
        _sum: { value: true },
      }),
    ]);
    const row = (branchIds: string[] | null, branch: { id: string; name: string } | null): FoodCostRow => {
      const includes = (id: string) => branchIds === null || branchIds.includes(id);
      const totals: MovementTotals = {};
      for (const group of movements) {
        if (!includes(group.branchId)) continue;
        const type = group.type as StockMovementType;
        totals[type] = (totals[type] ?? ZERO).plus(group._sum.value ?? ZERO);
      }
      const sales = revenue.filter((group) => includes(group.branchId)).reduce((sum, group) => sum + (group._sum.subtotalPiastres ?? 0), 0);
      return { branchId: branch?.id ?? null, branchName: branch?.name ?? null, ...foodCostFigures(sales, totals) };
    };
    return {
      from: query.from,
      to: query.to,
      total: row(where.branchId ? [where.branchId] : null, where.branchId && branches[0] ? branches[0] : null),
      byBranch: branches.map((branch) => row([branch.id], branch)),
    };
  }

  /** Per dish over the last `days`: sold, revenue, cost (order_items.cost_piastres), margin and class. */
  async menuEngineering(userId: string, query: z.output<typeof menuEngineeringQuerySchema>, now = new Date()): Promise<MenuEngineeringReport> {
    const scope = await this.access.scope(userId, 'inventory.costs');
    const where = await this.access.branches.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 86_400_000);
    const branchSql = where.branchId ? Prisma.sql`AND o.branch_id = ${where.branchId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{
      item_id: string; name_ar: string; name_en: string | null; sold: bigint; revenue: bigint; costed_sold: bigint | null; costed_revenue: bigint | null; cost: bigint | null;
    }[]>`
      SELECT oi.menu_item_id::text AS item_id, MAX(oi.name_ar) AS name_ar, MAX(oi.name_en) AS name_en,
        SUM(oi.quantity) AS sold, SUM(oi.quantity * oi.unit_price_piastres) AS revenue,
        SUM(oi.quantity) FILTER (WHERE oi.cost_piastres IS NOT NULL) AS costed_sold,
        SUM(oi.quantity * oi.unit_price_piastres) FILTER (WHERE oi.cost_piastres IS NOT NULL) AS costed_revenue,
        SUM(oi.cost_piastres) AS cost
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.restaurant_id = ${where.restaurantId}::uuid ${branchSql} AND o.placed_at >= ${since}
        AND o.status NOT IN ('REJECTED', 'CANCELLED') AND oi.prep_status <> 'CANCELLED' AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id`;
    const dishes = rows.map((row) => ({
      itemId: row.item_id, sold: Number(row.sold), revenue: Number(row.revenue),
      costedSold: Number(row.costed_sold ?? 0), costedRevenue: Number(row.costed_revenue ?? 0), cost: Number(row.cost ?? 0),
    }));
    // Current names where the dish still exists.
    const names = new Map((await this.prisma.menuItem.findMany({ where: { id: { in: dishes.map((dish) => dish.itemId) } }, select: { id: true, nameAr: true, nameEn: true } })).map((item) => [item.id, item]));
    const classified = classifyMenu(dishes);
    const result = classified.rows.map((row, index) => {
      const dish = dishes[index]!;
      const source = rows[index]!;
      return {
        itemId: dish.itemId, nameAr: names.get(dish.itemId)?.nameAr ?? source.name_ar, nameEn: names.get(dish.itemId)?.nameEn ?? source.name_en,
        sold: dish.sold, revenue: dish.revenue, cost: dish.costedSold ? dish.cost : null,
        unitMargin: row.unitMargin, totalMargin: row.totalMargin, share: row.share, foodCostPercent: row.foodCostPercent, class: row.class,
      };
    });
    // Most profitable first; dishes without a recipe cost last, by units sold.
    const margin = (row: { totalMargin: number | null }) => row.totalMargin ?? Number.NEGATIVE_INFINITY;
    result.sort((a, b) => (margin(a) === margin(b) ? b.sold - a.sold : margin(b) > margin(a) ? 1 : -1));
    return { days: query.days, branchId: where.branchId ?? null, popularityThreshold: classified.popularityThreshold, averageMargin: classified.averageMargin, rows: result };
  }
}
