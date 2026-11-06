import { INVENTORY_LIMITS, type IngredientKind, type MenuEngineeringClass, type StockMovementType, type StockStatus } from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';

// The arithmetic of inventory, pure so it is unit-tested: units, waste, weighted average cost,
// recipe explosion and cost, stock status, reorder suggestions and the reports' sums. Stock maths
// uses Decimal (never floats); numbers appear only at the API boundary.

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HUNDRED = new Decimal(100);

/** A JSON number (or a Decimal from the database) as a Decimal, exactly as written. */
export const dec = (value: number | string | Decimal): Decimal => (value instanceof Decimal ? value : new Decimal(typeof value === 'number' ? String(value) : value));
export const decOrNull = (value: number | string | Decimal | null | undefined): Decimal | null => (value === null || value === undefined ? null : dec(value));

/** Base units: 0.001. */
export const roundQuantity = (value: Decimal) => value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
/** Piastres per base unit: 0.0001. */
export const roundUnitCost = (value: Decimal) => value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
/** Piastres: 0.01. */
export const roundValue = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Whole piastres (order line costs, reports). */
export const wholePiastres = (value: Decimal) => value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() || 0;

/** For JSON (never −0). */
export const num = (value: Decimal) => value.toNumber() || 0;
export const numOrNull = (value: Decimal | null | undefined) => (value === null || value === undefined ? null : value.toNumber() || 0);

// --- Units and waste ---------------------------------------------------------------------------------

/** A quantity in a purchase unit (factor base units each) in base units. */
export const toBaseQuantity = (quantity: Decimal, factor: Decimal) => roundQuantity(quantity.mul(factor));

/** What a recipe line uses: quantity / (1 − waste% / 100). "100 g served, 10% trim" uses 111.111 g. */
export function usageOf(quantity: Decimal, wastePercent: Decimal): Decimal {
  if (wastePercent.lt(0) || wastePercent.gt(INVENTORY_LIMITS.maxWastePercent)) throw new RangeError('Waste % must be 0–90');
  return quantity.div(ONE.minus(wastePercent.div(HUNDRED)));
}

/** A movement's value: quantity × unit cost, to the hundredth of a piastre. */
export const valueOf = (quantity: Decimal, unitCost: Decimal) => roundValue(quantity.mul(unitCost));

// --- Weighted average cost ---------------------------------------------------------------------------

export type StockState = { onHand: Decimal; avgCost: Decimal | null };

/**
 * How each movement type moves the average:
 * - `inflow`: received at a known cost (purchase, transfer in): avg = (onHand × avg + qty × cost) / (onHand + qty),
 *   or the cost itself when nothing (or less than nothing) is on hand or there is no average yet.
 * - `return`: back at the cost it left with (sale reversal, positive count variance): blends the same way,
 *   but never creates an average where the branch has none.
 * - `unwind`: a received purchase taken back at its own cost (void): the average it had without it,
 *   while enough remains; otherwise unchanged.
 * - `outflow`: valued at the current average, which does not change.
 */
export type CostingMode = 'inflow' | 'return' | 'unwind' | 'outflow';

export function costingMode(type: StockMovementType, quantity: Decimal): CostingMode {
  switch (type) {
    case 'PURCHASE':
    case 'TRANSFER_IN':
      return 'inflow';
    case 'SALE_REVERSAL':
      return 'return';
    case 'PURCHASE_VOID':
      return 'unwind';
    case 'COUNT_VARIANCE':
      return quantity.gt(0) ? 'return' : 'outflow';
    default:
      return 'outflow';
  }
}

/** The cost an outflow is valued at: the average, else the owner's standard cost, else 0. */
export const effectiveCost = (avgCost: Decimal | null, standardCost: Decimal | null) => avgCost ?? standardCost ?? ZERO;

export function averageAfterInflow(state: StockState, quantity: Decimal, unitCost: Decimal, createsAverage = true): Decimal | null {
  if (state.avgCost === null) return createsAverage ? roundUnitCost(unitCost) : null;
  if (state.onHand.lte(0)) return roundUnitCost(unitCost);
  return roundUnitCost(state.onHand.mul(state.avgCost).plus(quantity.mul(unitCost)).div(state.onHand.plus(quantity)));
}

export function averageAfterUnwind(state: StockState, quantity: Decimal, unitCost: Decimal): Decimal | null {
  if (state.avgCost === null) return null;
  const remaining = state.onHand.minus(quantity);
  if (state.onHand.lte(0) || remaining.lte(0)) return state.avgCost;
  const value = state.onHand.mul(state.avgCost).minus(quantity.mul(unitCost));
  // Sales already took the expensive goods: what is left cannot be worth less than nothing.
  return value.lte(0) ? ZERO : roundUnitCost(value.div(remaining));
}

export type AppliedMovement = { unitCost: Decimal; value: Decimal; after: StockState };

/**
 * One movement against a stock row. `quantity` is signed (positive adds). `unitCost` is the known
 * cost of an inflow, return or unwind; outflows (and returns without one) use the current average.
 */
export function applyMovement(state: StockState, type: StockMovementType, quantity: Decimal, unitCost: Decimal | null, standardCost: Decimal | null): AppliedMovement {
  if (quantity.isZero()) throw new RangeError('A movement moves something');
  const mode = costingMode(type, quantity);
  const cost = roundUnitCost(mode === 'outflow' || unitCost === null ? effectiveCost(state.avgCost, standardCost) : unitCost);
  const onHand = roundQuantity(state.onHand.plus(quantity));
  let avgCost = state.avgCost;
  if (mode === 'inflow') avgCost = averageAfterInflow(state, quantity, cost, true);
  else if (mode === 'return') avgCost = averageAfterInflow(state, quantity, cost, false);
  else if (mode === 'unwind') avgCost = averageAfterUnwind(state, quantity.abs(), cost);
  return { unitCost: cost, value: valueOf(quantity, cost), after: { onHand, avgCost } };
}

// --- Recipes -----------------------------------------------------------------------------------------

export type RecipeLineInput = { ingredientId: string; quantity: Decimal; wastePercent: Decimal };
export type RecipeNode = { kind: IngredientKind; yieldQuantity: Decimal | null; lines: readonly RecipeLineInput[] };
/** Every ingredient of a restaurant that matters for explosion: prepared ones with their recipe. */
export type RecipeGraph = ReadonlyMap<string, RecipeNode>;

export class RecipeCycleError extends Error {
  constructor(readonly path: string[]) {
    super('The recipe uses itself.');
  }
}

export class RecipeDepthError extends Error {
  constructor(readonly path: string[]) {
    super(`Prepared ingredients nest at most ${INVENTORY_LIMITS.maxPrepDepth} levels.`);
  }
}

export type Explosion = {
  /** Raw ingredient → base units used, rounded to 0.001 unless asked not to (zeros dropped). */
  usage: Map<string, Decimal>;
  /** A prepared ingredient on the way has no recipe (or no yield): its part is missing. */
  incomplete: boolean;
};

/**
 * Turns recipe lines × multiplier into the raw ingredients they use. A prepared ingredient explodes
 * into its own recipe scaled by used / yield, down to INVENTORY_LIMITS.maxPrepDepth levels; a cycle
 * throws RecipeCycleError, deeper nesting RecipeDepthError. Unknown ingredients count as raw.
 */
export function explode(lines: readonly RecipeLineInput[], multiplier: Decimal, graph: RecipeGraph, round = true): Explosion {
  const raw = new Map<string, Decimal>();
  let incomplete = false;
  const walk = (ingredientId: string, amount: Decimal, path: string[]) => {
    const node = graph.get(ingredientId);
    if (!node || node.kind === 'RAW') {
      raw.set(ingredientId, (raw.get(ingredientId) ?? ZERO).plus(amount));
      return;
    }
    if (path.includes(ingredientId)) throw new RecipeCycleError([...path, ingredientId]);
    if (path.length >= INVENTORY_LIMITS.maxPrepDepth) throw new RecipeDepthError([...path, ingredientId]);
    if (!node.yieldQuantity || node.yieldQuantity.lte(0) || !node.lines.length) {
      incomplete = true;
      return;
    }
    const scale = amount.div(node.yieldQuantity);
    for (const line of node.lines) walk(line.ingredientId, usageOf(line.quantity, line.wastePercent).mul(scale), [...path, ingredientId]);
  };
  for (const line of lines) walk(line.ingredientId, usageOf(line.quantity, line.wastePercent).mul(multiplier), []);
  const usage = new Map<string, Decimal>();
  for (const [id, amount] of raw) {
    const rounded = round ? roundQuantity(amount) : amount;
    if (!rounded.isZero()) usage.set(id, rounded);
  }
  return { usage, incomplete };
}

/** Throws when the prepared ingredient's recipe (as in the graph) has a cycle or nests too deep. */
export function assertValidPrepared(graph: RecipeGraph, ingredientId: string): void {
  explode([{ ingredientId, quantity: ONE, wastePercent: ZERO }], ONE, graph);
}

/** Checks every prepared ingredient of the graph (after a change that may affect any of them). */
export function assertValidGraph(graph: RecipeGraph): void {
  for (const [id, node] of graph) if (node.kind === 'PREPARED') assertValidPrepared(graph, id);
}

/** Σ usage × unit cost. A missing cost counts as 0 and marks the result incomplete. */
export function costOfUsage(usage: ReadonlyMap<string, Decimal>, unitCost: (ingredientId: string) => Decimal | null): { cost: Decimal; incomplete: boolean } {
  let cost = ZERO;
  let incomplete = false;
  for (const [id, amount] of usage) {
    const unit = unitCost(id);
    if (unit === null) incomplete = true;
    else cost = cost.plus(amount.mul(unit));
  }
  return { cost: roundValue(cost), incomplete };
}

/** A recipe's cost: explosion then costing. */
export function recipeCost(lines: readonly RecipeLineInput[], graph: RecipeGraph, unitCost: (ingredientId: string) => Decimal | null, multiplier: Decimal = ONE) {
  const exploded = explode(lines, multiplier, graph);
  const costed = costOfUsage(exploded.usage, unitCost);
  return { cost: costed.cost, incomplete: exploded.incomplete || costed.incomplete, usage: exploded.usage };
}

/** A prepared ingredient's cost per base unit: its components' cost divided by its yield. */
export function preparedUnitCost(graph: RecipeGraph, ingredientId: string, unitCost: (ingredientId: string) => Decimal | null): { cost: Decimal; incomplete: boolean } {
  const exploded = explode([{ ingredientId, quantity: ONE, wastePercent: ZERO }], ONE, graph, false);
  let cost = ZERO;
  let incomplete = exploded.incomplete;
  for (const [id, amount] of exploded.usage) {
    const unit = unitCost(id);
    if (unit === null) incomplete = true;
    else cost = cost.plus(amount.mul(unit));
  }
  return { cost: roundUnitCost(cost), incomplete };
}

/** Ingredient cost ÷ price, as a percentage with two decimals; null without a price. */
export function foodCostPercent(cost: Decimal, pricePiastres: number): number | null {
  if (pricePiastres <= 0) return null;
  return cost.div(pricePiastres).mul(HUNDRED).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

// --- Stock status and reordering ---------------------------------------------------------------------

export function stockStatus(onHand: Decimal, reorderPoint: Decimal | null): StockStatus {
  if (onHand.lte(0)) return 'OUT';
  if (reorderPoint !== null && onHand.lte(reorderPoint)) return 'LOW';
  return 'OK';
}

/**
 * At or below the reorder point: how much to order to reach the par level (or the reorder point
 * when there is none), and the same in a purchase unit rounded up. Null when nothing is needed.
 */
export function reorderSuggestion(onHand: Decimal, reorderPoint: Decimal | null, parLevel: Decimal | null, unitFactor: Decimal | null = null): { quantity: Decimal; units: Decimal | null } | null {
  if (reorderPoint === null || onHand.gt(reorderPoint)) return null;
  const target = parLevel !== null && parLevel.gt(reorderPoint) ? parLevel : reorderPoint;
  const quantity = roundQuantity(target.minus(onHand));
  if (quantity.lte(0)) return null;
  return { quantity, units: unitFactor && unitFactor.gt(0) ? quantity.div(unitFactor).toDecimalPlaces(0, Decimal.ROUND_CEIL) : null };
}

/** A counted line off by more than the threshold (% of what was expected; anything off when nothing was expected). */
export function overThreshold(expected: Decimal, counted: Decimal | null, thresholdPercent: Decimal): boolean {
  if (counted === null) return false;
  const variance = counted.minus(expected).abs();
  if (variance.isZero()) return false;
  if (expected.lte(0)) return true;
  return variance.div(expected).mul(HUNDRED).gt(thresholdPercent);
}

// --- Reports -----------------------------------------------------------------------------------------

/** Movement value sums per type for a period (signed, as stored). */
export type MovementTotals = Partial<Record<StockMovementType, Decimal>>;

/**
 * Food cost for a period: theoretical = what sales should have used (SALE − SALE_REVERSAL), waste,
 * the net count variance (negative is a loss), purchases (received − voided), and the percentages:
 * theoretical / revenue and (theoretical + waste − net variance) / revenue.
 */
export function foodCostFigures(revenuePiastres: number, totals: MovementTotals) {
  const sum = (type: StockMovementType) => totals[type] ?? ZERO;
  const theoretical = sum('SALE').plus(sum('SALE_REVERSAL')).neg();
  const waste = sum('WASTE').neg();
  const variance = sum('COUNT_VARIANCE');
  const purchases = sum('PURCHASE').plus(sum('PURCHASE_VOID'));
  const actual = theoretical.plus(waste).minus(variance);
  const percent = (value: Decimal) => (revenuePiastres > 0 ? value.div(revenuePiastres).mul(HUNDRED).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber() : null);
  return {
    revenue: revenuePiastres,
    theoreticalCost: wholePiastres(theoretical),
    wasteCost: wholePiastres(waste),
    countVariance: wholePiastres(variance),
    purchases: wholePiastres(purchases),
    theoreticalFoodCostPercent: percent(theoretical),
    actualFoodCostPercent: percent(actual),
  };
}

export type DishSales = {
  itemId: string;
  /** Every unit sold. */
  sold: number;
  revenue: number;
  /** Of those, the units (and their revenue) whose line had a recipe cost, and that cost. */
  costedSold: number;
  costedRevenue: number;
  cost: number;
};

export type DishClassification = {
  itemId: string;
  unitMargin: number | null;
  totalMargin: number | null;
  share: number | null;
  foodCostPercent: number | null;
  class: MenuEngineeringClass | null;
};

/**
 * Menu engineering over the dishes whose sales have a recipe cost (the others: class null).
 * Popularity is high at ≥ 70% of an equal share (1 / dishes) of the units sold; margin is high at
 * ≥ the sales-weighted average unit margin. Star high/high, Plowhorse popular/low margin, Puzzle
 * unpopular/high margin, Dog low/low.
 */
export function classifyMenu(dishes: readonly DishSales[]): { popularityThreshold: number | null; averageMargin: number | null; rows: DishClassification[] } {
  const costed = dishes.filter((dish) => dish.costedSold > 0);
  const totalSold = costed.reduce((sum, dish) => sum + dish.costedSold, 0);
  const unitMargin = (dish: DishSales) => (dish.costedRevenue - dish.cost) / dish.costedSold;
  const popularityThreshold = costed.length ? 0.7 / costed.length : null;
  const averageMargin = totalSold ? costed.reduce((sum, dish) => sum + unitMargin(dish) * dish.costedSold, 0) / totalSold : null;
  const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
  const rows = dishes.map((dish): DishClassification => {
    if (!dish.costedSold || popularityThreshold === null || averageMargin === null) {
      return { itemId: dish.itemId, unitMargin: null, totalMargin: null, share: null, foodCostPercent: null, class: null };
    }
    const margin = unitMargin(dish);
    const share = dish.costedSold / totalSold;
    const popular = share >= popularityThreshold - 1e-12;
    const profitable = margin >= averageMargin - 1e-9;
    return {
      itemId: dish.itemId,
      unitMargin: round(margin),
      totalMargin: round(margin * dish.sold),
      share: round(share, 4),
      foodCostPercent: dish.costedRevenue > 0 ? round((dish.cost / dish.costedRevenue) * 100) : null,
      class: popular ? (profitable ? 'STAR' : 'PLOWHORSE') : profitable ? 'PUZZLE' : 'DOG',
    };
  });
  return { popularityThreshold: popularityThreshold === null ? null : round(popularityThreshold, 4), averageMargin: averageMargin === null ? null : round(averageMargin), rows };
}
