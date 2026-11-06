import { auth, fixtures } from './inventory-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
const { http, chain, stocked, place, setStatus, staff, stock, movements } = fixtures(() => t);

const settings = (token: string, body: Record<string, unknown>) => http().put('/v1/inventory/settings').set(auth(token)).send(body);
const moveItems = (token: string, orderId: string, itemIds: string[], status: string) => http().patch(`/v1/orders/${orderId}/items/status`).set(auth(token)).send({ itemIds, status });
const items = (orderId: string) => t.prisma.orderItem.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' } });
const placeRaw = (subdomain: string, items: { menuItemId: string; variantId: string; quantity: number }[], branch?: string) =>
  http().post(`/v1/public/restaurants/${subdomain}/orders`).set('Idempotency-Key', crypto.randomUUID())
    .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items, ...(branch && { branch }) });

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('inventory settings', () => {
  it('starts from sensible defaults, changes only what is sent, and validates', async () => {
    const r = await chain();
    const initial = (await http().get('/v1/inventory/settings').set(auth(r.token)).expect(200)).body;
    expect(initial).toMatchObject({
      enabled: false, deductOn: 'ACCEPTED', stockPolicy: 'ALLOW_NEGATIVE', autoSoldOut: true, autoRestore: true, valuationBasis: 'AVERAGE',
      requireCountApproval: false, countVarianceThresholdPercent: 10, updatedAt: null,
    });
    expect(initial.wasteReasons.map((reason: { code: string }) => reason.code)).toEqual(['EXPIRED', 'SPOILED', 'DROPPED', 'OVERCOOKED', 'STAFF_MEAL', 'COMPLIMENTARY', 'OTHER']);
    expect(initial.branches).toEqual([
      expect.objectContaining({ branchId: r.mainId, stockPolicy: null, autoSoldOut: null, effective: { stockPolicy: 'ALLOW_NEGATIVE', autoSoldOut: true, autoRestore: true } }),
      expect.objectContaining({ branchId: r.nasrId, stockPolicy: null }),
    ]);

    const changed = await settings(r.token, { deductOn: 'READY', countVarianceThresholdPercent: 7.5, branches: [{ branchId: r.nasrId, stockPolicy: 'BLOCK_ORDERS' }] }).expect(200);
    expect(changed.body).toMatchObject({ enabled: false, deductOn: 'READY', stockPolicy: 'ALLOW_NEGATIVE', countVarianceThresholdPercent: 7.5 });
    expect(changed.body.branches[1]).toMatchObject({ branchId: r.nasrId, stockPolicy: 'BLOCK_ORDERS', autoSoldOut: null, effective: { stockPolicy: 'BLOCK_ORDERS', autoSoldOut: true } });
    // A branch override set back to all-null follows the restaurant again.
    const cleared = await settings(r.token, { branches: [{ branchId: r.nasrId }] }).expect(200);
    expect(cleared.body.branches[1]).toMatchObject({ stockPolicy: null, effective: { stockPolicy: 'ALLOW_NEGATIVE' } });

    for (const body of [
      { deductOn: 'PLACED' },
      { stockPolicy: 'MAYBE' },
      { wasteReasons: [] },
      { wasteReasons: [{ code: 'A', nameAr: 'أ' }, { code: 'a', nameAr: 'ب' }] },
      { wasteReasons: Array.from({ length: 21 }, (_, index) => ({ code: `R${index}`, nameAr: `سبب ${index}` })) },
      { countVarianceThresholdPercent: -1 },
      { unknown: true },
    ]) {
      await settings(r.token, body).expect(400);
    }
    const other = await chain('other@grill.test', 'grill');
    await settings(r.token, { branches: [{ branchId: other.mainId, stockPolicy: 'WARN' }] }).expect(404);
  });
});

describe('inventory settings: when stock is deducted', () => {
  it('deducts on READY: not on acceptance, once when ready (even straight from accepted), nothing to reverse before', async () => {
    const r = await stocked();
    await settings(r.token, { deductOn: 'READY' }).expect(200);
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);
    await setStatus(r.token, orderId, 'PREPARING').expect(200);
    expect(await movements(orderId)).toEqual([]);
    await setStatus(r.token, orderId, 'READY').expect(200);
    expect((await movements(orderId)).length).toBe(4);
    expect((await items(orderId))[0]!.costPiastres).toBe(975);
    await setStatus(r.token, orderId, 'COMPLETED').expect(200);
    expect((await movements(orderId)).length).toBe(4);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).stockDeductedAt).not.toBeNull();

    // Accepted → ready in one step.
    const jump = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, jump, 'ACCEPTED').expect(200);
    await setStatus(r.token, jump, 'READY').expect(200);
    expect((await movements(jump)).length).toBe(4);

    // Cancelled before the deduction point: nothing was taken, nothing comes back.
    const early = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, early, 'ACCEPTED').expect(200);
    await setStatus(r.token, early, 'CANCELLED').expect(200);
    expect(await movements(early)).toEqual([]);

    // A dish cancelled on the kitchen display before ready is not reversed (never deducted), nor deducted later.
    const mixed = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }, { menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 1 }]);
    const [small, large] = await items(mixed);
    await setStatus(r.token, mixed, 'ACCEPTED').expect(200);
    await moveItems(r.token, mixed, [large!.id], 'CANCELLED').expect(200);
    expect(await movements(mixed)).toEqual([]);
    await moveItems(r.token, mixed, [small!.id], 'READY').expect(200);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: mixed } })).status).toBe('READY');
    const taken = await movements(mixed);
    expect(taken.length).toBe(4);
    expect(taken.every((row) => row.orderItemId === small!.id && row.type === 'SALE')).toBe(true);
  });

  it('deducts on COMPLETED, also when the kitchen display completes the order by cascade', async () => {
    const r = await stocked();
    await settings(r.token, { deductOn: 'COMPLETED' }).expect(200);
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 2 }]);
    const [line] = await items(orderId);
    await moveItems(r.token, orderId, [line!.id], 'READY').expect(200);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY');
    expect(await movements(orderId)).toEqual([]);
    await moveItems(r.token, orderId, [line!.id], 'SERVED').expect(200);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
    expect((await movements(orderId)).length).toBe(4);
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(49_700);
  });
});

describe('inventory settings: stock policy', () => {
  it('BLOCK_ORDERS refuses dishes the branch cannot cover, and places them once stocked', async () => {
    const r = await stocked();
    await settings(r.token, { stockPolicy: 'BLOCK_ORDERS' }).expect(200);
    // The main branch has rice but no lentils, tomatoes, oil or lemons yet.
    const refused = await placeRaw(r.subdomain, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }, { menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }]).expect(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(refused.body.error.details.menuItemIds.sort()).toEqual([r.koshary.id, r.lemonade.id].sort());

    await http().post('/v1/inventory/purchases').set(auth(r.token)).send({
      receive: true,
      lines: [{ ingredientId: r.ids.lentils, quantity: 1000, unitPrice: 6 }, { ingredientId: r.ids.tomato, quantity: 2000, unitPrice: 1.5 }, { ingredientId: r.ids.oil, quantity: 1000, unitPrice: 9 }],
    }).expect(201);
    await placeRaw(r.subdomain, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 2 }]).expect(201);
    // The whole order counts: 30 small need 1500 g of lentils.
    expect((await placeRaw(r.subdomain, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 30 }]).expect(409)).body.error.details.menuItemIds).toEqual([r.koshary.id]);
    // A dish without a recipe is never blocked; neither is anything while inventory is off.
    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [] }).expect(200);
    await placeRaw(r.subdomain, [{ menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }]).expect(201);
    await settings(r.token, { enabled: false }).expect(200);
    await placeRaw(r.subdomain, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 30 }]).expect(201);
  });

  it('applies a branch’s own policy, and WARN places the order but flags it on the board and the low-stock report', async () => {
    const r = await stocked();
    await settings(r.token, { stockPolicy: 'WARN', branches: [{ branchId: r.nasrId, stockPolicy: 'BLOCK_ORDERS' }] }).expect(200);
    expect((await placeRaw(r.subdomain, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }], 'nasr-city').expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');

    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    const order = await http().get(`/v1/orders/${orderId}`).set(auth(r.token)).expect(200);
    expect(order.body.lowStockItemIds).toEqual([r.koshary.id]);
    const board = await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200);
    expect(board.body.items.find((row: { id: string }) => row.id === orderId).lowStockItemIds).toEqual([r.koshary.id]);

    const report = await http().get('/v1/inventory/reports/low-stock').set(auth(r.token)).expect(200);
    expect(report.body.branchId).toBe(r.mainId);
    expect(report.body.warnedOrders).toEqual([expect.objectContaining({ orderId, items: [{ menuItemId: r.koshary.id, nameAr: 'كشري', nameEn: null }] })]);
    expect(report.body.rows.map((row: { ingredientId: string }) => row.ingredientId)).toEqual(expect.arrayContaining([r.ids.lentils, r.ids.tomato, r.ids.oil]));
    expect(report.body.rows.map((row: { ingredientId: string }) => row.ingredientId)).not.toContain(r.ids.rice);

    // Covered dishes carry no flag.
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, quantity: 250 }] }).expect(200);
    const fine = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 1 }]);
    expect((await http().get(`/v1/orders/${fine}`).set(auth(r.token)).expect(200)).body.lowStockItemIds).toEqual([]);
  });
});

describe('inventory settings: sold out, waste reasons, counts, valuation', () => {
  it('leaves inventory’s sold-out marks after restock when autoRestore is off (per branch too)', async () => {
    const r = await stocked();
    await settings(r.token, { autoSoldOut: true, autoRestore: false }).expect(200);
    const lemons = (quantity: number) => http().post('/v1/inventory/purchases').set(auth(r.token)).send({ receive: true, lines: [{ ingredientId: r.ids.lemons, quantity, unitPrice: 250 }] }).expect(201);
    const override = async () => (await http().get(`/v1/branches/${r.mainId}/menu`).set(auth(r.token)).expect(200)).body.categories[0].items.find((item: { id: string }) => item.id === r.lemonade.id).override;
    await lemons(1);
    const orderId = await place(r, [{ menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }]);
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);
    expect(await override()).toMatchObject({ available: false, soldOutByInventory: true });
    await lemons(5);
    expect(await override()).toMatchObject({ available: false, soldOutByInventory: true });
    // The main branch restores on its own: the next restock lifts the mark.
    await settings(r.token, { branches: [{ branchId: r.mainId, autoRestore: true }] }).expect(200);
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lemons, quantity: 5 }] }).expect(201);
    await lemons(2);
    expect(await override()).toMatchObject({ available: null, soldOutByInventory: false });
    // Turning inventory off lifts any mark it set.
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lemons, quantity: 2 }] }).expect(201);
    expect(await override()).toMatchObject({ soldOutByInventory: true });
    await settings(r.token, { enabled: false }).expect(200);
    expect(await override()).toMatchObject({ available: null, soldOutByInventory: false });
  });

  it('uses the restaurant’s own waste reasons and keeps their names on past entries', async () => {
    const r = await stocked();
    const saved = await settings(r.token, { wasteReasons: [{ code: 'BURNT', nameAr: 'اتحرق', nameEn: 'Burnt' }, { code: 'tasting', nameAr: 'تذوق' }] }).expect(200);
    expect(saved.body.wasteReasons).toEqual([{ code: 'BURNT', nameAr: 'اتحرق', nameEn: 'Burnt' }, { code: 'TASTING', nameAr: 'تذوق', nameEn: null }]);
    const refused = await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.rice, quantity: 10 }] }).expect(400);
    expect(refused.body.error).toMatchObject({ code: 'INVENTORY_WASTE_REASON_UNKNOWN', details: { reason: 'SPOILED' } });
    const entry = await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'burnt', lines: [{ ingredientId: r.ids.rice, quantity: 10 }] }).expect(201);
    expect(entry.body).toMatchObject({ reason: 'BURNT', reasonNameAr: 'اتحرق', reasonNameEn: 'Burnt', total: 30 });
    await settings(r.token, { wasteReasons: [{ code: 'BURNT', nameAr: 'محروق' }] }).expect(200);
    const list = await http().get('/v1/inventory/waste?reason=BURNT').set(auth(r.token)).expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: entry.body.id, reasonNameAr: 'اتحرق' })]);
  });

  it('sends counts off by more than the threshold for approval when the settings ask for it', async () => {
    const r = await stocked();
    await settings(r.token, { requireCountApproval: true, countVarianceThresholdPercent: 5 }).expect(200);
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    const count = (await http().post('/v1/inventory/counts').set(auth(manager.token)).send({ ingredientIds: [r.ids.rice, r.ids.lentils] }).expect(201)).body;
    // Rice 2% short (within 5%); 100 g of lentils where none were expected.
    await http().patch(`/v1/inventory/counts/${count.id}`).set(auth(manager.token)).send({ lines: [{ ingredientId: r.ids.rice, counted: 49_000 }, { ingredientId: r.ids.lentils, counted: 100 }] }).expect(200);
    const pending = await http().post(`/v1/inventory/counts/${count.id}/post`).set(auth(manager.token)).expect(200);
    expect(pending.body).toMatchObject({ status: 'PENDING_APPROVAL', submittedBy: expect.any(String), postedAt: null });
    expect(Object.fromEntries(pending.body.lines.map((line: { ingredientId: string; overThreshold: boolean }) => [line.ingredientId, line.overThreshold]))).toEqual({ [r.ids.rice]: false, [r.ids.lentils]: true });
    expect(await t.prisma.stockMovement.count({ where: { countId: count.id } })).toBe(0);
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(50_000);
    // Waiting: no edits, no second count, and the manager cannot approve.
    await http().patch(`/v1/inventory/counts/${count.id}`).set(auth(manager.token)).send({ lines: [] }).expect(409);
    expect((await http().post('/v1/inventory/counts').set(auth(manager.token)).send({}).expect(409)).body.error.code).toBe('INVENTORY_COUNT_ALREADY_OPEN');
    await http().post(`/v1/inventory/counts/${count.id}/approve`).set(auth(manager.token)).send({}).expect(403);

    // Sent back by the owner, recounted, and posted straight away once within the threshold.
    const back = await http().post(`/v1/inventory/counts/${count.id}/reject`).set(auth(r.token)).send({ note: 'Count the lentils again' }).expect(200);
    expect(back.body).toMatchObject({ status: 'OPEN', reviewNote: 'Count the lentils again' });
    await http().patch(`/v1/inventory/counts/${count.id}`).set(auth(manager.token)).send({ lines: [{ ingredientId: r.ids.lentils, counted: 0 }] }).expect(200);
    expect((await http().post(`/v1/inventory/counts/${count.id}/post`).set(auth(manager.token)).expect(200)).body.status).toBe('POSTED');
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(49_000);
    expect((await http().post(`/v1/inventory/counts/${count.id}/approve`).set(auth(r.token)).send({}).expect(409)).body.error.code).toBe('INVENTORY_COUNT_NOT_PENDING');

    // A big variance approved by the owner changes stock then.
    const second = (await http().post('/v1/inventory/counts').set(auth(manager.token)).send({ ingredientIds: [r.ids.rice] }).expect(201)).body;
    await http().patch(`/v1/inventory/counts/${second.id}`).set(auth(manager.token)).send({ lines: [{ ingredientId: r.ids.rice, counted: 40_000 }] }).expect(200);
    expect((await http().post(`/v1/inventory/counts/${second.id}/post`).set(auth(manager.token)).expect(200)).body.status).toBe('PENDING_APPROVAL');
    const approved = await http().post(`/v1/inventory/counts/${second.id}/approve`).set(auth(r.token)).send({ note: 'Bags were spilt' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'POSTED', reviewNote: 'Bags were spilt', varianceValue: -27_000 });
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(40_000);

    // Granted inventory.approve, the manager's own big variance posts directly.
    await http().patch(`/v1/kitchen-accounts/${manager.id}`).set(auth(r.token)).send({ permissions: ['inventory.approve'] }).expect(200);
    const third = (await http().post('/v1/inventory/counts').set(auth(manager.token)).send({ ingredientIds: [r.ids.rice] }).expect(201)).body;
    await http().patch(`/v1/inventory/counts/${third.id}`).set(auth(manager.token)).send({ lines: [{ ingredientId: r.ids.rice, counted: 20_000 }] }).expect(200);
    expect((await http().post(`/v1/inventory/counts/${third.id}/post`).set(auth(manager.token)).expect(200)).body.status).toBe('POSTED');
  });

  it('values costing and reports at the standard cost when chosen, and uses default reorder points', async () => {
    const r = await stocked();
    // Average basis: rice at its 3 piastres a gram.
    expect((await http().get('/v1/inventory/reports/valuation').set(auth(r.token)).expect(200)).body.total).toBe(150_000);
    await settings(r.token, { valuationBasis: 'STANDARD' }).expect(200);
    // Standard basis: rice at 2.5.
    expect((await http().get('/v1/inventory/reports/valuation').set(auth(r.token)).expect(200)).body.total).toBe(125_000);
    expect((await stock(r.token, r.mainId))[r.ids.rice]).toMatchObject({ avgCost: 3, value: 125_000 });
    const costing = (await http().get('/v1/inventory/costing').set(auth(r.token)).expect(200)).body;
    expect(costing.rows.find((row: { variantId: string }) => row.variantId === r.koshary.small).recipeCost).toBe(900);

    // A default reorder point applies where a branch has none; the branch's own wins.
    await http().patch(`/v1/inventory/ingredients/${r.ids.tomato}`).set(auth(r.token)).send({ defaultReorderPoint: 2000 }).expect(200);
    await http().patch(`/v1/inventory/ingredients/${r.ids.rice}`).set(auth(r.token)).send({ defaultReorderPoint: 80_000 }).expect(200);
    await http().patch(`/v1/inventory/stock/${r.ids.rice}`).set(auth(r.token)).send({ reorderPoint: 10_000 }).expect(200);
    const rows = await stock(r.token, r.mainId);
    expect(rows[r.ids.tomato]).toMatchObject({ reorderPoint: 2000, reorderPointIsDefault: true, status: 'OUT' });
    expect(rows[r.ids.rice]).toMatchObject({ reorderPoint: 10_000, reorderPointIsDefault: false, status: 'OK' });
    const reorder = (await http().get('/v1/inventory/reports/reorder').set(auth(r.token)).expect(200)).body;
    const lines = reorder.groups.flatMap((group: { lines: unknown[] }) => group.lines);
    expect(lines).toEqual([expect.objectContaining({ ingredientId: r.ids.tomato, onHand: 0, reorderPoint: 2000, suggestedQuantity: 2000, estimatedCost: 3000 })]);
  });
});

describe('inventory settings: granted permissions', () => {
  it('lets the owner grant inventory to any role, and managers pass on only what they hold', async () => {
    const r = await stocked();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await http().get(`/v1/inventory/stock?branchId=${r.mainId}`).set(auth(cashier.token)).expect(403);
    await http().patch(`/v1/kitchen-accounts/${cashier.id}`).set(auth(r.token)).send({ permissions: ['inventory.view'] }).expect(200);
    expect((await stock(cashier.token, r.mainId))[r.ids.rice]).toMatchObject({ onHand: 50_000, avgCost: null, value: null });
    await http().get('/v1/inventory/costing').set(auth(cashier.token)).expect(403);
    await http().post('/v1/inventory/waste').set(auth(cashier.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(403);
    await http().patch(`/v1/kitchen-accounts/${cashier.id}`).set(auth(r.token)).send({ permissions: ['inventory.view', 'inventory.costs'] }).expect(200);
    expect((await stock(cashier.token, r.mainId))[r.ids.rice]).toMatchObject({ avgCost: 3, value: 150_000 });
    await http().get('/v1/inventory/costing').set(auth(cashier.token)).expect(200);

    // A waiter recording waste; the kitchen receiving purchases.
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test', { permissions: ['inventory.waste'] });
    await http().post('/v1/inventory/waste').set(auth(waiter.token)).send({ reason: 'DROPPED', lines: [{ ingredientId: r.ids.rice, quantity: 5 }] }).expect(201);
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test', { permissions: ['inventory.operate'] });
    await http().post('/v1/inventory/purchases').set(auth(kitchen.token)).send({ receive: true, lines: [{ ingredientId: r.ids.lentils, quantity: 1000, unitPrice: 6 }] }).expect(201);

    // A manager may grant the inventory permissions they hold, not inventory.manage.
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    await http().patch(`/v1/kitchen-accounts/${cashier.id}`).set(auth(manager.token)).send({ permissions: ['inventory.view', 'inventory.waste'] }).expect(200);
    await http().patch(`/v1/kitchen-accounts/${cashier.id}`).set(auth(manager.token)).send({ permissions: ['inventory.manage'] }).expect(403);
  });
});
