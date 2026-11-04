import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An owner taking orders, with koshary (two sizes), a drink, a dessert and a side. */
async function menu(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const item = async (nameAr: string, prices: number[]) => (await http().post('/v1/menu/items').set(auth(token))
    .send({ categoryId: category.body.id, nameAr, variants: prices.map((pricePiastres, index) => ({ nameAr: prices.length > 1 ? `حجم ${index}` : undefined, pricePiastres })) }).expect(201)).body as { id: string; variants: { id: string }[] };
  return {
    token, subdomain,
    koshary: await item('كشري', [3500, 5500]),
    pepsi: await item('بيبسي', [1500]),
    rice: await item('رز بلبن', [2000]),
    sauce: await item('صلصة زيادة', [500]),
  };
}

const order = (subdomain: string, items: unknown[]) => http().post(`/v1/public/restaurants/${subdomain}/orders`).set('Idempotency-Key', randomUUID())
  .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items });

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('managing recommendations', () => {
  it('owners create, edit, switch off and delete them, within their own menu', async () => {
    const m = await menu();
    const created = await http().post('/v1/recommendations').set(auth(m.token)).send({
      sourceItemId: m.koshary.id, type: 'FREQUENTLY_BOUGHT_TOGETHER', placements: ['PRODUCT_DETAILS', 'CART', 'CART'],
      items: [{ itemId: m.pepsi.id }, { itemId: m.rice.id, maxQuantity: 3 }],
    }).expect(201);
    expect(created.body).toMatchObject({ type: 'FREQUENTLY_BOUGHT_TOGETHER', placements: ['PRODUCT_DETAILS', 'CART'], isActive: true, required: false,
      items: [{ itemId: m.pepsi.id, variantId: null, maxQuantity: 1 }, { itemId: m.rice.id, variantId: null, maxQuantity: 3 }] });

    const edited = await http().patch(`/v1/recommendations/${created.body.id}`).set(auth(m.token)).send({ title: 'كمّل وجبتك', isActive: false, items: [{ itemId: m.pepsi.id }] }).expect(200);
    expect(edited.body).toMatchObject({ title: 'كمّل وجبتك', isActive: false, items: [{ itemId: m.pepsi.id }] });
    expect((await http().get('/v1/recommendations').set(auth(m.token)).expect(200)).body).toHaveLength(1);

    // Bad suggestions: itself, a size of another dish, the same dish twice, another restaurant's dish.
    const bad = (items: unknown[], extra: Record<string, unknown> = {}) => http().post('/v1/recommendations').set(auth(m.token))
      .send({ sourceItemId: m.koshary.id, type: 'ADD_ON', placements: ['CART'], items, ...extra });
    expect((await bad([{ itemId: m.koshary.id }]).expect(400)).body.error.code).toBe('RECOMMENDATION_ITEMS_INVALID');
    // An upgrade to a bigger size of the same dish is fine; it needs that size.
    await bad([{ itemId: m.koshary.id, variantId: m.koshary.variants[1]!.id }], { type: 'UPGRADE' }).expect(201);
    await bad([{ itemId: m.koshary.id }], { type: 'UPGRADE' }).expect(400);
    await bad([{ itemId: m.pepsi.id, variantId: m.koshary.variants[0]!.id }]).expect(400);
    await bad([{ itemId: m.pepsi.id }, { itemId: m.pepsi.id }]).expect(400);
    const other = await menu('other@koshary.test', 'other');
    await bad([{ itemId: other.pepsi.id }]).expect(400);
    // Required only for add-ons on the dish page.
    expect((await bad([{ itemId: m.sauce.id }], { required: true }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await bad([{ itemId: m.sauce.id }], { required: true, placements: ['PRODUCT_DETAILS'] }).expect(201);

    // Not the other owner's to see or change.
    expect((await http().get('/v1/recommendations').set(auth(other.token)).expect(200)).body).toEqual([]);
    await http().patch(`/v1/recommendations/${created.body.id}`).set(auth(other.token)).send({ isActive: true }).expect(404);
    await http().delete(`/v1/recommendations/${created.body.id}`).set(auth(m.token)).expect(204);
    await http().delete(`/v1/recommendations/${created.body.id}`).set(auth(m.token)).expect(404);
  });

  it('need promotions.manage: managers may manage them, the kitchen and cashiers may not', async () => {
    const m = await menu();
    const login = async (email: string, role: string) => {
      await http().post('/v1/kitchen-accounts').set(auth(m.token)).send({ fullName: 'Staff', email, password: 'staff-password', role, branchId: null }).expect(201);
      return (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200)).body.accessToken as string;
    };
    const rule = { sourceItemId: m.koshary.id, type: 'ADD_ON', placements: ['CART'], items: [{ itemId: m.sauce.id }] };
    const manager = await login('manager@koshary.test', 'MANAGER');
    await http().get('/v1/recommendations').set(auth(manager)).expect(200);
    await http().post('/v1/recommendations').set(auth(manager)).send(rule).expect(201);
    for (const token of [await login('kitchen@koshary.test', 'KITCHEN'), await login('cashier@koshary.test', 'CASHIER')]) {
      await http().get('/v1/recommendations').set(auth(token)).expect(403);
      await http().post('/v1/recommendations').set(auth(token)).send(rule).expect(403);
    }
  });
});

describe('on the menu', () => {
  it('shows only active rules with orderable suggestions', async () => {
    const m = await menu();
    const add = (body: Record<string, unknown>) => http().post('/v1/recommendations').set(auth(m.token)).send({ sourceItemId: m.koshary.id, placements: ['CART'], ...body }).expect(201);
    const together = (await add({ type: 'FREQUENTLY_BOUGHT_TOGETHER', items: [{ itemId: m.pepsi.id }, { itemId: m.rice.id }] })).body;
    const upgrade = (await add({ type: 'UPGRADE', items: [{ itemId: m.rice.id }] })).body;
    await http().patch(`/v1/recommendations/${upgrade.id}`).set(auth(m.token)).send({ isActive: false }).expect(200);
    const visible = async () => (await http().get(`/v1/public/restaurants/${m.subdomain}/menu`).expect(200)).body.recommendations as { id: string; items: { itemId: string }[] }[];
    expect((await visible()).map((rule) => rule.id)).toEqual([together.id]);

    // A sold-out suggestion drops out; when none is left, the rule does too.
    await http().patch(`/v1/menu/items/${m.rice.id}`).set(auth(m.token)).send({ isAvailable: false }).expect(200);
    expect((await visible())[0]!.items.map((item) => item.itemId)).toEqual([m.pepsi.id]);
    await http().patch(`/v1/menu/items/${m.pepsi.id}`).set(auth(m.token)).send({ isAvailable: false }).expect(200);
    expect(await visible()).toEqual([]);
  });
});

describe('tracking and results', () => {
  it('counts impressions, clicks, adds and purchases, with revenue, conversion and order value', async () => {
    const m = await menu();
    const rule = (await http().post('/v1/recommendations').set(auth(m.token))
      .send({ sourceItemId: m.koshary.id, type: 'FREQUENTLY_BOUGHT_TOGETHER', placements: ['CART'], items: [{ itemId: m.pepsi.id }] }).expect(201)).body;
    const events = (kind: string, times: number) => Array.from({ length: times }, () => ({ ruleId: rule.id, itemId: m.pepsi.id, kind, placement: 'CART' }));
    await http().post(`/v1/public/restaurants/${m.subdomain}/recommendation-events`)
      .send({ events: [...events('IMPRESSION', 4), ...events('CLICK', 2), ...events('ADD', 1), { ruleId: randomUUID(), itemId: m.pepsi.id, kind: 'CLICK', placement: 'CART' }] }).expect(204);

    const koshary = { menuItemId: m.koshary.id, variantId: m.koshary.variants[1]!.id, quantity: 1 };
    const pepsi = { menuItemId: m.pepsi.id, variantId: m.pepsi.variants[0]!.id, quantity: 2 };
    // Bought from the suggestion: 2 × 15 EGP of the 85 EGP order.
    await order(m.subdomain, [koshary, { ...pepsi, recommendation: { ruleId: rule.id, placement: 'CART' } }]).expect(201);
    // A wrong attribution is ignored, and the order still goes through.
    await order(m.subdomain, [koshary, { ...pepsi, quantity: 1, recommendation: { ruleId: rule.id, placement: 'CHECKOUT' } }]).expect(201);
    await order(m.subdomain, [{ menuItemId: m.rice.id, variantId: m.rice.variants[0]!.id, quantity: 1, recommendation: { ruleId: rule.id, placement: 'CART' } }]).expect(201);
    // A rejected order does not count.
    const rejected = await order(m.subdomain, [{ ...pepsi, recommendation: { ruleId: rule.id, placement: 'CART' } }]).expect(201);
    const board = (await http().get('/v1/orders?view=active').set(auth(m.token)).expect(200)).body.items as { id: string; number: number }[];
    const id = board.find((entry) => entry.number === rejected.body.order.number)!.id;
    await http().patch(`/v1/orders/${id}/status`).set(auth(m.token)).send({ status: 'REJECTED', reason: 'Closed' }).expect(200);

    const stats = (await http().get('/v1/recommendations/stats').set(auth(m.token)).expect(200)).body;
    expect(stats).toMatchObject({ days: 30, impressions: 4, clicks: 2, adds: 1, purchases: 1, revenuePiastres: 3000, conversionRate: 0.25 });
    expect(stats.averageOrderWithPiastres).toBe(8500);
    expect(stats.averageOrderWithoutPiastres).toBe(Math.round((7000 + 2000) / 2));
    expect(stats.rules).toEqual([expect.objectContaining({ ruleId: rule.id, purchases: 1, revenuePiastres: 3000 })]);
  });
});
