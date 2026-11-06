import { Injectable } from '@nestjs/common';
import {
  DEFAULT_INVENTORY_SETTINGS,
  type IngredientKind,
  type InventoryDeductOn,
  type InventoryDimension,
  type InventoryStockPolicy,
  type InventoryValuationBasis,
  type StockMovementType,
  type WasteReasonOption,
} from '@bilhanah/contracts';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Tx } from './inventory-access.service.js';
import {
  applyMovement,
  type Decimal,
  dec,
  explode,
  type RecipeGraph,
  type RecipeLineInput,
  RecipeCycleError,
  RecipeDepthError,
  type StockState,
  ZERO,
} from './inventory-math.js';

/** One stock change to post. Quantity is signed (positive adds) and in base units. */
export type Posting = {
  branchId: string;
  ingredientId: string;
  type: StockMovementType;
  quantity: Decimal;
  /** The known cost of an inflow, return or unwind (piastres per base unit); outflows use the average. */
  unitCost?: Decimal | null;
  /** Unique: a posting whose key exists already is skipped (retries and races post once). */
  sourceKey: string;
  purchaseId?: string;
  orderId?: string;
  orderItemId?: string;
  wasteId?: string;
  countId?: string;
  transferId?: string;
  note?: string | null;
};

export type Posted = Posting & { unitCost: Decimal; value: Decimal; onHandAfter: Decimal; avgCostAfter: Decimal | null };

export type IngredientInfo = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  category: string | null;
  kind: IngredientKind;
  dimension: InventoryDimension;
  standardCost: Decimal | null;
  yieldQuantity: Decimal | null;
  isActive: boolean;
};

export type RestaurantRecipes = { graph: RecipeGraph; ingredients: Map<string, IngredientInfo> };

/** The restaurant's inventory rules, defaults filled in. */
export type InventorySettingsRow = {
  enabled: boolean;
  deductOn: InventoryDeductOn;
  stockPolicy: InventoryStockPolicy;
  autoSoldOut: boolean;
  autoRestore: boolean;
  valuationBasis: InventoryValuationBasis;
  wasteReasons: WasteReasonOption[];
  requireCountApproval: boolean;
  countVarianceThresholdPercent: Decimal;
  updatedAt: Date | null;
};

/** What applies at one branch (its overrides over the restaurant's rules). */
export type BranchRules = { stockPolicy: InventoryStockPolicy; autoSoldOut: boolean; autoRestore: boolean };

const key = (branchId: string, ingredientId: string) => `${branchId}:${ingredientId}`;

/**
 * The stock ledger. Every posting locks the stock rows it touches (SELECT … FOR UPDATE, in branch
 * and ingredient id order so concurrent postings never deadlock), skips movements whose source key
 * exists, applies the weighted average, writes the rows and the movements, and then lets auto
 * sold-out react, all inside the caller's transaction.
 */
@Injectable()
export class InventoryEngine {
  constructor(private readonly prisma: PrismaService) {}

  async settings(restaurantId: string, tx: Tx = this.prisma): Promise<InventorySettingsRow> {
    const row = await tx.inventorySettings.findUnique({ where: { restaurantId } });
    const defaults = DEFAULT_INVENTORY_SETTINGS;
    if (!row) return { ...defaults, wasteReasons: [...defaults.wasteReasons], countVarianceThresholdPercent: dec(defaults.countVarianceThresholdPercent), updatedAt: null };
    return {
      enabled: row.enabled,
      deductOn: row.deductOn,
      stockPolicy: row.stockPolicy,
      autoSoldOut: row.autoSoldOut,
      autoRestore: row.autoRestore,
      valuationBasis: row.valuationBasis,
      wasteReasons: Array.isArray(row.wasteReasons) ? (row.wasteReasons as WasteReasonOption[]) : [...defaults.wasteReasons],
      requireCountApproval: row.requireCountApproval,
      countVarianceThresholdPercent: row.countVarianceThresholdPercent,
      updatedAt: row.updatedAt,
    };
  }

  /** The rules at each of these branches: the branch's own where set, else the restaurant's. */
  async branchRules(settings: InventorySettingsRow, branchIds: readonly string[], tx: Tx = this.prisma): Promise<Map<string, BranchRules>> {
    const own = branchIds.length ? await tx.inventoryBranchSettings.findMany({ where: { branchId: { in: [...branchIds] } } }) : [];
    return new Map(branchIds.map((branchId) => {
      const row = own.find((candidate) => candidate.branchId === branchId);
      return [branchId, {
        stockPolicy: row?.stockPolicy ?? settings.stockPolicy,
        autoSoldOut: row?.autoSoldOut ?? settings.autoSoldOut,
        autoRestore: row?.autoRestore ?? settings.autoRestore,
      }];
    }));
  }

  /** Every ingredient of the restaurant and the recipes of the prepared ones. */
  async recipes(restaurantId: string, tx: Tx = this.prisma): Promise<RestaurantRecipes> {
    // One after the other: inside a transaction both would share its connection.
    const rows = await tx.ingredient.findMany({
      where: { restaurantId },
      select: { id: true, nameAr: true, nameEn: true, category: true, kind: true, dimension: true, standardCost: true, yieldQuantity: true, isActive: true },
    });
    const lines = await tx.recipeLine.findMany({
      where: { preparedIngredient: { restaurantId } },
      select: { preparedIngredientId: true, ingredientId: true, quantity: true, wastePercent: true },
      orderBy: { sortOrder: 'asc' },
    });
    const ingredients = new Map(rows.map((row) => [row.id, row]));
    const byOwner = new Map<string, RecipeLineInput[]>();
    for (const line of lines) {
      const list = byOwner.get(line.preparedIngredientId!) ?? [];
      list.push({ ingredientId: line.ingredientId, quantity: line.quantity, wastePercent: line.wastePercent });
      byOwner.set(line.preparedIngredientId!, list);
    }
    const graph = new Map(rows.map((row) => [row.id, { kind: row.kind, yieldQuantity: row.yieldQuantity, lines: byOwner.get(row.id) ?? [] }]));
    return { graph, ingredients };
  }

  /** The recipe lines of dish sizes, by variant id (sizes without a recipe are missing). */
  async variantRecipes(variantIds: readonly string[], tx: Tx = this.prisma): Promise<Map<string, RecipeLineInput[]>> {
    if (!variantIds.length) return new Map();
    const lines = await tx.recipeLine.findMany({
      where: { variantId: { in: [...new Set(variantIds)] } },
      select: { variantId: true, ingredientId: true, quantity: true, wastePercent: true },
      orderBy: { sortOrder: 'asc' },
    });
    const map = new Map<string, RecipeLineInput[]>();
    for (const line of lines) {
      const list = map.get(line.variantId!) ?? [];
      list.push({ ingredientId: line.ingredientId, quantity: line.quantity, wastePercent: line.wastePercent });
      map.set(line.variantId!, list);
    }
    return map;
  }

  /**
   * Unit cost per ingredient at a branch for costing and reports: the average (else the standard
   * cost), or with the STANDARD basis the standard cost (else the average); null where neither exists.
   */
  async unitCosts(branchId: string, ingredients: ReadonlyMap<string, IngredientInfo>, basis: InventoryValuationBasis = 'AVERAGE', tx: Tx = this.prisma): Promise<(ingredientId: string) => Decimal | null> {
    const rows = await tx.inventoryStock.findMany({ where: { branchId }, select: { ingredientId: true, avgCost: true } });
    const averages = new Map(rows.map((row) => [row.ingredientId, row.avgCost]));
    return (ingredientId) => {
      const average = averages.get(ingredientId) ?? null;
      const standard = ingredients.get(ingredientId)?.standardCost ?? null;
      return basis === 'STANDARD' ? (standard ?? average) : (average ?? standard);
    };
  }

  /** On hand at a branch (missing: 0). */
  async onHand(branchId: string, ingredientIds: readonly string[], tx: Tx = this.prisma): Promise<Map<string, Decimal>> {
    const rows = await tx.inventoryStock.findMany({ where: { branchId, ingredientId: { in: [...ingredientIds] } }, select: { ingredientId: true, onHand: true } });
    return new Map(rows.map((row) => [row.ingredientId, row.onHand]));
  }

  /**
   * Locks the stock rows of these (branch, ingredient) pairs until the transaction ends, creating
   * missing ones, in branch then ingredient id order. Returns their current state. Locking again
   * in the same transaction is a no-op, so a posting that touches several branches locks them all
   * first (see transfers).
   */
  async lock(tx: Tx, restaurantId: string, pairs: readonly { branchId: string; ingredientId: string }[]): Promise<Map<string, StockState>> {
    const sorted = [...new Map(pairs.map((pair) => [key(pair.branchId, pair.ingredientId), pair])).values()]
      .sort((a, b) => (a.branchId === b.branchId ? (a.ingredientId < b.ingredientId ? -1 : 1) : a.branchId < b.branchId ? -1 : 1));
    if (!sorted.length) return new Map();
    const branchIds = sorted.map((pair) => pair.branchId);
    const ingredientIds = sorted.map((pair) => pair.ingredientId);
    await tx.$executeRaw`
      INSERT INTO inventory_stock (branch_id, ingredient_id, restaurant_id, updated_at)
      SELECT t.b, t.i, ${restaurantId}::uuid, now() FROM unnest(${branchIds}::uuid[], ${ingredientIds}::uuid[]) AS t(b, i)
      ORDER BY t.b, t.i
      ON CONFLICT (branch_id, ingredient_id) DO NOTHING`;
    const rows = await tx.$queryRaw<{ branch_id: string; ingredient_id: string; on_hand: string; avg_cost: string | null }[]>`
      SELECT s.branch_id::text AS branch_id, s.ingredient_id::text AS ingredient_id, s.on_hand::text AS on_hand, s.avg_cost::text AS avg_cost
      FROM inventory_stock s
      JOIN unnest(${branchIds}::uuid[], ${ingredientIds}::uuid[]) AS t(b, i) ON s.branch_id = t.b AND s.ingredient_id = t.i
      ORDER BY s.branch_id, s.ingredient_id
      FOR UPDATE OF s`;
    return new Map(rows.map((row) => [key(row.branch_id, row.ingredient_id), { onHand: dec(row.on_hand), avgCost: row.avg_cost === null ? null : dec(row.avg_cost) }]));
  }

  /**
   * Posts movements and returns those posted (already-posted source keys are skipped). The caller
   * owns the transaction; `actorId` is recorded on each movement.
   */
  async post(tx: Tx, restaurantId: string, postings: readonly Posting[], actorId: string | null): Promise<Posted[]> {
    const unique = [...new Map(postings.filter((posting) => !posting.quantity.isZero()).map((posting) => [posting.sourceKey, posting])).values()];
    if (!unique.length) return [];
    const locked = await this.lock(tx, restaurantId, unique);
    const ingredientIds = [...new Set(unique.map((posting) => posting.ingredientId))];
    // Under the locks: anything posted meanwhile by another transaction is visible now.
    const existing = new Set(
      (await tx.stockMovement.findMany({ where: { sourceKey: { in: unique.map((posting) => posting.sourceKey) } }, select: { sourceKey: true } })).map((row) => row.sourceKey),
    );
    const todo = unique.filter((posting) => !existing.has(posting.sourceKey));
    if (!todo.length) return [];

    const standard = new Map(
      (await tx.ingredient.findMany({ where: { id: { in: ingredientIds }, restaurantId }, select: { id: true, standardCost: true } })).map((row) => [row.id, row.standardCost]),
    );
    const states = locked;
    const flows = new Map<string, { outflow: boolean; inflow: boolean }>();
    const posted: Posted[] = [];
    for (const posting of todo) {
      const id = key(posting.branchId, posting.ingredientId);
      const state = states.get(id) ?? { onHand: ZERO, avgCost: null };
      const applied = applyMovement(state, posting.type, posting.quantity, posting.unitCost ?? null, standard.get(posting.ingredientId) ?? null);
      states.set(id, applied.after);
      const flow = flows.get(id) ?? { outflow: false, inflow: false };
      if (posting.quantity.lt(0)) flow.outflow = true;
      else flow.inflow = true;
      flows.set(id, flow);
      posted.push({ ...posting, unitCost: applied.unitCost, value: applied.value, onHandAfter: applied.after.onHand, avgCostAfter: applied.after.avgCost });
    }

    for (const [id] of flows) {
      const [branchId, ingredientId] = id.split(':') as [string, string];
      const state = states.get(id)!;
      await tx.inventoryStock.update({ where: { branchId_ingredientId: { branchId, ingredientId } }, data: { onHand: state.onHand, avgCost: state.avgCost } });
    }
    await tx.stockMovement.createMany({
      data: posted.map((movement) => ({
        restaurantId, branchId: movement.branchId, ingredientId: movement.ingredientId, type: movement.type, quantity: movement.quantity,
        unitCost: movement.unitCost, value: movement.value, onHandAfter: movement.onHandAfter, avgCostAfter: movement.avgCostAfter,
        sourceKey: movement.sourceKey, purchaseId: movement.purchaseId, orderId: movement.orderId, orderItemId: movement.orderItemId,
        wasteId: movement.wasteId, countId: movement.countId, transferId: movement.transferId, note: movement.note ?? null, createdById: actorId,
      })),
    });

    // Auto sold-out acts only while inventory is on, and per branch as its rules say.
    const settings = await this.settings(restaurantId, tx);
    if (settings.enabled) {
      const rules = await this.branchRules(settings, [...new Set(posted.map((movement) => movement.branchId))], tx);
      const changes = [...flows].flatMap(([id, flow]) => {
        const [branchId, ingredientId] = id.split(':') as [string, string];
        const onHand = states.get(id)!.onHand;
        const branch = rules.get(branchId)!;
        if (flow.outflow && onHand.lte(0) && branch.autoSoldOut) return [{ branchId, ingredientId, depleted: true }];
        if (flow.inflow && onHand.gt(0) && branch.autoRestore) return [{ branchId, ingredientId, depleted: false }];
        return [];
      });
      await this.syncSoldOut(tx, restaurantId, changes);
    }
    return posted;
  }

  // --- Auto sold-out -----------------------------------------------------------------------------------

  /**
   * After an outflow leaves an ingredient at ≤ 0 at a branch, every dish whose every size needs it
   * is marked sold out there (unless the branch has its own availability mark). After an inflow,
   * dishes inventory marked are cleared once no ingredient that every size needs is at ≤ 0.
   * Manual marks are never touched. Bumps menuVersion when anything changed.
   */
  async syncSoldOut(tx: Tx, restaurantId: string, changes: readonly { branchId: string; ingredientId: string; depleted: boolean }[]): Promise<number> {
    if (!changes.length) return 0;
    const branches = [...new Set(changes.map((change) => change.branchId))];
    const flagged = await tx.branchMenuItem.findMany({ where: { branchId: { in: branches }, soldOutByInventory: true }, select: { branchId: true, itemId: true } });
    if (!changes.some((change) => change.depleted) && !flagged.length) return 0;

    const required = await this.requiredIngredients(tx, restaurantId);
    let changed = 0;
    for (const branchId of branches) {
      const depleted = new Set(changes.filter((change) => change.branchId === branchId && change.depleted).map((change) => change.ingredientId));
      const restocked = new Set(changes.filter((change) => change.branchId === branchId && !change.depleted).map((change) => change.ingredientId));
      const toMark = [...required].filter(([, needs]) => [...needs].some((id) => depleted.has(id))).map(([itemId]) => itemId);
      const candidates = flagged
        .filter((row) => row.branchId === branchId)
        .map((row) => row.itemId)
        .filter((itemId) => !toMark.includes(itemId) && (!required.has(itemId) || [...required.get(itemId)!].some((id) => restocked.has(id))));
      const needed = [...new Set(candidates.flatMap((itemId) => [...(required.get(itemId) ?? [])]))];
      const onHand = new Map(
        (needed.length ? await tx.inventoryStock.findMany({ where: { branchId, ingredientId: { in: needed } }, select: { ingredientId: true, onHand: true } }) : [])
          .map((row) => [row.ingredientId, row.onHand]),
      );
      const blocked = (itemId: string) => [...(required.get(itemId) ?? [])].some((id) => (onHand.get(id) ?? ZERO).lte(0));
      const toClear = candidates.filter((itemId) => !blocked(itemId));

      if (toMark.length) {
        const marked = await tx.$queryRaw<{ item_id: string }[]>`
          INSERT INTO branch_menu_items (branch_id, item_id, is_available, is_hidden, sold_out_by_inventory, updated_at)
          SELECT ${branchId}::uuid, t.item, false, false, true, now() FROM unnest(${toMark}::uuid[]) AS t(item)
          ON CONFLICT (branch_id, item_id) DO UPDATE SET is_available = false, sold_out_by_inventory = true, updated_at = now()
            WHERE branch_menu_items.is_available IS NULL
          RETURNING item_id::text`;
        changed += marked.length;
      }
      if (toClear.length) {
        changed += await tx.$executeRaw`
          UPDATE branch_menu_items SET is_available = NULL, sold_out_by_inventory = false, updated_at = now()
          WHERE branch_id = ${branchId}::uuid AND item_id = ANY(${toClear}::uuid[]) AND sold_out_by_inventory`;
        await tx.$executeRaw`
          DELETE FROM branch_menu_items
          WHERE branch_id = ${branchId}::uuid AND item_id = ANY(${toClear}::uuid[]) AND is_available IS NULL AND NOT is_hidden AND NOT sold_out_by_inventory`;
      }
    }
    if (changed) await tx.restaurant.update({ where: { id: restaurantId }, data: { menuVersion: { increment: 1 } } });
    return changed;
  }

  /** Auto sold-out switched off at these branches (or inventory off): the marks it set there are cleared. */
  async clearSoldOut(tx: Tx, restaurantId: string, branchIds: readonly string[]): Promise<number> {
    if (!branchIds.length) return 0;
    const ids = [...branchIds];
    const cleared = await tx.$executeRaw`
      UPDATE branch_menu_items m SET is_available = NULL, sold_out_by_inventory = false, updated_at = now()
      FROM branches b WHERE b.id = m.branch_id AND b.restaurant_id = ${restaurantId}::uuid AND m.branch_id = ANY(${ids}::uuid[]) AND m.sold_out_by_inventory`;
    if (!cleared) return 0;
    await tx.$executeRaw`
      DELETE FROM branch_menu_items m USING branches b
      WHERE b.id = m.branch_id AND b.restaurant_id = ${restaurantId}::uuid AND m.branch_id = ANY(${ids}::uuid[])
        AND m.is_available IS NULL AND NOT m.is_hidden AND NOT m.sold_out_by_inventory`;
    await tx.restaurant.update({ where: { id: restaurantId }, data: { menuVersion: { increment: 1 } } });
    return cleared;
  }

  /** Per dish, the raw ingredients every one of its sizes needs (dishes with a size without a recipe are left out). */
  private async requiredIngredients(tx: Tx, restaurantId: string): Promise<Map<string, Set<string>>> {
    const { graph } = await this.recipes(restaurantId, tx);
    const items = await tx.menuItem.findMany({
      where: { restaurantId },
      select: { id: true, variants: { select: { recipeLines: { select: { ingredientId: true, quantity: true, wastePercent: true }, orderBy: { sortOrder: 'asc' } } } } },
    });
    const required = new Map<string, Set<string>>();
    for (const item of items) {
      if (!item.variants.length || item.variants.some((variant) => !variant.recipeLines.length)) continue;
      let sizes: Set<string>[];
      try {
        sizes = item.variants.map((variant) => new Set(explode(variant.recipeLines, dec(1), graph).usage.keys()));
      } catch (error) {
        if (error instanceof RecipeCycleError || error instanceof RecipeDepthError) continue;
        throw error;
      }
      const common = new Set([...sizes[0]!].filter((id) => sizes.every((needs) => needs.has(id))));
      if (common.size) required.set(item.id, common);
    }
    return required;
  }
}

