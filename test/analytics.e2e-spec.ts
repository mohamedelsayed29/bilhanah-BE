import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { VisitsService } from '../src/modules/analytics/visits.service.js';
import { createTestApp, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Today in Cairo, as YYYY-MM-DD. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  const created = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: `Restaurant ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  return { token, id: created.body.id as string };
}

const visit = (subdomain: string, source: string, ip = '203.0.113.7', agent = 'Mozilla/5.0 (iPhone)') =>
  http().post(`/v1/public/restaurants/${subdomain}/visits`).set('X-Forwarded-For', ip).set('User-Agent', agent).send({ source });

async function menuWithOrdering(token: string) {
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', nameEn: 'Koshary', variants: [{ pricePiastres: 5000 }] }).expect(201);
  const tea = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'شاي', variants: [{ pricePiastres: 1500 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  return { koshary: { id: koshary.body.id, variant: koshary.body.variants[0].id }, tea: { id: tea.body.id, variant: tea.body.variants[0].id } };
}

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('menu visits', () => {
  it('counts each visitor once a day, by how they arrived', async () => {
    const { token } = await restaurant();
    await visit('koshary', 'qr').expect(204);
    await visit('KOSHARY', 'qr').expect(204); // the same phone again
    await visit('koshary', 'table', '203.0.113.8').expect(204);
    await visit('koshary', 'link', '203.0.113.7', 'Mozilla/5.0 (Android)').expect(204); // another phone behind the same Wi-Fi
    await http().post('/v1/public/restaurants/koshary/visits').set('X-Forwarded-For', '203.0.113.9').send({}).expect(204); // defaults to link
    await visit('koshary', 'nfc').expect(400);
    await visit('nobody', 'qr').expect(404);

    const stats = (await http().get('/v1/restaurants/mine/stats?days=7').set(auth(token)).expect(200)).body;
    expect(stats.days).toHaveLength(7);
    expect(stats.days.at(-1)).toMatchObject({ date: today(), visits: 4 });
    expect(stats.totals.visits).toBe(4);
    expect(stats.sources).toEqual({ qr: 1, table: 1, link: 2 });
    // No addresses are stored: only salted hashes, and only in Redis.
    expect(JSON.stringify(await t.prisma.restaurantDailyStat.findMany())).not.toContain('203.0.113');
  });

  it('copies counters to Postgres idempotently', async () => {
    const { id } = await restaurant();
    await visit('koshary', 'qr').expect(204);
    const visits = t.app.get(VisitsService);
    await visits.flush();
    await visits.flush();
    expect(await t.prisma.restaurantDailyStat.findMany({ where: { restaurantId: id } })).toMatchObject([{ visits: 1, qrVisits: 1, tableVisits: 0, linkVisits: 0 }]);
  });
});

describe('owner insights', () => {
  it('reports orders, revenue, order types and top dishes', async () => {
    const { token } = await restaurant();
    const menu = await menuWithOrdering(token);
    const place = (items: object[], type = 'PICKUP') =>
      http()
        .post('/v1/public/restaurants/koshary/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ type, customerName: 'Mona', customerPhone: '01098765432', tableLabel: 'Table 2', items })
        .expect(201);
    await place([{ menuItemId: menu.koshary.id, variantId: menu.koshary.variant, quantity: 2 }]);
    await place([{ menuItemId: menu.koshary.id, variantId: menu.koshary.variant, quantity: 1 }, { menuItemId: menu.tea.id, variantId: menu.tea.variant, quantity: 3 }], 'DINE_IN');
    await place([{ menuItemId: menu.tea.id, variantId: menu.tea.variant, quantity: 10 }]);
    // A rejected order does not count.
    const rejected = await t.prisma.order.findFirstOrThrow({ where: { subtotalPiastres: 15000 } });
    await http().patch(`/v1/orders/${rejected.id}/status`).set(auth(token)).send({ status: 'REJECTED', reason: 'Out of tea' }).expect(200);

    const stats = (await http().get('/v1/restaurants/mine/stats?days=30').set(auth(token)).expect(200)).body;
    expect(stats.days).toHaveLength(30);
    expect(stats.days.at(-1)).toMatchObject({ date: today(), orders: 2, revenuePiastres: 10000 + 9500 });
    expect(stats.totals).toEqual({ visits: 0, orders: 2, revenuePiastres: 19500, averageOrderPiastres: 9750 });
    expect(stats.ordersByType).toEqual({ DINE_IN: 1, PICKUP: 1 });
    expect(stats.topItems).toEqual([
      { nameAr: 'كشري', nameEn: 'Koshary', quantity: 3, revenuePiastres: 15000 },
      { nameAr: 'شاي', nameEn: null, quantity: 3, revenuePiastres: 4500 },
    ]);
    expect(stats.ordering).toBe(true);

    await http().get('/v1/restaurants/mine/stats?days=12').set(auth(token)).expect(400);
    expect((await http().get('/v1/restaurants/mine/stats').set(auth(token)).expect(200)).body.days).toHaveLength(30);
  });

  it('says when the plan has no ordering', async () => {
    const { token, id } = await restaurant();
    await t.prisma.entitlement.updateMany({ where: { restaurantId: id }, data: { planCode: 'MENU' } });
    expect((await http().get('/v1/restaurants/mine/stats?days=7').set(auth(token)).expect(200)).body.ordering).toBe(false);
    const { token: admin } = await signInAdmin(t);
    await http().get('/v1/restaurants/mine/stats').set(auth(admin)).expect(403);
  });
});

describe('platform reports', () => {
  it('sums visits, orders, sign-ups and subscription revenue, with the busiest restaurants', async () => {
    const first = await restaurant('a@koshary.test', 'koshary');
    await restaurant('b@felfela.test', 'felfela');
    await visit('koshary', 'qr', '198.51.100.1').expect(204);
    await visit('koshary', 'qr', '198.51.100.2').expect(204);
    await visit('felfela', 'link', '198.51.100.3').expect(204);
    const menu = await menuWithOrdering(first.token);
    await http()
      .post('/v1/public/restaurants/koshary/orders')
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: menu.tea.id, variantId: menu.tea.variant, quantity: 1 }] })
      .expect(201);
    await t.prisma.subscriptionPayment.create({
      data: { restaurantId: first.id, planCode: 'ORDERS', months: 1, amountPiastres: 35000, method: 'INSTAPAY', reference: 'TX1', status: 'APPROVED', reviewedAt: new Date() },
    });

    const { token: admin } = await signInAdmin(t);
    const stats = (await http().get('/v1/admin/stats?days=7').set(auth(admin)).expect(200)).body;
    expect(stats.days.at(-1)).toEqual({ date: today(), visits: 3, orders: 1, newRestaurants: 2, revenuePiastres: 35000 });
    expect(stats.totals).toEqual({ visits: 3, orders: 1, newRestaurants: 2, revenuePiastres: 35000, standOrders: 0, standRevenuePiastres: 0 });
    expect(stats.topRestaurants).toEqual([
      { id: first.id, name: 'Restaurant koshary', subdomain: 'koshary', visits: 2, orders: 1 },
      { id: expect.any(String), name: 'Restaurant felfela', subdomain: 'felfela', visits: 1, orders: 0 },
    ]);
    await http().get('/v1/admin/stats').set(auth(first.token)).expect(403);
  });
});
