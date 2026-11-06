import { auth, fixtures } from './inventory-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
const { http, chain, stocked, ingredient, place, setStatus, staff, stock } = fixtures(() => t);

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('inventory: plan and catalogue', () => {
  it('needs a plan that includes it; without one routes answer 409 and orders deduct nothing', async () => {
    const r = await stocked();
    await http().get('/v1/inventory/settings').set(auth(r.token)).expect(200);
    // Placed while the plan has inventory, accepted after the plan lost it.
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'MENU' } });

    for (const path of ['/v1/inventory/settings', '/v1/inventory/ingredients', `/v1/inventory/stock?branchId=${r.mainId}`, '/v1/inventory/costing']) {
      const response = await http().get(path).set(auth(r.token)).expect(409);
      expect(response.body.error.code).toBe('INVENTORY_UNAVAILABLE');
    }
    await http().post('/v1/inventory/ingredients').set(auth(r.token)).send({ nameAr: 'سكر', dimension: 'MASS' }).expect(409);

    // Orders still work, and deduct nothing; the data is kept.
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);
    expect(await t.prisma.stockMovement.count({ where: { orderId } })).toBe(0);
    expect((await t.prisma.orderItem.findFirstOrThrow({ where: { orderId } })).costPiastres).toBeNull();
    expect(await t.prisma.ingredient.count({ where: { restaurantId: r.restaurantId } })).toBe(6);

    // The Menu & Orders plan includes it.
    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'ORDERS' } });
    expect((await http().get('/v1/inventory/settings').set(auth(r.token)).expect(200)).body).toMatchObject({ enabled: true, autoSoldOut: false });
  });

  it('manages ingredients, units and suppliers with validation and tenant isolation', async () => {
    const r = await chain();
    const supplier = (await http().post('/v1/inventory/suppliers').set(auth(r.token)).send({ name: 'Gomla Market', email: 'Sales@Gomla.test' }).expect(201)).body;
    expect(supplier).toMatchObject({ name: 'Gomla Market', email: 'sales@gomla.test', isActive: true, ingredients: 0, purchases: 0 });
    expect((await http().post('/v1/inventory/suppliers').set(auth(r.token)).send({ name: 'Gomla Market' }).expect(409)).body.error.code).toBe('INVENTORY_SUPPLIER_NAME_TAKEN');
    await http().post('/v1/inventory/suppliers').set(auth(r.token)).send({ name: 'X', email: 'not-an-email' }).expect(400);

    const rice = await ingredient(r.token, {
      nameAr: 'رز', nameEn: 'Rice', category: 'بقالة', dimension: 'MASS', standardCost: 2.5, preferredSupplierId: supplier.id,
      units: [{ nameAr: 'كيلو', factor: 1000 }, { nameAr: 'شيكارة 25 كيلو', factor: 25_000 }],
    });
    expect(rice).toMatchObject({
      nameAr: 'رز', kind: 'RAW', dimension: 'MASS', baseUnit: 'g', standardCost: 2.5, preferredSupplier: { id: supplier.id, name: 'Gomla Market' },
      units: [{ nameAr: 'كيلو', factor: 1000 }, { nameAr: 'شيكارة 25 كيلو', factor: 25_000 }], recipe: [], usedIn: 0, isActive: true,
    });
    expect((await http().post('/v1/inventory/ingredients').set(auth(r.token)).send({ nameAr: 'رز', dimension: 'MASS' }).expect(409)).body.error.code).toBe('INVENTORY_INGREDIENT_NAME_TAKEN');
    // Validation: units, costs, decimals, unknown fields.
    for (const body of [
      { nameAr: 'سكر', dimension: 'WEIGHT' },
      { nameAr: 'سكر', dimension: 'MASS', standardCost: -1 },
      { nameAr: 'سكر', dimension: 'MASS', standardCost: 1.00001 },
      { nameAr: 'سكر', dimension: 'MASS', units: [{ nameAr: 'كيلو', factor: 0 }] },
      { nameAr: '', dimension: 'MASS' },
      { nameAr: 'سكر', dimension: 'MASS', colour: 'white' },
    ]) {
      await http().post('/v1/inventory/ingredients').set(auth(r.token)).send(body).expect(400);
    }

    // Units are replaced; a kept unit keeps its id.
    const units = await http().put(`/v1/inventory/ingredients/${rice.id}/units`).set(auth(r.token))
      .send({ units: [{ nameAr: 'كيلو', factor: 1000 }, { nameAr: 'شيكارة 50 كيلو', factor: 50_000 }] }).expect(200);
    expect(units.body.units.map((unit: { id: string; nameAr: string; factor: number }) => [unit.nameAr, unit.factor])).toEqual([['كيلو', 1000], ['شيكارة 50 كيلو', 50_000]]);
    expect(units.body.units[0].id).toBe(rice.units[0].id);
    await http().put(`/v1/inventory/ingredients/${rice.id}/units`).set(auth(r.token)).send({ units: [{ nameAr: 'كيلو', factor: 1000 }, { nameAr: 'كيلو', factor: 1 }] }).expect(400);

    const renamed = await http().patch(`/v1/inventory/ingredients/${rice.id}`).set(auth(r.token)).send({ nameEn: 'Egyptian rice', standardCost: 3 }).expect(200);
    expect(renamed.body).toMatchObject({ nameEn: 'Egyptian rice', standardCost: 3 });
    // A prepared ingredient's recipe; a raw one has none.
    const sugar = await ingredient(r.token, { nameAr: 'سكر', dimension: 'MASS' });
    expect((await http().put(`/v1/inventory/ingredients/${sugar.id}/recipe`).set(auth(r.token)).send({ yieldQuantity: 10, lines: [] }).expect(400)).body.error.code).toBe('INVENTORY_NOT_PREPARED');

    // Unused: deleted. Used in a recipe: refused, archive instead.
    await http().delete(`/v1/inventory/ingredients/${sugar.id}`).set(auth(r.token)).expect(204);
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token)).send({ lines: [{ ingredientId: rice.id, quantity: 150 }] }).expect(200);
    expect((await http().delete(`/v1/inventory/ingredients/${rice.id}`).set(auth(r.token)).expect(409)).body.error.code).toBe('INVENTORY_INGREDIENT_IN_USE');
    expect((await http().patch(`/v1/inventory/ingredients/${rice.id}`).set(auth(r.token)).send({ dimension: 'VOLUME' }).expect(409)).body.error.code).toBe('INVENTORY_INGREDIENT_LOCKED');
    await http().patch(`/v1/inventory/ingredients/${rice.id}`).set(auth(r.token)).send({ isActive: false }).expect(200);
    expect((await http().get('/v1/inventory/ingredients').set(auth(r.token)).expect(200)).body).toEqual([]);
    expect((await http().get('/v1/inventory/ingredients?includeInactive=true').set(auth(r.token)).expect(200)).body[0]).toMatchObject({ id: rice.id, isActive: false, usedIn: 1 });

    // Suppliers: list with counts; one without purchases is deleted (its ingredients lose the preference).
    expect((await http().get('/v1/inventory/suppliers').set(auth(r.token)).expect(200)).body[0]).toMatchObject({ id: supplier.id, ingredients: 1 });
    await http().patch(`/v1/inventory/suppliers/${supplier.id}`).set(auth(r.token)).send({ phone: '0225550000' }).expect(200);
    await http().delete(`/v1/inventory/suppliers/${supplier.id}`).set(auth(r.token)).expect(204);
    expect((await http().get('/v1/inventory/ingredients?includeInactive=true').set(auth(r.token)).expect(200)).body[0].preferredSupplier).toBeNull();

    // Another restaurant sees none of it and cannot touch it.
    const other = await chain('other@grill.test', 'grill');
    expect((await http().get('/v1/inventory/ingredients?includeInactive=true').set(auth(other.token)).expect(200)).body).toEqual([]);
    await http().patch(`/v1/inventory/ingredients/${rice.id}`).set(auth(other.token)).send({ nameEn: 'Mine' }).expect(404);
    await http().delete(`/v1/inventory/ingredients/${rice.id}`).set(auth(other.token)).expect(404);
    await http().get(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(other.token)).expect(404);
    await http().put(`/v1/inventory/recipes/variants/${other.koshary.small}`).set(auth(other.token)).send({ lines: [{ ingredientId: rice.id, quantity: 1 }] }).expect(404);
    await http().get(`/v1/inventory/stock?branchId=${r.mainId}`).set(auth(other.token)).expect(404);
  });
});

describe('inventory: purchases and weighted average cost', () => {
  it('receives purchases into stock at a weighted average, and a void reverses one', async () => {
    const r = await stocked();
    // Two 25 kg sacks at EGP 750: 50,000 g at 3 piastres a gram.
    expect(r.purchase).toMatchObject({ status: 'RECEIVED', total: 150_000, supplier: { id: r.supplier.id, name: 'Gomla Market' }, invoiceNumber: 'INV-1' });
    expect(r.purchase.lines[0]).toMatchObject({ unitNameAr: 'شيكارة 25 كيلو', unitNameEn: null, factor: 25_000, quantity: 2, baseQuantity: 50_000, unitPrice: 75_000, lineTotal: 150_000, unitCost: 3 });
    expect((await stock(r.token, r.mainId))[r.ids.rice]).toMatchObject({ onHand: 50_000, avgCost: 3, value: 150_000, status: 'OK' });

    // A draft (by line total, in kg) is edited, then received: 10 kg at EGP 40/kg.
    const draft = await http().post('/v1/inventory/purchases').set(auth(r.token))
      .send({ supplierId: r.supplier.id, lines: [{ ingredientId: r.ids.rice, unitId: r.rice.units[0].id, quantity: 5, lineTotal: 20_000 }] }).expect(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', branchId: r.mainId, total: 20_000 });
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(50_000);
    const edited = await http().patch(`/v1/inventory/purchases/${draft.body.id}`).set(auth(r.token))
      .send({ invoiceNumber: 'INV-2', lines: [{ ingredientId: r.ids.rice, unitId: r.rice.units[0].id, quantity: 10, lineTotal: 40_000 }] }).expect(200);
    expect(edited.body.lines[0]).toMatchObject({ baseQuantity: 10_000, unitPrice: 4000, unitCost: 4 });
    await http().post(`/v1/inventory/purchases/${draft.body.id}/receive`).set(auth(r.token)).expect(200);
    // (50,000 × 3 + 10,000 × 4) / 60,000 = 3.16667 → 3.1667.
    expect((await stock(r.token, r.mainId))[r.ids.rice]).toMatchObject({ onHand: 60_000, avgCost: 3.1667 });
    // Received: no more edits, no second receive.
    expect((await http().patch(`/v1/inventory/purchases/${draft.body.id}`).set(auth(r.token)).send({ note: 'late' }).expect(409)).body.error.code).toBe('INVENTORY_PURCHASE_STATUS');
    await http().post(`/v1/inventory/purchases/${draft.body.id}/receive`).set(auth(r.token)).expect(409);

    // Voiding takes it back at its own cost: the average returns to 3.
    const voided = await http().post(`/v1/inventory/purchases/${draft.body.id}/void`).set(auth(r.token)).send({ reason: 'Wrong invoice' }).expect(200);
    expect(voided.body).toMatchObject({ status: 'VOID', voidReason: 'Wrong invoice' });
    expect((await stock(r.token, r.mainId))[r.ids.rice]).toMatchObject({ onHand: 50_000, avgCost: 3 });
    await http().post(`/v1/inventory/purchases/${draft.body.id}/void`).set(auth(r.token)).send({ reason: 'Again' }).expect(409);
    await http().post(`/v1/inventory/purchases/${draft.body.id}/receive`).set(auth(r.token)).expect(409);

    const ledger = await http().get(`/v1/inventory/movements?ingredientId=${r.ids.rice}`).set(auth(r.token)).expect(200);
    expect(ledger.body.total).toBe(3);
    expect(ledger.body.items.map((row: { type: string; quantity: number; value: number }) => [row.type, row.quantity, row.value]).sort()).toEqual([
      ['PURCHASE', 10_000, 40_000], ['PURCHASE', 50_000, 150_000], ['PURCHASE_VOID', -10_000, -40_000],
    ]);
    expect(ledger.body.items.find((row: { type: string }) => row.type === 'PURCHASE_VOID').source).toMatchObject({ kind: 'PURCHASE', id: draft.body.id, label: 'INV-2' });
    const list = await http().get('/v1/inventory/purchases?status=VOID').set(auth(r.token)).expect(200);
    expect(list.body).toMatchObject({ total: 1, items: [{ id: draft.body.id, lineCount: 1 }] });

    // Lines need a price or a total (not both), a unit of the ingredient, and a raw ingredient.
    const line = { ingredientId: r.ids.rice, quantity: 1 };
    for (const lines of [[line], [{ ...line, unitPrice: 1, lineTotal: 1 }], [{ ...line, quantity: 0, unitPrice: 1 }], [{ ...line, unitPrice: -1 }]]) {
      await http().post('/v1/inventory/purchases').set(auth(r.token)).send({ lines }).expect(400);
    }
    expect((await http().post('/v1/inventory/purchases').set(auth(r.token)).send({ lines: [{ ...line, unitId: r.purchase.lines[0].id, unitPrice: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_UNIT_NOT_FOUND');
    expect((await http().post('/v1/inventory/purchases').set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.sauce, quantity: 1, unitPrice: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_NOT_RAW');
    // The supplier has purchases now: archive, not delete.
    expect((await http().delete(`/v1/inventory/suppliers/${r.supplier.id}`).set(auth(r.token)).expect(409)).body.error.code).toBe('INVENTORY_SUPPLIER_IN_USE');
    expect((await http().delete(`/v1/inventory/ingredients/${r.ids.rice}`).set(auth(r.token)).expect(409)).body.error.code).toBe('INVENTORY_INGREDIENT_IN_USE');
  });

  it('posts a purchase once when it is received twice at the same moment', async () => {
    const r = await stocked();
    const draft = await http().post('/v1/inventory/purchases').set(auth(r.token))
      .send({ lines: [{ ingredientId: r.ids.lentils, unitId: null, quantity: 5000, unitPrice: 5 }, { ingredientId: r.ids.tomato, quantity: 8000, lineTotal: 9600 }] }).expect(201);
    const results = await Promise.all([1, 2, 3].map(() => http().post(`/v1/inventory/purchases/${draft.body.id}/receive`).set(auth(r.token))));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    expect(await t.prisma.stockMovement.count({ where: { purchaseId: draft.body.id } })).toBe(2);
    const rows = await stock(r.token, r.mainId);
    expect(rows[r.ids.lentils]).toMatchObject({ onHand: 5000, avgCost: 5 });
    expect(rows[r.ids.tomato]).toMatchObject({ onHand: 8000, avgCost: 1.2 });
  });
});

describe('inventory: recipes and costing', () => {
  it('costs dish sizes through prepared sub-recipes, per branch and at the branch price', async () => {
    const r = await stocked();
    // Small koshary at the main branch: rice 150 × 3 + lentils 50 × 6 (standard) + sauce 100 g (tomato 120 × 1.5 + oil 5 × 9) = 975.
    const recipe = await http().get(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token)).expect(200);
    expect(recipe.body).toMatchObject({ variantId: r.koshary.small, itemNameAr: 'كشري', variantNameAr: 'صغير', branchId: r.mainId });
    expect(recipe.body.lines.map((line: { nameAr: string; usage: number; unitCost: number; cost: number }) => [line.nameAr, line.usage, line.unitCost, line.cost])).toEqual([
      ['رز', 150, 3, 450], ['عدس', 50, 6, 300], ['صلصة طماطم', 100, 2.25, 225],
    ]);
    // Nasr City never received rice (standard cost 2.5) and sells the small size at 40 EGP.
    await http().put(`/v1/branches/${r.nasrId}/menu/items/${r.koshary.id}`).set(auth(r.token)).send({ prices: [{ variantId: r.koshary.small, pricePiastres: 4000 }] }).expect(200);
    const again = await http().get(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token)).expect(200);
    expect(again.body.costs).toEqual([
      { branchId: r.mainId, branchName: expect.any(String), pricePiastres: 3500, cost: 975, foodCostPercent: 27.86 },
      { branchId: r.nasrId, branchName: 'Nasr City', pricePiastres: 4000, cost: 900, foodCostPercent: 22.5 },
    ]);

    // Waste % applies: 250 g of rice with 10% trim uses 277.778 g.
    const large = await http().get(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token)).expect(200);
    expect(large.body.lines[0]).toMatchObject({ quantity: 250, wastePercent: 10, usage: 277.778 });

    const costing = await http().get('/v1/inventory/costing').set(auth(r.token)).expect(200);
    expect(costing.body.branchId).toBe(r.mainId);
    const bySize = Object.fromEntries(costing.body.rows.map((row: { variantId: string }) => [row.variantId, row]));
    expect(bySize[r.koshary.small]).toMatchObject({ hasRecipe: true, pricePiastres: 3500, recipeCost: 975, foodCostPercent: 27.86, marginPiastres: 2525, incomplete: false, variantNameAr: 'صغير' });
    expect(bySize[r.lemonade.variant]).toMatchObject({ hasRecipe: true, recipeCost: 200, foodCostPercent: 10, variantNameAr: null });
    expect(costing.body.summary).toMatchObject({ sizes: 3, withRecipe: 3 });
    const atNasr = await http().get(`/v1/inventory/costing?branchId=${r.nasrId}`).set(auth(r.token)).expect(200);
    expect(atNasr.body.rows.find((row: { variantId: string }) => row.variantId === r.koshary.small)).toMatchObject({ pricePiastres: 4000, recipeCost: 900, foodCostPercent: 22.5, marginPiastres: 3100 });

    // An empty list removes a recipe.
    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [] }).expect(200);
    expect((await http().get('/v1/inventory/costing').set(auth(r.token)).expect(200)).body.rows.find((row: { variantId: string }) => row.variantId === r.lemonade.variant))
      .toMatchObject({ hasRecipe: false, recipeCost: null, foodCostPercent: null });
  });

  it('refuses recipe cycles, nesting beyond three levels, duplicates and waste over 90%', async () => {
    const r = await stocked();
    const base = await ingredient(r.token, { nameAr: 'قاعدة', kind: 'PREPARED', dimension: 'MASS' });
    // base uses the sauce; the sauce cannot then use base.
    await http().put(`/v1/inventory/ingredients/${base.id}/recipe`).set(auth(r.token)).send({ yieldQuantity: 500, lines: [{ ingredientId: r.ids.sauce, quantity: 400 }] }).expect(200);
    const cycle = await http().put(`/v1/inventory/ingredients/${r.ids.sauce}/recipe`).set(auth(r.token))
      .send({ yieldQuantity: 1000, lines: [{ ingredientId: r.ids.tomato, quantity: 1200 }, { ingredientId: base.id, quantity: 10 }] }).expect(400);
    expect(cycle.body.error).toMatchObject({ code: 'RECIPE_CYCLE', details: { path: [r.ids.sauce, base.id, r.ids.sauce] } });
    expect((await http().put(`/v1/inventory/ingredients/${base.id}/recipe`).set(auth(r.token)).send({ yieldQuantity: 1, lines: [{ ingredientId: base.id, quantity: 1 }] }).expect(400)).body.error.code).toBe('RECIPE_CYCLE');

    // sauce (1) ← base (2) ← top (3) ← deeper (4): the fourth level is refused.
    const top = await ingredient(r.token, { nameAr: 'طبقة', kind: 'PREPARED', dimension: 'MASS' });
    await http().put(`/v1/inventory/ingredients/${top.id}/recipe`).set(auth(r.token)).send({ yieldQuantity: 100, lines: [{ ingredientId: base.id, quantity: 100 }] }).expect(200);
    const deeper = await ingredient(r.token, { nameAr: 'أعمق', kind: 'PREPARED', dimension: 'MASS' });
    expect((await http().put(`/v1/inventory/ingredients/${deeper.id}/recipe`).set(auth(r.token)).send({ yieldQuantity: 100, lines: [{ ingredientId: top.id, quantity: 100 }] }).expect(400)).body.error.code).toBe('RECIPE_TOO_DEEP');
    // A dish may use the third level.
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token)).send({ lines: [{ ingredientId: top.id, quantity: 50 }] }).expect(200);

    const dup = await http().put(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, quantity: 1 }, { ingredientId: r.ids.rice, quantity: 2 }] }).expect(400);
    expect(dup.body.error.code).toBe('INVENTORY_DUPLICATE_LINE');
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, quantity: 1, wastePercent: 91 }] }).expect(400);
    await http().put(`/v1/inventory/ingredients/${r.ids.sauce}/recipe`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.tomato, quantity: 1 }] }).expect(400); // no yield
  });
});

describe('inventory: permissions and branches', () => {
  it('lets the kitchen record waste and see quantities but not receive purchases or see costs', async () => {
    const r = await stocked();
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    const rows = await stock(kitchen.token, r.mainId);
    expect(rows[r.ids.rice]).toMatchObject({ onHand: 50_000, avgCost: null, value: null });
    const ingredients = (await http().get('/v1/inventory/ingredients').set(auth(kitchen.token)).expect(200)).body;
    expect(ingredients.find((row: { id: string }) => row.id === r.ids.rice)).toMatchObject({ standardCost: null, currentCost: null });
    const recipe = (await http().get(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(kitchen.token)).expect(200)).body;
    expect(recipe.costs).toBeNull();
    expect(recipe.lines[0]).toMatchObject({ usage: 150, unitCost: null, cost: null });
    const ledger = (await http().get('/v1/inventory/movements').set(auth(kitchen.token)).expect(200)).body;
    expect(ledger.items[0]).toMatchObject({ type: 'PURCHASE', quantity: 50_000, unitCost: null, value: null });
    expect((await http().get(`/v1/inventory/purchases/${r.purchase.id}`).set(auth(kitchen.token)).expect(200)).body).toMatchObject({ total: null, lines: [{ unitPrice: null, lineTotal: null, unitCost: null }] });

    const waste = await http().post('/v1/inventory/waste').set(auth(kitchen.token)).send({ reason: 'SPOILED', note: 'Wet sack', lines: [{ ingredientId: r.ids.rice, unitId: r.rice.units[0].id, quantity: 1 }] }).expect(201);
    expect(waste.body).toMatchObject({ reason: 'SPOILED', total: null, lines: [{ ingredientId: r.ids.rice, quantity: 1000, unitNameAr: 'كيلو', unitNameEn: null, value: null }] });

    for (const [method, path, body] of [
      ['post', '/v1/inventory/purchases', { lines: [{ ingredientId: r.ids.rice, quantity: 1, unitPrice: 1 }] }],
      ['post', `/v1/inventory/purchases/${r.purchase.id}/void`, { reason: 'Nope nope' }],
      ['post', '/v1/inventory/counts', {}],
      ['post', '/v1/inventory/transfers', { toBranchId: r.nasrId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }],
      ['post', '/v1/inventory/ingredients', { nameAr: 'ملح', dimension: 'MASS' }],
      ['put', '/v1/inventory/settings', { enabled: false, autoSoldOut: false }],
      ['get', '/v1/inventory/costing', undefined],
      ['get', '/v1/inventory/reports/valuation', undefined],
      ['get', '/v1/inventory/reports/menu-engineering', undefined],
    ] as const) {
      await http()[method](path).set(auth(kitchen.token)).send(body).expect(403);
    }
    // The reorder list is for the kitchen too (without costs).
    await http().patch(`/v1/inventory/stock/${r.ids.rice}?branchId=${r.mainId}`).set(auth(r.token)).send({ reorderPoint: 60_000, parLevel: 100_000 }).expect(200);
    const reorder = (await http().get('/v1/inventory/reports/reorder').set(auth(kitchen.token)).expect(200)).body;
    expect(reorder.groups[0]).toMatchObject({ estimatedCost: null, lines: [{ ingredientId: r.ids.rice, estimatedCost: null }] });
    // A cashier has no inventory at all.
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await http().get(`/v1/inventory/stock?branchId=${r.mainId}`).set(auth(cashier.token)).expect(403);
  });

  it('keeps a branch-tied manager to their branch', async () => {
    const r = await stocked();
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test', { branchId: r.nasrId });
    // Their own branch by default; the main branch is refused, another restaurant's unknown.
    expect((await http().get('/v1/inventory/stock').set(auth(manager.token)).expect(200)).body.branchId).toBe(r.nasrId);
    expect((await http().get(`/v1/inventory/stock?branchId=${r.mainId}`).set(auth(manager.token)).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    await http().get(`/v1/inventory/purchases/${r.purchase.id}`).set(auth(manager.token)).expect(404);
    expect((await http().get('/v1/inventory/purchases').set(auth(manager.token)).expect(200)).body.total).toBe(0);
    await http().post(`/v1/inventory/purchases/${r.purchase.id}/void`).set(auth(manager.token)).send({ reason: 'Not mine' }).expect(404);
    expect((await http().post('/v1/inventory/purchases').set(auth(manager.token)).send({ branchId: r.mainId, lines: [{ ingredientId: r.ids.rice, quantity: 1, unitPrice: 1 }] }).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    // A manager sees costs and operates, but does not manage the catalogue unless granted.
    const own = await http().post('/v1/inventory/purchases').set(auth(manager.token)).send({ receive: true, lines: [{ ingredientId: r.ids.lentils, unitId: null, quantity: 2000, unitPrice: 7 }] }).expect(201);
    expect(own.body).toMatchObject({ branchId: r.nasrId, status: 'RECEIVED', total: 14_000 });
    await http().post('/v1/inventory/ingredients').set(auth(manager.token)).send({ nameAr: 'ملح', dimension: 'MASS' }).expect(403);
    await http().patch(`/v1/kitchen-accounts/${manager.id}`).set(auth(r.token)).send({ permissions: ['inventory.manage'] }).expect(200);
    await http().post('/v1/inventory/ingredients').set(auth(manager.token)).send({ nameAr: 'ملح', dimension: 'MASS' }).expect(201);
    // Transfers only out of their branch (to any branch of the restaurant).
    expect((await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ fromBranchId: r.mainId, toBranchId: r.nasrId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    const transfer = await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ toBranchId: r.mainId, lines: [{ ingredientId: r.ids.lentils, quantity: 500 }] }).expect(201);
    expect(transfer.body).toMatchObject({ fromBranch: { id: r.nasrId }, toBranch: { id: r.mainId }, total: 3500, lines: [{ quantity: 500, unitCost: 7, value: 3500 }] });
    const other = await chain('other@grill.test', 'grill');
    await http().post('/v1/inventory/transfers').set(auth(manager.token)).send({ toBranchId: other.mainId, lines: [{ ingredientId: r.ids.lentils, quantity: 1 }] }).expect(404);
    await http().get(`/v1/inventory/stock?branchId=${other.mainId}`).set(auth(manager.token)).expect(404);
  });

  it('never sends stock into an archived branch', async () => {
    const r = await stocked();
    await http().patch(`/v1/branches/${r.nasrId}`).set(auth(r.token)).send({ isActive: false }).expect(200);
    const refused = await http()
      .post('/v1/inventory/transfers')
      .set(auth(r.token))
      .send({ fromBranchId: r.mainId, toBranchId: r.nasrId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] })
      .expect(409);
    expect(refused.body.error.code).toBe('BRANCH_ARCHIVED');
  });
});
