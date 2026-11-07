import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

async function restaurant() {
  const token = await signUpOwner(t, 'owner@koshary.test');
  const created = await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي', nameEn: 'Mains' }).expect(201);
  const drinks = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'مشروبات', nameEn: 'Drinks' }).expect(201);
  const koshary = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 5000 }] }).expect(201);
  const tea = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: drinks.body.id, nameAr: 'شاي', variants: [{ pricePiastres: 1500 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  return { token, restaurantId: created.body.id as string, koshary: koshary.body, tea: tea.body };
}

describe('the dashboard overview', () => {
  it('compares today with yesterday, and splits sales by hour, category and dish', async () => {
    const r = await restaurant();
    const order = (type: 'DINE_IN' | 'PICKUP', items: { menuItemId: string; variantId: string; quantity: number }[]) =>
      http().post('/v1/public/restaurants/koshary/orders').set('Idempotency-Key', randomUUID())
        .send({ type, customerName: 'Mona', customerPhone: '01098765432', ...(type === 'DINE_IN' && { tableLabel: 'T1' }), items }).expect(201);
    await order('PICKUP', [{ menuItemId: r.koshary.id, variantId: r.koshary.variants[0].id, quantity: 2 }]);
    await order('DINE_IN', [{ menuItemId: r.tea.id, variantId: r.tea.variants[0].id, quantity: 1 }]);
    const rejected = await order('PICKUP', [{ menuItemId: r.tea.id, variantId: r.tea.variants[0].id, quantity: 9 }]);
    const id = (await t.prisma.order.findFirstOrThrow({ where: { number: rejected.body.order.number, restaurantId: r.restaurantId } })).id;
    await http().patch(`/v1/orders/${id}/status`).set(auth(r.token)).send({ status: 'REJECTED', reason: 'Closed' }).expect(200);
    // An order from yesterday, for the comparison.
    const yesterday = await order('PICKUP', [{ menuItemId: r.tea.id, variantId: r.tea.variants[0].id, quantity: 2 }]);
    await t.prisma.order.updateMany({ where: { number: yesterday.body.order.number, restaurantId: r.restaurantId }, data: { placedAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000) } });
    await http().patch(`/v1/menu/items/${r.tea.id}`).set(auth(r.token)).send({ isAvailable: false }).expect(200);

    const today = (await http().get('/v1/restaurants/mine/stats/overview?period=today').set(auth(r.token)).expect(200)).body;
    expect(today).toMatchObject({
      period: 'today', bucket: 'hour', financial: true,
      kpis: { revenuePiastres: { value: 11500, previous: 3000 }, orders: { value: 2, previous: 1 }, dineIn: { value: 1, previous: 0 }, pickup: { value: 1, previous: 1 } },
      income: { totalPiastres: 11500 },
      soldOutTotal: 1,
    });
    expect(today.income.categories.map((row: { nameEn: string }) => row.nameEn)).toEqual(['Mains', 'Drinks']);
    expect(today.trending[0]).toMatchObject({ nameAr: 'كشري', quantity: 2, revenuePiastres: 10000 });
    expect(today.soldOut[0]).toMatchObject({ nameAr: 'شاي', branchName: null });
    expect(today.sales.reduce((sum: number, row: { orders: number }) => sum + row.orders, 0)).toBe(2);
    expect(today.sales.at(-1).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);

    const month = (await http().get('/v1/restaurants/mine/stats/overview?period=month').set(auth(r.token)).expect(200)).body;
    expect(month).toMatchObject({ bucket: 'day', kpis: { orders: { value: 3 } } });
    expect(month.sales).toHaveLength(30);
    await http().get('/v1/restaurants/mine/stats/overview?period=year').set(auth(r.token)).expect(400);
  });
});
