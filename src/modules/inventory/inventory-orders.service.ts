import { Injectable, Logger } from '@nestjs/common';
import type { InventoryStockPolicy, OrderStatus } from '@bilhanah/contracts';
import type { RestaurantStatus } from '@bilhanah/database';
import { InventoryAccess, type Tx } from './inventory-access.service.js';
import { InventoryEngine, type Posting } from './inventory-engine.service.js';
import { type Decimal, dec, explode, RecipeCycleError, RecipeDepthError, wholePiastres, ZERO } from './inventory-math.js';

/** The order's forward path; deduction happens on reaching the settings' deductOn step or any later one. */
const PATH: readonly OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'];

export type StockCheck = { policy: InventoryStockPolicy; short: string[] };

/**
 * Automatic deduction from orders, inside the order's own transaction. When an order reaches the
 * settings' deductOn status (accepted, ready or completed; or jumps past it), a SALE is posted per
 * line and ingredient (its size's recipe × quantity, prepared ingredients exploded, cancelled
 * dishes skipped) and each line's cost is stored; orders.stock_deducted_at makes it happen once
 * whatever the path. Cancelling (the order, or one dish on the kitchen display) posts SALE_REVERSAL
 * for what was deducted and not yet reversed: before the deduction point there is nothing to
 * reverse. Source keys make retries no-ops.
 *
 * It never blocks or fails an order: without inventory (setting off, or a plan without it) nothing
 * happens, a line without a recipe deducts nothing, and any error is rolled back to a savepoint and
 * logged while the order's change commits.
 */
@Injectable()
export class InventoryOrdersService {
  private readonly logger = new Logger(InventoryOrdersService.name);

  constructor(
    private readonly engine: InventoryEngine,
    private readonly access: InventoryAccess,
  ) {}

  /** The order reached `status` (accepting, preparing, ready, completed): deduct if that is at or past deductOn. */
  async orderReached(tx: Tx, orderId: string, status: OrderStatus): Promise<void> {
    if (!PATH.includes(status)) return;
    await this.safely(tx, 'deduct', orderId, () => this.deduct(tx, orderId, status));
  }

  /**
   * At placement: which dishes the branch's stock cannot cover (the order's recipes summed, against
   * what is on hand now), and the branch's policy. Nothing is short without inventory, under
   * ALLOW_NEGATIVE, or for dishes without a recipe. A check, not a reservation.
   */
  async checkStock(restaurant: { id: string; status: RestaurantStatus }, branchId: string, lines: readonly { menuItemId: string; variantId: string; quantity: number }[]): Promise<StockCheck> {
    const settings = await this.engine.settings(restaurant.id);
    if (!settings.enabled) return { policy: 'ALLOW_NEGATIVE', short: [] };
    const policy = (await this.engine.branchRules(settings, [branchId])).get(branchId)!.stockPolicy;
    if (policy === 'ALLOW_NEGATIVE' || !(await this.access.planIncludes(restaurant))) return { policy: 'ALLOW_NEGATIVE', short: [] };
    const recipes = await this.engine.variantRecipes(lines.map((line) => line.variantId));
    if (!recipes.size) return { policy, short: [] };
    const { graph } = await this.engine.recipes(restaurant.id);
    const perLine: { menuItemId: string; usage: Map<string, Decimal> }[] = [];
    const total = new Map<string, Decimal>();
    for (const line of lines) {
      const recipe = recipes.get(line.variantId);
      if (!recipe?.length) continue;
      try {
        const usage = explode(recipe, dec(line.quantity), graph).usage;
        perLine.push({ menuItemId: line.menuItemId, usage });
        for (const [id, amount] of usage) total.set(id, (total.get(id) ?? ZERO).plus(amount));
      } catch (error) {
        if (error instanceof RecipeCycleError || error instanceof RecipeDepthError) continue;
        throw error;
      }
    }
    if (!total.size) return { policy, short: [] };
    const stock = await this.engine.onHand(branchId, [...total.keys()]);
    const shortIngredients = new Set([...total].filter(([id, amount]) => amount.gt(stock.get(id) ?? ZERO)).map(([id]) => id));
    const short = [...new Set(perLine.filter((line) => [...line.usage.keys()].some((id) => shortIngredients.has(id))).map((line) => line.menuItemId))];
    return { policy, short };
  }

  /** The order was cancelled after acceptance: reverse every line not yet reversed. */
  async orderCancelled(tx: Tx, orderId: string): Promise<void> {
    await this.safely(tx, 'reverse', orderId, () => this.reverse(tx, orderId, null));
  }

  /** Dishes were cancelled on the kitchen display: reverse those lines. */
  async itemsCancelled(tx: Tx, orderId: string, itemIds: readonly string[]): Promise<void> {
    if (!itemIds.length) return;
    await this.safely(tx, 'reverse', orderId, () => this.reverse(tx, orderId, itemIds));
  }

  private async deduct(tx: Tx, orderId: string, status: OrderStatus): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        restaurantId: true, branchId: true, stockDeductedAt: true, restaurant: { select: { id: true, status: true } },
        items: { select: { id: true, variantId: true, quantity: true, prepStatus: true } },
      },
    });
    if (!order || order.stockDeductedAt) return;
    const settings = await this.engine.settings(order.restaurantId, tx);
    if (!settings.enabled || PATH.indexOf(status) < PATH.indexOf(settings.deductOn)) return;
    if (!(await this.access.planIncludes(order.restaurant))) return;
    // Once per order, whichever path it takes (READY reached straight from ACCEPTED, COMPLETED by cascade…).
    const { count } = await tx.order.updateMany({ where: { id: orderId, stockDeductedAt: null }, data: { stockDeductedAt: new Date() } });
    if (!count) return;
    const items = order.items.filter((item) => item.prepStatus !== 'CANCELLED' && item.variantId);
    const recipes = await this.engine.variantRecipes(items.map((item) => item.variantId!), tx);
    if (!recipes.size) return;
    const { graph } = await this.engine.recipes(order.restaurantId, tx);

    const postings: Posting[] = [];
    for (const item of items) {
      const lines = recipes.get(item.variantId!);
      if (!lines?.length) continue;
      let usage: Map<string, ReturnType<typeof dec>>;
      try {
        usage = explode(lines, dec(item.quantity), graph).usage;
      } catch (error) {
        // A broken recipe (saved before a change made it cyclic) deducts nothing rather than failing the order.
        if (error instanceof RecipeCycleError || error instanceof RecipeDepthError) continue;
        throw error;
      }
      for (const [ingredientId, quantity] of usage) {
        postings.push({ branchId: order.branchId, ingredientId, type: 'SALE', quantity: quantity.neg(), sourceKey: `sale:${item.id}:${ingredientId}`, orderId, orderItemId: item.id });
      }
    }
    const posted = await this.engine.post(tx, order.restaurantId, postings, null);
    const costs = new Map<string, ReturnType<typeof dec>>();
    for (const movement of posted) costs.set(movement.orderItemId!, (costs.get(movement.orderItemId!) ?? ZERO).minus(movement.value));
    for (const [itemId, cost] of costs) await tx.orderItem.update({ where: { id: itemId }, data: { costPiastres: wholePiastres(cost) } });
  }

  /**
   * Reverses SALE movements of the order (or of some lines) at the cost they left with. Not gated by
   * the settings or plan: it only undoes what was deducted.
   */
  private async reverse(tx: Tx, orderId: string, itemIds: readonly string[] | null): Promise<void> {
    const sales = await tx.stockMovement.findMany({
      where: { orderId, type: 'SALE', ...(itemIds && { orderItemId: { in: [...itemIds] } }) },
      select: { restaurantId: true, branchId: true, ingredientId: true, orderItemId: true, quantity: true, unitCost: true },
    });
    if (!sales.length) return;
    const postings: Posting[] = sales.map((sale) => ({
      branchId: sale.branchId, ingredientId: sale.ingredientId, type: 'SALE_REVERSAL', quantity: sale.quantity.neg(), unitCost: sale.unitCost,
      sourceKey: `sale-reversal:${sale.orderItemId}:${sale.ingredientId}`, orderId, orderItemId: sale.orderItemId ?? undefined,
    }));
    await this.engine.post(tx, sales[0]!.restaurantId, postings, null);
  }

  /** Runs inventory work in a savepoint: a failure is rolled back and logged, the order goes on. */
  private async safely(tx: Tx, action: string, orderId: string, work: () => Promise<void>): Promise<void> {
    await tx.$executeRawUnsafe('SAVEPOINT inventory_posting');
    try {
      await work();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT inventory_posting');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT inventory_posting');
      this.logger.error({ err: error, orderId, action }, 'Inventory posting for an order failed; the order change went ahead without it');
    }
  }
}
