import { InventoryOrdersService } from '../src/modules/inventory/inventory-orders.service.js';
import { auth, fixtures } from './inventory-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
const { http, stocked, place, setStatus, staff, stock, movements } = fixtures(() => t);

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const moveItems = (token: string, orderId: string, itemIds: string[], status: string) => http().patch(`/v1/orders/${orderId}/items/status`).set(auth(token)).send({ itemIds, status });
const items = (orderId: string) => t.prisma.orderItem.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' } });
const summary = (rows: { type: string; ingredientId: string; quantity: { toNumber(): number }; value: { toNumber(): number } }[]) =>
  rows.map((row) => [row.type, row.ingredientId, row.quantity.toNumber(), row.value.toNumber()]);

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('inventory: deduction from orders', () => {
  it('deducts recipes when an order is accepted, stores line costs, and reverses once on cancellation', async () => {
    const r = await stocked();
    // The lemonade has no recipe now: it deducts nothing.
    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [] }).expect(200);
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 2 }, { menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }]);
    expect(await movements(orderId)).toEqual([]);
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);

    // 2 small: rice 300 × 3, lentils 100 × 6 (standard), tomato 240 × 1.5 and oil 10 × 9 through the sauce.
    const { ids } = r;
    const expected = [[ids.rice, 300, 900], [ids.lentils, 100, 600], [ids.tomato, 240, 360], [ids.oil, 10, 90]] as const;
    const sold = await movements(orderId);
    expect(summary(sold).sort()).toEqual(expected.map(([id, quantity, value]) => ['SALE', id, -quantity, -value]).sort());
    const [kosharyLine, lemonadeLine] = await items(orderId);
    expect(sold.every((row) => row.orderItemId === kosharyLine!.id && row.sourceKey === `sale:${kosharyLine!.id}:${row.ingredientId}`)).toBe(true);
    expect(kosharyLine!.costPiastres).toBe(1950);
    expect(lemonadeLine!.costPiastres).toBeNull();
    const rows = await stock(r.token, r.mainId);
    expect(rows[ids.rice]).toMatchObject({ onHand: 49_700, avgCost: 3 });
    // Stock may go negative: a sale is never blocked.
    expect(rows[ids.lentils]).toMatchObject({ onHand: -100, status: 'OUT' });
    const ledger = await http().get(`/v1/inventory/movements?type=SALE&ingredientId=${ids.rice}`).set(auth(r.token)).expect(200);
    expect(ledger.body.items[0].source).toMatchObject({ kind: 'ORDER', id: orderId, label: expect.stringMatching(/^#\d+$/) });

    // Cancelled after acceptance: everything back at the cost it left with.
    await setStatus(r.token, orderId, 'CANCELLED').expect(200);
    const after = await movements(orderId);
    expect(summary(after.filter((row) => row.type === 'SALE_REVERSAL')).sort()).toEqual(expected.map(([id, quantity, value]) => ['SALE_REVERSAL', id, quantity, value]).sort());
    expect((await stock(r.token, r.mainId))[ids.rice]).toMatchObject({ onHand: 50_000, avgCost: 3 });
    expect((await stock(r.token, r.mainId))[ids.lentils]!.onHand).toBe(0);

    // Retries change nothing: the status refuses a second cancel, and the reversal itself is idempotent.
    await setStatus(r.token, orderId, 'CANCELLED').expect(409);
    const inventory = t.app.get(InventoryOrdersService);
    await t.prisma.$transaction((tx) => inventory.orderCancelled(tx, orderId));
    await t.prisma.$transaction((tx) => inventory.orderReached(tx, orderId, 'ACCEPTED'));
    expect(await t.prisma.stockMovement.count({ where: { orderId } })).toBe(8);

    // Rejected (never accepted): nothing was deducted.
    const rejected = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, rejected, 'REJECTED').expect(200);
    expect(await movements(rejected)).toEqual([]);

    // Inventory switched off: orders deduct nothing.
    await http().put('/v1/inventory/settings').set(auth(r.token)).send({ enabled: false, autoSoldOut: false }).expect(200);
    const off = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, off, 'ACCEPTED').expect(200);
    expect(await movements(off)).toEqual([]);
  });

  it('follows the kitchen display: a dish started accepts and deducts, a dish cancelled is reversed alone', async () => {
    const r = await stocked();
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }, { menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 1 }]);
    const [small, large] = await items(orderId);
    // Starting a dish of a new order accepts it: both lines are deducted.
    await moveItems(r.token, orderId, [small!.id], 'PREPARING').expect(200);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PREPARING');
    const sold = await movements(orderId);
    expect(new Set(sold.map((row) => row.orderItemId))).toEqual(new Set([small!.id, large!.id]));
    expect(sold.find((row) => row.orderItemId === large!.id && row.ingredientId === r.ids.rice)!.quantity.toNumber()).toBe(-277.778);

    // The large one is cancelled on the screen: only its line comes back.
    await moveItems(r.token, orderId, [large!.id], 'CANCELLED').expect(200);
    const reversed = (await movements(orderId)).filter((row) => row.type === 'SALE_REVERSAL');
    expect(reversed.length).toBe(4);
    expect(reversed.every((row) => row.orderItemId === large!.id)).toBe(true);
    // Then the whole order: the small line too, the large one not twice.
    await setStatus(r.token, orderId, 'CANCELLED').expect(200);
    const all = (await movements(orderId)).filter((row) => row.type === 'SALE_REVERSAL');
    expect(all.filter((row) => row.orderItemId === large!.id).length).toBe(4);
    expect(all.filter((row) => row.orderItemId === small!.id).length).toBe(4);
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(50_000);

    // A dish cancelled before the order is accepted is never deducted.
    const second = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }, { menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 1 }]);
    const [secondSmall, secondLarge] = await items(second);
    await moveItems(r.token, second, [secondLarge!.id], 'CANCELLED').expect(200);
    await setStatus(r.token, second, 'ACCEPTED').expect(200);
    const secondMoves = await movements(second);
    expect(secondMoves.length).toBe(4);
    expect(secondMoves.every((row) => row.orderItemId === secondSmall!.id && row.type === 'SALE')).toBe(true);
    expect((await items(second))[1]!.costPiastres).toBeNull();
  });
});

describe('inventory: waste, counts and transfers', () => {
  it('records waste of ingredients, prepared ingredients and whole dishes at the average cost', async () => {
    const r = await stocked();
    const waste = await http().post('/v1/inventory/waste').set(auth(r.token)).send({
      reason: 'DROPPED', note: 'Tray fell',
      lines: [{ variantId: r.koshary.small, quantity: 2 }, { ingredientId: r.ids.oil, quantity: 500 }, { ingredientId: r.ids.sauce, quantity: 200 }],
    }).expect(201);
    // 2 small = 1950; 500 ml oil × 9 = 4500; 200 g sauce = tomato 240 × 1.5 + oil 10 × 9 = 450.
    expect(waste.body).toMatchObject({ reason: 'DROPPED', note: 'Tray fell', total: 6900 });
    expect(waste.body.lines.map((line: { nameAr: string; quantity: number; value: number }) => [line.nameAr, line.quantity, line.value])).toEqual([
      ['كشري (صغير)', 2, 1950], ['زيت', 500, 4500], ['صلصة طماطم', 200, 450],
    ]);
    const rows = await stock(r.token, r.mainId);
    expect(rows[r.ids.rice]!.onHand).toBe(49_700);
    expect(rows[r.ids.oil]!.onHand).toBe(-520);
    expect((await http().get('/v1/inventory/waste?reason=DROPPED').set(auth(r.token)).expect(200)).body).toMatchObject({ total: 1, items: [{ id: waste.body.id, total: 6900 }] });

    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [] }).expect(200);
    expect((await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'COMPLIMENTARY', lines: [{ variantId: r.lemonade.variant, quantity: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_NO_RECIPE');
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'OOPS', lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(400);
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'OTHER', lines: [] }).expect(400);
  });

  it('counts stock: snapshots expected quantities, takes counted ones from the kitchen, and posts the variance', async () => {
    const r = await stocked();
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.rice, quantity: 300 }] }).expect(201);
    const count = await http().post('/v1/inventory/counts').set(auth(r.token)).send({ category: 'بقالة', note: 'Weekly' }).expect(201);
    expect(count.body).toMatchObject({ status: 'OPEN', branchId: r.mainId, lineCount: 3, countedLines: 0 });
    expect(Object.fromEntries(count.body.lines.map((line: { nameAr: string; expected: number }) => [line.nameAr, line.expected]))).toEqual({ رز: 49_700, عدس: 0, زيت: 0 });
    expect((await http().post('/v1/inventory/counts').set(auth(r.token)).send({}).expect(409)).body.error.code).toBe('INVENTORY_COUNT_ALREADY_OPEN');

    // The kitchen enters what is on the shelf, but does not post.
    const entered = await http().patch(`/v1/inventory/counts/${count.body.id}`).set(auth(kitchen.token))
      .send({ lines: [{ ingredientId: r.ids.rice, counted: 49_000 }, { ingredientId: r.ids.lentils, counted: 0 }] }).expect(200);
    expect(entered.body).toMatchObject({ countedLines: 2, varianceValue: null });
    expect(entered.body.lines.find((line: { ingredientId: string }) => line.ingredientId === r.ids.rice)).toMatchObject({ counted: 49_000, variance: -700, varianceValue: null });
    expect((await http().patch(`/v1/inventory/counts/${count.body.id}`).set(auth(kitchen.token)).send({ lines: [{ ingredientId: r.ids.tomato, counted: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_COUNT_LINE_UNKNOWN');
    await http().post(`/v1/inventory/counts/${count.body.id}/post`).set(auth(kitchen.token)).expect(403);

    // A sale while counting does not distort the variance: counted − expected is booked.
    const orderId = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);
    const posted = await http().post(`/v1/inventory/counts/${count.body.id}/post`).set(auth(r.token)).expect(200);
    expect(posted.body).toMatchObject({ status: 'POSTED', varianceValue: -2100, postedBy: expect.any(String) });
    const variance = await t.prisma.stockMovement.findMany({ where: { countId: count.body.id } });
    expect(summary(variance)).toEqual([['COUNT_VARIANCE', r.ids.rice, -700, -2100]]);
    expect((await stock(r.token, r.mainId))[r.ids.rice]!.onHand).toBe(49_700 - 150 - 700);
    expect((await http().post(`/v1/inventory/counts/${count.body.id}/post`).set(auth(r.token)).expect(409)).body.error.code).toBe('INVENTORY_COUNT_NOT_OPEN');
    await http().patch(`/v1/inventory/counts/${count.body.id}`).set(auth(kitchen.token)).send({ lines: [] }).expect(409);

    // A new count can open now, and be cancelled.
    const next = await http().post('/v1/inventory/counts').set(auth(r.token)).send({ ingredientIds: [r.ids.tomato] }).expect(201);
    expect((await http().post(`/v1/inventory/counts/${next.body.id}/cancel`).set(auth(r.token)).expect(200)).body.status).toBe('CANCELLED');
    await http().post('/v1/inventory/counts').set(auth(r.token)).send({ ingredientIds: [r.ids.sauce] }).expect(400);
    expect((await http().get('/v1/inventory/counts?status=POSTED').set(auth(kitchen.token)).expect(200)).body.total).toBe(1);
  });

  it('transfers stock between branches at the sender’s average cost', async () => {
    const r = await stocked();
    const transfer = await http().post('/v1/inventory/transfers').set(auth(r.token))
      .send({ fromBranchId: r.mainId, toBranchId: r.nasrId, note: 'Weekend rush', lines: [{ ingredientId: r.ids.rice, unitId: r.rice.units[0].id, quantity: 5 }] }).expect(201);
    expect(transfer.body).toMatchObject({ fromBranch: { id: r.mainId }, toBranch: { id: r.nasrId, name: 'Nasr City' }, total: 15_000, lines: [{ quantity: 5000, unitCost: 3, value: 15_000 }] });
    expect((await stock(r.token, r.mainId))[r.ids.rice]).toMatchObject({ onHand: 45_000, avgCost: 3 });
    expect((await stock(r.token, r.nasrId))[r.ids.rice]).toMatchObject({ onHand: 5000, avgCost: 3 });
    // Nasr City then buys at 4: (5000 × 3 + 5000 × 4) / 10,000 = 3.5.
    await http().post('/v1/inventory/purchases').set(auth(r.token)).send({ branchId: r.nasrId, receive: true, lines: [{ ingredientId: r.ids.rice, quantity: 5000, unitPrice: 4 }] }).expect(201);
    expect((await stock(r.token, r.nasrId))[r.ids.rice]).toMatchObject({ onHand: 10_000, avgCost: 3.5 });
    const moves = await t.prisma.stockMovement.findMany({ where: { transferId: transfer.body.id }, orderBy: { type: 'asc' } });
    expect(moves.map((row) => [row.type, row.branchId, row.quantity.toNumber(), row.unitCost.toNumber()])).toEqual([
      ['TRANSFER_IN', r.nasrId, 5000, 3], ['TRANSFER_OUT', r.mainId, -5000, 3],
    ]);
    expect((await http().get('/v1/inventory/transfers').set(auth(r.token)).expect(200)).body.total).toBe(1);

    expect((await http().post('/v1/inventory/transfers').set(auth(r.token)).send({ fromBranchId: r.mainId, toBranchId: r.mainId, lines: [{ ingredientId: r.ids.rice, quantity: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_SAME_BRANCH');
    expect((await http().post('/v1/inventory/transfers').set(auth(r.token)).send({ toBranchId: r.nasrId, lines: [{ ingredientId: r.ids.sauce, quantity: 1 }] }).expect(400)).body.error.code).toBe('INVENTORY_NOT_RAW');
  });
});

describe('inventory: auto sold-out', () => {
  it('marks a dish sold out when an ingredient every size needs runs out, lifts it on restock, and never touches manual marks', async () => {
    const r = await stocked();
    await http().put('/v1/inventory/settings').set(auth(r.token)).send({ enabled: true, autoSoldOut: true }).expect(200);
    const lemons = (quantity: number, branchId = r.mainId) =>
      http().post('/v1/inventory/purchases').set(auth(r.token)).send({ branchId, receive: true, lines: [{ ingredientId: r.ids.lemons, quantity, unitPrice: 250 }] }).expect(201);
    const lemonadeAt = async (branchId: string) =>
      (await http().get(`/v1/branches/${branchId}/menu`).set(auth(r.token)).expect(200)).body.categories.flatMap((category: { items: unknown[] }) => category.items).find((item: { id: string }) => item.id === r.lemonade.id);
    const version = async () => (await t.prisma.restaurant.findUniqueOrThrow({ where: { id: r.restaurantId } })).menuVersion;
    const publicLemonade = async (branch?: string) =>
      (await http().get(`/v1/public/restaurants/${r.subdomain}/menu${branch ? `?branch=${branch}` : ''}`).expect(200)).body.categories.flatMap((category: { items: unknown[] }) => category.items).find((item: { id: string }) => item.id === r.lemonade.id);

    await lemons(2);
    const orderId = await place(r, [{ menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 2 }]);
    const before = await version();
    await setStatus(r.token, orderId, 'ACCEPTED').expect(200);
    expect(await version()).toBeGreaterThan(before);
    expect(await lemonadeAt(r.mainId)).toMatchObject({ override: { available: false, soldOutByInventory: true }, effective: { available: false } });
    expect((await publicLemonade()).isAvailable).toBe(false);
    // Only at that branch, and only dishes that need it.
    expect((await publicLemonade('nasr-city')).isAvailable).toBe(true);
    expect((await lemonadeAt(r.nasrId)).override.soldOutByInventory).toBe(false);
    await http().post(`/v1/public/restaurants/${r.subdomain}/orders`).set('Idempotency-Key', crypto.randomUUID())
        .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }] }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('ITEMS_UNAVAILABLE'));

    // Restocked: the mark inventory set is lifted.
    await lemons(5);
    expect(await lemonadeAt(r.mainId)).toMatchObject({ override: { available: null, soldOutByInventory: false }, effective: { available: true } });
    expect(await t.prisma.branchMenuItem.count({ where: { branchId: r.mainId } })).toBe(0);

    // Out again (waste), then a manager confirms it by hand: now it is a manual mark that restocking leaves alone.
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lemons, quantity: 5 }] }).expect(201);
    expect((await lemonadeAt(r.mainId)).override).toMatchObject({ available: false, soldOutByInventory: true });
    await http().put(`/v1/branches/${r.mainId}/menu/items/${r.lemonade.id}`).set(auth(r.token)).send({ available: false }).expect(200);
    expect((await lemonadeAt(r.mainId)).override).toMatchObject({ available: false, soldOutByInventory: false });
    await lemons(3);
    expect((await lemonadeAt(r.mainId)).override).toMatchObject({ available: false, soldOutByInventory: false });
    // A manual mark is never overwritten either: running out again leaves it manual.
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lemons, quantity: 3 }] }).expect(201);
    expect((await lemonadeAt(r.mainId)).override).toMatchObject({ available: false, soldOutByInventory: false });
    await http().put(`/v1/branches/${r.mainId}/menu/items/${r.lemonade.id}`).set(auth(r.token)).send({ available: null }).expect(200);

    // Koshary: lentils are needed by the small size only, so running out does not mark it…
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, quantity: 250 }] }).expect(200);
    const kosharyAt = async () => (await http().get(`/v1/branches/${r.mainId}/menu`).set(auth(r.token)).expect(200)).body.categories[0].items.find((item: { id: string }) => item.id === r.koshary.id);
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lentils, quantity: 1 }] }).expect(201);
    expect((await kosharyAt()).override.soldOutByInventory).toBe(false);
    // …until every size needs them.
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, quantity: 250 }, { ingredientId: r.ids.lentils, quantity: 80 }] }).expect(200);
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.lentils, quantity: 1 }] }).expect(201);
    expect((await kosharyAt()).override).toMatchObject({ available: false, soldOutByInventory: true });
    // Copying the branch menu does not carry inventory's marks to another branch.
    await http().post(`/v1/branches/${r.nasrId}/menu/copy-from/${r.mainId}`).set(auth(r.token)).expect(200);
    expect(await t.prisma.branchMenuItem.count({ where: { branchId: r.nasrId } })).toBe(0);
    // Switching auto sold-out off lifts its marks.
    await http().put('/v1/inventory/settings').set(auth(r.token)).send({ enabled: true, autoSoldOut: false }).expect(200);
    expect((await kosharyAt()).override).toMatchObject({ available: null, soldOutByInventory: false });
  });
});

describe('inventory: reports', () => {
  it('suggests reorders, values stock, and reports food cost and menu engineering', async () => {
    const r = await stocked();
    await http().post('/v1/inventory/purchases').set(auth(r.token)).send({ receive: true, lines: [{ ingredientId: r.ids.lemons, quantity: 10, unitPrice: 250 }] }).expect(201);
    await http().patch(`/v1/inventory/stock/${r.ids.rice}`).set(auth(r.token)).send({ reorderPoint: 60_000, parLevel: 100_000 }).expect(200);
    const levels = await http().patch(`/v1/inventory/stock/${r.ids.lentils}?branchId=${r.mainId}`).set(auth(r.token)).send({ reorderPoint: 1000 }).expect(200);
    expect(levels.body).toMatchObject({ reorderPoint: 1000, parLevel: null, status: 'OUT' });
    await http().patch(`/v1/inventory/stock/${r.ids.sauce}`).set(auth(r.token)).send({ reorderPoint: 1 }).expect(400);

    const reorder = await http().get('/v1/inventory/reports/reorder').set(auth(r.token)).expect(200);
    expect(reorder.body.groups).toEqual([
      {
        supplier: { id: r.supplier.id, name: 'Gomla Market', phone: '01000000001' }, estimatedCost: 150_000,
        lines: [expect.objectContaining({ ingredientId: r.ids.rice, onHand: 50_000, suggestedQuantity: 50_000, suggestedUnits: { unitId: r.rice.units[0].id, unitNameAr: 'كيلو', unitNameEn: null, quantity: 50 }, estimatedCost: 150_000 })],
      },
      { supplier: null, estimatedCost: 6000, lines: [expect.objectContaining({ ingredientId: r.ids.lentils, suggestedQuantity: 1000, suggestedUnits: expect.objectContaining({ quantity: 1 }), estimatedCost: 6000 })] },
    ]);

    // Sales: 2 small koshary (7000, cost 1950) and a lemonade (2000, cost 250); a rejected and a cancelled order do not count.
    const a = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 2 }]);
    await setStatus(r.token, a, 'ACCEPTED').expect(200);
    const b = await place(r, [{ menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }]);
    await setStatus(r.token, b, 'ACCEPTED').expect(200);
    const c = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.small, quantity: 1 }]);
    await setStatus(r.token, c, 'REJECTED').expect(200);
    const d = await place(r, [{ menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 1 }]);
    await setStatus(r.token, d, 'ACCEPTED').expect(200);
    await setStatus(r.token, d, 'CANCELLED').expect(200);
    // Waste 1 kg of rice (3000) and a count short by 500 g (−1500).
    await http().post('/v1/inventory/waste').set(auth(r.token)).send({ reason: 'SPOILED', lines: [{ ingredientId: r.ids.rice, quantity: 1000 }] }).expect(201);
    const count = await http().post('/v1/inventory/counts').set(auth(r.token)).send({ ingredientIds: [r.ids.rice] }).expect(201);
    expect(count.body.lines[0].expected).toBe(48_700);
    await http().patch(`/v1/inventory/counts/${count.body.id}`).set(auth(r.token)).send({ lines: [{ ingredientId: r.ids.rice, counted: 48_200 }] }).expect(200);
    await http().post(`/v1/inventory/counts/${count.body.id}/post`).set(auth(r.token)).expect(200);

    const day = today();
    const food = await http().get(`/v1/inventory/reports/food-cost?from=${day}&to=${day}`).set(auth(r.token)).expect(200);
    expect(food.body.total).toEqual({
      branchId: null, branchName: null, revenue: 9000, theoreticalCost: 2200, wasteCost: 3000, countVariance: -1500, purchases: 152_500,
      theoreticalFoodCostPercent: 24.44, actualFoodCostPercent: 74.44,
    });
    expect(food.body.byBranch).toEqual([
      expect.objectContaining({ branchId: r.mainId, revenue: 9000, theoreticalCost: 2200 }),
      expect.objectContaining({ branchId: r.nasrId, revenue: 0, theoreticalCost: 0, theoreticalFoodCostPercent: null }),
    ]);
    await http().get(`/v1/inventory/reports/food-cost?from=${day}&to=2020-01-01`).set(auth(r.token)).expect(400);

    const valuation = await http().get('/v1/inventory/reports/valuation').set(auth(r.token)).expect(200);
    // Rice 48,200 × 3 and lemons 9 × 250; lentils, tomato and oil went below zero (sold before bought).
    expect(valuation.body).toMatchObject({
      branchId: r.mainId, total: 146_850, negativeItems: 3,
      byCategory: [{ category: 'بقالة', items: 1, value: 144_600 }, { category: 'خضار', items: 1, value: 2250 }],
    });

    const engineering = await http().get('/v1/inventory/reports/menu-engineering?days=7').set(auth(r.token)).expect(200);
    // Margins 2525 and 1750, weighted average (2525 × 2 + 1750) / 3 = 2266.67; popular at ≥ 0.35 of units.
    expect(engineering.body).toMatchObject({ days: 7, popularityThreshold: 0.35, averageMargin: 2266.67 });
    expect(engineering.body.rows).toEqual([
      expect.objectContaining({ itemId: r.koshary.id, sold: 2, revenue: 7000, cost: 1950, unitMargin: 2525, totalMargin: 5050, share: 0.6667, foodCostPercent: 27.86, class: 'STAR' }),
      expect.objectContaining({ itemId: r.lemonade.id, sold: 1, revenue: 2000, cost: 250, unitMargin: 1750, class: 'DOG' }),
    ]);
  });
});
