import { auth, fixtures } from './inventory-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

// What the dashboard's inventory screens read besides the documents themselves: where a transfer
// may go, the cost-free dish list, unit names in both languages, and whether an ingredient is locked.

let t: TestApp;
const { http, chain, stocked, ingredient, staff } = fixtures(() => t);

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  return [];
}

describe('inventory: transfer destinations', () => {
  it('lists the other active branches as id, name and slug only, within the caller’s restaurant', async () => {
    const r = await stocked();
    const other = await chain('other@grill.test', 'grill');
    const closed = await http().post('/v1/branches').set(auth(r.token)).send({ name: 'Maadi', slug: 'maadi', phone: '0222221111', city: 'Cairo', address: '9 Road 9' }).expect(201);
    await http().patch(`/v1/branches/${closed.body.id}`).set(auth(r.token)).send({ isActive: false }).expect(200);

    // The owner: from the main branch by default, or from the branch asked for.
    const fromMain = (await http().get('/v1/inventory/transfer-destinations').set(auth(r.token)).expect(200)).body;
    expect(fromMain).toEqual([{ id: r.nasrId, name: 'Nasr City', slug: 'nasr-city' }]);
    expect((await http().get(`/v1/inventory/transfer-destinations?branchId=${r.nasrId}`).set(auth(r.token)).expect(200)).body)
      .toEqual([{ id: r.mainId, name: expect.any(String), slug: expect.any(String) }]);
    // Nothing else about a branch, and never the inactive one or another restaurant's.
    for (const row of fromMain) expect(Object.keys(row).sort()).toEqual(['id', 'name', 'slug']);
    expect(JSON.stringify(fromMain)).not.toContain(closed.body.id);
    expect(JSON.stringify(fromMain)).not.toContain(other.mainId);
    await http().get(`/v1/inventory/transfer-destinations?branchId=${other.mainId}`).set(auth(r.token)).expect(404);
    await http().get('/v1/inventory/transfer-destinations?branchId=nope').set(auth(r.token)).expect(400);
    expect((await http().get('/v1/inventory/transfer-destinations').set(auth(other.token)).expect(200)).body).toEqual([{ id: other.nasrId, name: 'Nasr City', slug: 'nasr-city' }]);

    // A branch-tied manager: from their branch to the others; never from another branch.
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test', { branchId: r.nasrId });
    expect((await http().get('/v1/inventory/transfer-destinations').set(auth(manager.token)).expect(200)).body).toEqual([{ id: r.mainId, name: expect.any(String), slug: expect.any(String) }]);
    expect((await http().get(`/v1/inventory/transfer-destinations?branchId=${r.mainId}`).set(auth(manager.token)).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    await http().get(`/v1/inventory/transfer-destinations?branchId=${other.mainId}`).set(auth(manager.token)).expect(404);
    // Their own branch's other data stays where it was: /v1/branches still shows them only Nasr City.
    expect((await http().get('/v1/branches').set(auth(manager.token)).expect(200)).body.branches.map((branch: { id: string }) => branch.id)).toEqual([r.nasrId]);

    // Posting: the source must be within their scope, the destination any branch of the restaurant.
    await http().post('/v1/inventory/purchases').set(auth(manager.token)).send({ receive: true, lines: [{ ingredientId: r.ids.lentils, quantity: 2000, unitPrice: 7 }] }).expect(201);
    for (const fromBranchId of [r.mainId, closed.body.id]) {
      const refused = await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ fromBranchId, toBranchId: r.nasrId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(403);
      expect(refused.body.error.code).toBe('BRANCH_FORBIDDEN');
    }
    await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ fromBranchId: other.mainId, toBranchId: r.mainId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(404);
    await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ toBranchId: other.mainId, lines: [{ ingredientId: r.ids.lentils, quantity: 1 }] }).expect(404);
    const sent = await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ fromBranchId: r.nasrId, toBranchId: r.mainId, lines: [{ ingredientId: r.ids.lentils, quantity: 500 }] }).expect(201);
    expect(sent.body).toMatchObject({ fromBranch: { id: r.nasrId }, toBranch: { id: r.mainId } });
    expect(await t.prisma.stockMovement.count({ where: { branchId: r.mainId, ingredientId: r.ids.rice, type: 'TRANSFER_OUT' } })).toBe(0);

    // Without inventory.operate (the kitchen), or without the plan.
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    await http().get('/v1/inventory/transfer-destinations').set(auth(kitchen.token)).expect(403);
    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'MENU' } });
    expect((await http().get('/v1/inventory/transfer-destinations').set(auth(r.token)).expect(409)).body.error.code).toBe('INVENTORY_UNAVAILABLE');
  });
});

describe('inventory: dish list', () => {
  it('lists every dish size with its recipe lines and no cost or price, for viewers and waste recorders', async () => {
    const r = await stocked();
    const category = await http().post('/v1/menu/categories').set(auth(r.token)).send({ nameAr: 'حلو', nameEn: 'Desserts' }).expect(201);
    const pudding = await http().post('/v1/menu/items').set(auth(r.token)).send({ categoryId: category.body.id, nameAr: 'أرز باللبن', nameEn: 'Rice pudding', variants: [{ pricePiastres: 2500 }] }).expect(201);

    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    const list = (await http().get('/v1/inventory/dishes').set(auth(kitchen.token)).expect(200)).body;
    expect(list.branchId).toBe(r.mainId);
    expect(list.rows.map((row: { variantId: string }) => row.variantId)).toEqual([r.koshary.small, r.koshary.large, r.lemonade.variant, pudding.body.variants[0].id]);
    expect(list.rows[0]).toEqual({
      itemId: r.koshary.id, variantId: r.koshary.small, categoryId: expect.any(String), categoryNameAr: 'رئيسي', categoryNameEn: null,
      itemNameAr: 'كشري', itemNameEn: null, variantNameAr: 'صغير', variantNameEn: null, hasRecipe: true,
      lines: [
        { ingredientId: r.ids.rice, nameAr: 'رز', nameEn: 'Rice', kind: 'RAW', baseUnit: 'g', quantity: 150, wastePercent: 0, usage: 150 },
        { ingredientId: r.ids.lentils, nameAr: 'عدس', nameEn: null, kind: 'RAW', baseUnit: 'g', quantity: 50, wastePercent: 0, usage: 50 },
        { ingredientId: r.ids.sauce, nameAr: 'صلصة طماطم', nameEn: null, kind: 'PREPARED', baseUnit: 'g', quantity: 100, wastePercent: 0, usage: 100 },
      ],
    });
    expect(list.rows[1].lines[0]).toMatchObject({ quantity: 250, wastePercent: 10, usage: 277.778 });
    // One size: no size name. No recipe: said so, with no lines.
    expect(list.rows[2]).toMatchObject({ itemNameAr: 'ليمون نعناع', variantNameAr: null, hasRecipe: true });
    expect(list.rows[3]).toMatchObject({ itemNameEn: 'Rice pudding', categoryNameEn: 'Desserts', variantNameAr: null, hasRecipe: false, lines: [] });

    // No cost or price anywhere, not even for the owner (who has inventory.costs).
    const owner = (await http().get(`/v1/inventory/dishes?branchId=${r.nasrId}`).set(auth(r.token)).expect(200)).body;
    expect(owner.branchId).toBe(r.nasrId);
    for (const body of [list, owner]) expect(keysOf(body).filter((key) => /cost|price|margin|percent/i.test(key) && key !== 'wastePercent')).toEqual([]);

    // inventory.waste alone is enough (a cashier given only that); no inventory permission is not.
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test', { permissions: ['inventory.waste'] });
    expect((await http().get('/v1/inventory/dishes').set(auth(cashier.token)).expect(200)).body.rows).toHaveLength(4);
    await http().get(`/v1/inventory/stock?branchId=${r.mainId}`).set(auth(cashier.token)).expect(403);
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await http().get('/v1/inventory/dishes').set(auth(waiter.token)).expect(403);

    // Branch scope and tenants.
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test', { branchId: r.nasrId });
    expect((await http().get('/v1/inventory/dishes').set(auth(manager.token)).expect(200)).body.branchId).toBe(r.nasrId);
    await http().get(`/v1/inventory/dishes?branchId=${r.mainId}`).set(auth(manager.token)).expect(403);
    const other = await chain('other@grill.test', 'grill');
    await http().get(`/v1/inventory/dishes?branchId=${r.mainId}`).set(auth(other.token)).expect(404);
    expect((await http().get('/v1/inventory/dishes').set(auth(other.token)).expect(200)).body.rows.every((row: { hasRecipe: boolean }) => !row.hasRecipe)).toBe(true);

    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'MENU' } });
    await http().get('/v1/inventory/dishes').set(auth(kitchen.token)).expect(409);
  });
});

describe('inventory: unit names', () => {
  it('returns the Arabic and English names of the unit on purchases, waste and reorder lines', async () => {
    const r = await stocked();
    // The fixture's units have no English names: the purchase made then says so.
    expect(r.purchase.lines[0]).toMatchObject({ unitNameAr: 'شيكارة 25 كيلو', unitNameEn: null });
    expect(Object.keys(r.purchase.lines[0])).not.toContain('unitName');

    const units = (await http().put(`/v1/inventory/ingredients/${r.ids.rice}/units`).set(auth(r.token))
      .send({ units: [{ nameAr: 'كيلو', nameEn: 'kg', factor: 1000 }, { nameAr: 'شيكارة 25 كيلو', nameEn: '25 kg sack', factor: 25_000 }] }).expect(200)).body.units;
    const purchase = (await http().post('/v1/inventory/purchases').set(auth(r.token))
      .send({ receive: true, lines: [{ ingredientId: r.ids.rice, unitId: units[1].id, quantity: 1, unitPrice: 75_000 }, { ingredientId: r.ids.lentils, quantity: 1000, unitPrice: 6 }] }).expect(201)).body;
    expect(purchase.lines).toEqual([
      expect.objectContaining({ unitId: units[1].id, unitNameAr: 'شيكارة 25 كيلو', unitNameEn: '25 kg sack' }),
      expect.objectContaining({ unitId: null, unitNameAr: null, unitNameEn: null }),
    ]);
    // Names are copies: the earlier purchase keeps what it had.
    expect((await http().get(`/v1/inventory/purchases/${r.purchase.id}`).set(auth(r.token)).expect(200)).body.lines[0]).toMatchObject({ unitNameAr: 'شيكارة 25 كيلو', unitNameEn: null });

    const lentilKilo = (await http().get('/v1/inventory/ingredients').set(auth(r.token)).expect(200)).body.find((row: { id: string }) => row.id === r.ids.lentils).units[0];
    const waste = (await http().post('/v1/inventory/waste').set(auth(r.token)).send({
      reason: 'SPOILED',
      lines: [{ ingredientId: r.ids.rice, unitId: units[0].id, quantity: 1 }, { ingredientId: r.ids.lentils, unitId: lentilKilo.id, quantity: 1 }, { variantId: r.koshary.small, quantity: 1 }],
    }).expect(201)).body;
    expect(waste.lines).toEqual([
      expect.objectContaining({ ingredientId: r.ids.rice, quantity: 1000, unitNameAr: 'كيلو', unitNameEn: 'kg' }),
      expect.objectContaining({ ingredientId: r.ids.lentils, quantity: 1000, unitNameAr: 'كيلو', unitNameEn: null }),
      expect.objectContaining({ variantId: r.koshary.small, quantity: 1, unitNameAr: null, unitNameEn: null }),
    ]);
    expect((await http().get('/v1/inventory/waste').set(auth(r.token)).expect(200)).body.items[0].lines[0]).toMatchObject({ unitNameAr: 'كيلو', unitNameEn: 'kg' });

    await http().patch(`/v1/inventory/stock/${r.ids.rice}?branchId=${r.mainId}`).set(auth(r.token)).send({ reorderPoint: 200_000, parLevel: 300_000 }).expect(200);
    await http().patch(`/v1/inventory/stock/${r.ids.lentils}?branchId=${r.mainId}`).set(auth(r.token)).send({ reorderPoint: 10_000 }).expect(200);
    const lines = (await http().get('/v1/inventory/reports/reorder').set(auth(r.token)).expect(200)).body.groups.flatMap((group: { lines: unknown[] }) => group.lines);
    expect(lines.find((line: { ingredientId: string }) => line.ingredientId === r.ids.rice).suggestedUnits).toEqual({ unitId: units[0].id, unitNameAr: 'كيلو', unitNameEn: 'kg', quantity: expect.any(Number) });
    expect(lines.find((line: { ingredientId: string }) => line.ingredientId === r.ids.lentils).suggestedUnits).toEqual({ unitId: lentilKilo.id, unitNameAr: 'كيلو', unitNameEn: null, quantity: expect.any(Number) });
  });
});

describe('inventory: locked ingredients', () => {
  it('flags an ingredient locked exactly when the API refuses to change its kind or unit type', async () => {
    const r = await stocked();
    const sugar = await ingredient(r.token, { nameAr: 'سكر', dimension: 'MASS' });
    expect(sugar).toMatchObject({ locked: false, lockReason: null });

    const byId = async () => new Map((await http().get('/v1/inventory/ingredients?includeInactive=true').set(auth(r.token)).expect(200)).body
      .map((row: { id: string; locked: boolean; lockReason: string | null; dimension: string }) => [row.id, row]));
    const rows = await byId();
    // Rice was bought (history); the others are in recipes; lemons in the lemonade's.
    expect(rows.get(r.ids.rice)).toMatchObject({ locked: true, lockReason: 'HISTORY' });
    for (const id of [r.ids.lentils, r.ids.tomato, r.ids.oil, r.ids.lemons, r.ids.sauce]) expect(rows.get(id)).toMatchObject({ locked: true, lockReason: 'RECIPES' });
    expect(rows.get(sugar.id)).toMatchObject({ locked: false, lockReason: null });

    // The flag and the API agree, for every ingredient.
    for (const [id, row] of rows as Map<string, { locked: boolean; dimension: string }>) {
      const response = await http().patch(`/v1/inventory/ingredients/${id}`).set(auth(r.token)).send({ dimension: row.dimension === 'COUNT' ? 'MASS' : 'COUNT' });
      expect([id, response.status]).toEqual([id, row.locked ? 409 : 200]);
      if (row.locked) expect(response.body.error.code).toBe('INVENTORY_INGREDIENT_LOCKED');
    }
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    expect((await http().get('/v1/inventory/ingredients').set(auth(kitchen.token)).expect(200)).body.find((row: { id: string }) => row.id === r.ids.rice)).toMatchObject({ locked: true, lockReason: 'HISTORY' });

    // Used in a recipe: locked (and it cannot be deleted); out of every recipe again: unlocked.
    const saved = await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.lemons, quantity: 1 }, { ingredientId: sugar.id, quantity: 20 }] }).expect(200);
    expect(saved.body.lines).toHaveLength(2);
    expect((await byId()).get(sugar.id)).toMatchObject({ locked: true, lockReason: 'RECIPES' });
    await http().delete(`/v1/inventory/ingredients/${sugar.id}`).set(auth(r.token)).expect(409);
    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.lemons, quantity: 1 }] }).expect(200);
    expect((await byId()).get(sugar.id)).toMatchObject({ locked: false, lockReason: null });

    // Waste is history too, even when it is also in a recipe; the response of a change carries the flag.
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lemons, quantity: 2 }] }).expect(201);
    expect((await byId()).get(r.ids.lemons)).toMatchObject({ locked: true, lockReason: 'HISTORY' });
    expect((await http().patch(`/v1/inventory/ingredients/${r.ids.rice}`).set(auth(r.token)).send({ nameEn: 'Egyptian rice' }).expect(200)).body).toMatchObject({ locked: true, lockReason: 'HISTORY' });
    await http().delete(`/v1/inventory/ingredients/${sugar.id}`).set(auth(r.token)).expect(204);
  });
});
