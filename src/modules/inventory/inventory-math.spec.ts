import {
  applyMovement,
  assertValidGraph,
  averageAfterInflow,
  averageAfterUnwind,
  classifyMenu,
  costOfUsage,
  dec,
  explode,
  foodCostFigures,
  foodCostPercent,
  overThreshold,
  preparedUnitCost,
  RecipeCycleError,
  RecipeDepthError,
  type RecipeGraph,
  type RecipeNode,
  recipeCost,
  reorderSuggestion,
  stockStatus,
  toBaseQuantity,
  usageOf,
  ZERO,
} from './inventory-math.js';

const line = (ingredientId: string, quantity: number, wastePercent = 0) => ({ ingredientId, quantity: dec(quantity), wastePercent: dec(wastePercent) });
const raw: RecipeNode = { kind: 'RAW', yieldQuantity: null, lines: [] };
const prepared = (yieldQuantity: number, lines: ReturnType<typeof line>[]): RecipeNode => ({ kind: 'PREPARED', yieldQuantity: dec(yieldQuantity), lines });
const str = (map: Map<string, { toString(): string }>) => Object.fromEntries([...map].map(([key, value]) => [key, value.toString()]));

describe('units and waste', () => {
  it('converts purchase units to base units', () => {
    expect(toBaseQuantity(dec(2), dec(25_000)).toString()).toBe('50000'); // two 25 kg sacks
    expect(toBaseQuantity(dec(1.5), dec(1000)).toString()).toBe('1500');
    expect(toBaseQuantity(dec(0.3333), dec(3)).toString()).toBe('1'); // rounded to 0.001
  });

  it('uses quantity / (1 − waste%)', () => {
    expect(usageOf(dec(100), dec(10)).toDecimalPlaces(3).toString()).toBe('111.111');
    expect(usageOf(dec(250), ZERO).toString()).toBe('250');
    expect(usageOf(dec(50), dec(50)).toString()).toBe('100');
    expect(() => usageOf(dec(1), dec(95))).toThrow(RangeError);
  });
});

describe('weighted average cost', () => {
  const state = (onHand: number, avgCost: number | null) => ({ onHand: dec(onHand), avgCost: avgCost === null ? null : dec(avgCost) });

  it('blends a purchase into what is on hand', () => {
    // 10 kg at EGP 20/kg (2 pt/g) + 10 kg at EGP 30/kg (3 pt/g) = 2.5 pt/g.
    expect(averageAfterInflow(state(10_000, 2), dec(10_000), dec(3))!.toString()).toBe('2.5');
    expect(averageAfterInflow(state(3000, 2.5), dec(1000), dec(4))!.toString()).toBe('2.875');
  });

  it('takes the new cost when nothing is on hand or there is no average yet', () => {
    expect(averageAfterInflow(state(0, 2), dec(500), dec(7))!.toString()).toBe('7');
    expect(averageAfterInflow(state(-200, 2), dec(500), dec(7))!.toString()).toBe('7');
    expect(averageAfterInflow(state(0, null), dec(500), dec(7))!.toString()).toBe('7');
    // A return never creates an average.
    expect(averageAfterInflow(state(0, null), dec(500), dec(7), false)).toBeNull();
  });

  it('unwinds a voided purchase back to the earlier average', () => {
    expect(averageAfterUnwind(state(20_000, 2.5), dec(10_000), dec(3))!.toString()).toBe('2');
    // Nothing (or less) left: the average stays.
    expect(averageAfterUnwind(state(8000, 2.5), dec(10_000), dec(3))!.toString()).toBe('2.5');
    // Sales took the expensive goods: never below zero.
    expect(averageAfterUnwind(state(15_000, 5.4545), dec(10_000), dec(50))!.toString()).toBe('0');
  });

  it('applies movements: inflows at cost, outflows at the average (or the standard cost)', () => {
    const received = applyMovement(state(0, null), 'PURCHASE', dec(10_000), dec(2), null);
    expect(received).toMatchObject({ after: { onHand: dec(10_000), avgCost: dec(2) } });
    expect(received.value.toString()).toBe('20000');

    const sold = applyMovement(received.after, 'SALE', dec(-250), null, dec(9));
    expect(sold.unitCost.toString()).toBe('2');
    expect(sold.value.toString()).toBe('-500');
    expect(sold.after.onHand.toString()).toBe('9750');
    expect(sold.after.avgCost!.toString()).toBe('2');

    // Never received here: the standard cost, else 0; the average stays empty.
    const early = applyMovement(state(0, null), 'WASTE', dec(-100), null, dec(1.5));
    expect(early.value.toString()).toBe('-150');
    expect(early.after).toMatchObject({ onHand: dec(-100), avgCost: null });
    expect(applyMovement(state(0, null), 'SALE', dec(-100), null, null).value.toString()).toBe('0');

    // Back at the cost it left with; a positive count variance at the average.
    const back = applyMovement(sold.after, 'SALE_REVERSAL', dec(250), dec(2), null);
    expect(back.after.onHand.toString()).toBe('10000');
    expect(back.after.avgCost!.toString()).toBe('2');
    const found = applyMovement(back.after, 'COUNT_VARIANCE', dec(100), null, null);
    expect(found.value.toString()).toBe('200');
    const lost = applyMovement(found.after, 'COUNT_VARIANCE', dec(-300), null, null);
    expect(lost.value.toString()).toBe('-600');
    expect(() => applyMovement(lost.after, 'SALE', ZERO, null, null)).toThrow(RangeError);
  });
});

describe('recipe explosion', () => {
  // Tomato sauce: 1200 g tomato + 50 ml oil (10% loss) make 1000 g. Crispy onion: 1000 g onion (20% trim) + 200 ml oil make 400 g.
  const graph: RecipeGraph = new Map([
    ['tomato', raw], ['oil', raw], ['onion', raw], ['rice', raw],
    ['sauce', prepared(1000, [line('tomato', 1200), line('oil', 45, 10)])],
    ['crispy', prepared(400, [line('onion', 800, 20), line('oil', 200)])],
  ]);

  it('passes raw ingredients through and scales by the quantity ordered', () => {
    expect(str(explode([line('rice', 150), line('tomato', 10, 50)], dec(2), graph).usage)).toEqual({ rice: '300', tomato: '40' });
  });

  it('explodes prepared ingredients by used / yield and merges repeats', () => {
    const result = explode([line('rice', 150), line('sauce', 100), line('crispy', 20), line('oil', 5)], dec(1), graph);
    // sauce 100 g → tomato 120, oil 5 (45/0.9 × 0.1); crispy 20 g → onion 50 (800/0.8 × 0.05), oil 10; + oil 5.
    expect(str(result.usage)).toEqual({ rice: '150', tomato: '120', oil: '20', onion: '50' });
    expect(result.incomplete).toBe(false);
  });

  it('nests up to three levels and refuses a fourth', () => {
    const deep: RecipeGraph = new Map([
      ['rice', raw],
      ['p1', prepared(100, [line('p2', 100)])],
      ['p2', prepared(100, [line('p3', 100)])],
      ['p3', prepared(100, [line('rice', 50)])],
      ['p0', prepared(100, [line('p1', 100)])],
    ]);
    expect(str(explode([line('p1', 200)], dec(1), deep).usage)).toEqual({ rice: '100' });
    expect(() => explode([line('p0', 1)], dec(1), deep)).toThrow(RecipeDepthError);
    expect(() => assertValidGraph(deep)).toThrow(RecipeDepthError);
  });

  it('refuses cycles, direct or through another prepared ingredient', () => {
    const cyclic: RecipeGraph = new Map([
      ['rice', raw],
      ['a', prepared(100, [line('b', 10), line('rice', 5)])],
      ['b', prepared(100, [line('a', 10)])],
    ]);
    expect(() => explode([line('a', 1)], dec(1), cyclic)).toThrow(RecipeCycleError);
    try {
      assertValidGraph(cyclic);
    } catch (error) {
      expect((error as RecipeCycleError).path).toEqual(['a', 'b', 'a']);
    }
    expect(() => assertValidGraph(new Map([['self', prepared(1, [line('self', 1)])]]))).toThrow(RecipeCycleError);
  });

  it('flags a prepared ingredient without a recipe as incomplete', () => {
    const result = explode([line('rice', 100), line('empty', 50)], dec(1), new Map([['rice', raw], ['empty', { kind: 'PREPARED', yieldQuantity: null, lines: [] }]]));
    expect(str(result.usage)).toEqual({ rice: '100' });
    expect(result.incomplete).toBe(true);
  });
});

describe('recipe cost', () => {
  const graph: RecipeGraph = new Map([
    ['tomato', raw], ['oil', raw], ['rice', raw],
    ['sauce', prepared(1000, [line('tomato', 1200), line('oil', 50)])],
  ]);
  const costs: Record<string, number> = { tomato: 1.5, oil: 9, rice: 3.2 };
  const unitCost = (id: string) => (costs[id] === undefined ? null : dec(costs[id]!));

  it('sums usage × unit cost, through prepared ingredients', () => {
    // rice 150 × 3.2 = 480; sauce 100 g → tomato 120 × 1.5 = 180, oil 5 × 9 = 45.
    expect(recipeCost([line('rice', 150), line('sauce', 100)], graph, unitCost).cost.toString()).toBe('705');
    expect(recipeCost([line('rice', 150)], graph, unitCost, dec(3)).cost.toString()).toBe('1440');
  });

  it('costs a prepared ingredient per base unit: components ÷ yield', () => {
    // (1200 × 1.5 + 50 × 9) / 1000 = 2.25 pt/g.
    expect(preparedUnitCost(graph, 'sauce', unitCost).cost.toString()).toBe('2.25');
  });

  it('marks missing costs incomplete', () => {
    const result = costOfUsage(new Map([['rice', dec(100)], ['saffron', dec(1)]]), unitCost);
    expect(result).toMatchObject({ incomplete: true });
    expect(result.cost.toString()).toBe('320');
  });

  it('gives the food cost percentage of the price', () => {
    expect(foodCostPercent(dec(705), 3500)).toBe(20.14);
    expect(foodCostPercent(dec(705), 0)).toBeNull();
  });
});

describe('stock status and reordering', () => {
  it('is OUT at or below zero, LOW at or below the reorder point', () => {
    expect(stockStatus(dec(0), null)).toBe('OUT');
    expect(stockStatus(dec(-5), dec(10))).toBe('OUT');
    expect(stockStatus(dec(10), dec(10))).toBe('LOW');
    expect(stockStatus(dec(10.001), dec(10))).toBe('OK');
    expect(stockStatus(dec(1), null)).toBe('OK');
  });

  it('suggests reaching the par level, in purchase units rounded up', () => {
    const suggestion = reorderSuggestion(dec(4000), dec(5000), dec(60_000), dec(25_000))!;
    expect(suggestion.quantity.toString()).toBe('56000');
    expect(suggestion.units!.toString()).toBe('3');
    // Without a par level: back up to the reorder point.
    expect(reorderSuggestion(dec(-500), dec(2000), null)!.quantity.toString()).toBe('2500');
    expect(reorderSuggestion(dec(6000), dec(5000), dec(60_000))).toBeNull();
    expect(reorderSuggestion(dec(0), null, dec(100))).toBeNull();
  });
});

describe('stock count approval threshold', () => {
  it('flags lines off by more than the percentage of what was expected', () => {
    expect(overThreshold(dec(1000), dec(950), dec(5))).toBe(false); // exactly 5%
    expect(overThreshold(dec(1000), dec(949), dec(5))).toBe(true);
    expect(overThreshold(dec(1000), dec(1060), dec(5))).toBe(true);
    expect(overThreshold(dec(0), dec(1), dec(50))).toBe(true); // something found where nothing was expected
    expect(overThreshold(dec(0), dec(0), dec(0))).toBe(false);
    expect(overThreshold(dec(1000), null, dec(0))).toBe(false); // not counted
  });
});

describe('reports', () => {
  it('computes theoretical and actual food cost', () => {
    const figures = foodCostFigures(100_000, {
      SALE: dec(-30_000.4), SALE_REVERSAL: dec(2_000), WASTE: dec(-1_500), COUNT_VARIANCE: dec(-500), PURCHASE: dec(80_000), PURCHASE_VOID: dec(-10_000),
    });
    expect(figures).toEqual({
      revenue: 100_000, theoreticalCost: 28_000, wasteCost: 1_500, countVariance: -500, purchases: 70_000,
      theoreticalFoodCostPercent: 28, actualFoodCostPercent: 30,
    });
    // A count gain lowers the actual cost; no revenue, no percentages.
    expect(foodCostFigures(0, { COUNT_VARIANCE: dec(250) })).toMatchObject({ theoreticalCost: 0, countVariance: 250, theoreticalFoodCostPercent: null, actualFoodCostPercent: null });
  });

  it('classifies dishes by popularity and margin', () => {
    const dish = (itemId: string, sold: number, price: number, unitCost: number | null) => ({
      itemId, sold, revenue: sold * price, costedSold: unitCost === null ? 0 : sold, costedRevenue: unitCost === null ? 0 : sold * price, cost: unitCost === null ? 0 : sold * unitCost,
    });
    const result = classifyMenu([
      dish('koshary', 100, 50, 15), // margin 35, popular
      dish('tahini', 80, 20, 8), // margin 12, popular
      dish('fatta', 10, 210, 90), // margin 120, unpopular
      dish('salad', 10, 95, 85), // margin 10, unpopular
      dish('soda', 40, 30, null), // no recipe
    ]);
    // Equal share 1/4 → threshold 0.175; weighted average margin = (3500 + 960 + 1200 + 100) / 200 = 28.8.
    expect(result.popularityThreshold).toBe(0.175);
    expect(result.averageMargin).toBe(28.8);
    expect(Object.fromEntries(result.rows.map((row) => [row.itemId, row.class]))).toEqual({ koshary: 'STAR', tahini: 'PLOWHORSE', fatta: 'PUZZLE', salad: 'DOG', soda: null });
    expect(result.rows[0]).toMatchObject({ unitMargin: 35, totalMargin: 3500, share: 0.5, foodCostPercent: 30 });
    expect(classifyMenu([])).toEqual({ popularityThreshold: null, averageMargin: null, rows: [] });
  });
});
