import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Station = { id: string; kind: string; isDefault: boolean; targetMinutes: number };
type Line = { id: string; nameAr: string; stationId: string | null; stationName: string | null; prepStatus: string };

/** An owner with ordering on: a hot dish (in the default station) and a drink (moved to the drinks station). */
async function restaurant() {
  const token = await signUpOwner(t, 'owner@koshary.test');
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
  const list = (await http().get('/v1/kitchen-stations').set(auth(token)).expect(200)).body as { stations: Station[]; readyRule: string };
  const station = (kind: string) => list.stations.find((entry) => entry.kind === kind)!;
  const food = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const drinks = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'مشروبات', stationId: station('DRINKS').id }).expect(201);
  const dish = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: food.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201);
  const drink = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: drinks.body.id, nameAr: 'ليمون', variants: [{ pricePiastres: 1500 }] }).expect(201);
  // A dish may leave its category's station.
  const grilled = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: food.body.id, nameAr: 'كفتة', stationId: station('GRILL').id, variants: [{ pricePiastres: 9000 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const item = (body: { id: string; variants: { id: string }[] }) => ({ menuItemId: body.id, variantId: body.variants[0]!.id, quantity: 1 });
  return { token, list, station, items: { dish: item(dish.body), drink: item(drink.body), grilled: item(grilled.body) } };
}

async function staff(owner: string, role: string, email: string) {
  await http().post('/v1/kitchen-accounts').set(auth(owner)).send({ fullName: `${role} one`, email, password: 'staff-password', role }).expect(201);
  return (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200)).body.accessToken as string;
}

async function place(items: object[]) {
  await http().post('/v1/public/restaurants/koshary/orders').set('Idempotency-Key', randomUUID())
    .send({ type: 'DINE_IN', tableLabel: '4', customerName: 'Mona', items }).expect(201);
}

const activeOrder = async (token: string) => (await http().get('/v1/orders?view=active').set(auth(token)).expect(200)).body.items[0] as { id: string; status: string; priority: string; items: Line[] };
const move = (token: string, orderId: string, itemIds: string[], status: string) => http().patch(`/v1/orders/${orderId}/items/status`).set(auth(token)).send({ itemIds, status });

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('kitchen display', () => {
  it('starts every restaurant with four stations and routes each dish to its station', async () => {
    const r = await restaurant();
    expect(r.list.stations.map((station) => station.kind)).toEqual(['MAIN', 'GRILL', 'DRINKS', 'DESSERTS']);
    expect(r.list.stations.filter((station) => station.isDefault).map((station) => station.kind)).toEqual(['MAIN']);
    expect(r.list.readyRule).toBe('ALL_ITEMS');

    await place([r.items.dish, r.items.drink, r.items.grilled]);
    const order = await activeOrder(r.token);
    const at = (name: string) => order.items.find((line) => line.nameAr === name)!;
    expect(at('كشري')).toMatchObject({ stationId: r.station('MAIN').id, prepStatus: 'NEW' });
    expect(at('ليمون')).toMatchObject({ stationId: r.station('DRINKS').id, stationName: 'المشروبات' });
    expect(at('كفتة').stationId).toBe(r.station('GRILL').id);
  });

  it('moves the order with its dishes, ignores repeats, refuses invalid moves and keeps the history', async () => {
    const r = await restaurant();
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    await place([r.items.dish, r.items.drink]);
    const order = await activeOrder(kitchen);
    const [dish, drink] = [order.items.find((line) => line.nameAr === 'كشري')!, order.items.find((line) => line.nameAr === 'ليمون')!];

    // Starting one dish starts the order.
    expect((await move(kitchen, order.id, [dish.id], 'PREPARING').expect(200)).body.status).toBe('PREPARING');
    // The same move again changes nothing.
    await move(kitchen, order.id, [dish.id], 'PREPARING').expect(200);
    // NEW cannot be served.
    const invalid = await move(kitchen, order.id, [drink.id], 'SERVED').expect(409);
    expect(invalid.body.error).toMatchObject({ code: 'INVALID_ITEM_STATUS_CHANGE', details: { from: 'NEW', to: 'SERVED' } });

    // One dish ready: still preparing. Both ready: the order is ready, for the diner too.
    expect((await move(kitchen, order.id, [dish.id], 'READY').expect(200)).body.status).toBe('PREPARING');
    const ready = (await move(kitchen, order.id, [drink.id], 'READY').expect(200)).body;
    expect(ready.status).toBe('READY');
    expect(ready.readyAt).not.toBeNull();

    // A ready order cannot take a dish back.
    await move(kitchen, order.id, [dish.id], 'PREPARING').expect(409);
    // Serving every dish completes it.
    expect((await move(kitchen, order.id, [dish.id, drink.id], 'SERVED').expect(200)).body.status).toBe('COMPLETED');

    const history = (await http().get(`/v1/orders/${order.id}/kitchen-history`).set(auth(r.token)).expect(200)).body as { itemId: string; status: string; actorName: string }[];
    expect(history.filter((event) => event.itemId === dish.id).map((event) => event.status)).toEqual(['PREPARING', 'READY', 'SERVED']);
    expect(history.every((event) => event.actorName === 'KITCHEN one')).toBe(true);
    const full = (await http().get(`/v1/orders/${order.id}`).set(auth(r.token)).expect(200)).body as { history: { status: string; actorName: string | null }[] };
    expect(full.history.map((step) => step.status)).toEqual(['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']);

    const stats = (await http().get('/v1/kitchen-stations/stats?days=1').set(auth(r.token)).expect(200)).body;
    expect(stats).toMatchObject({ orders: 1, accurate: 1, accuracyRate: 1 });
    expect(stats.stations).toHaveLength(2);
  });

  it('moves the dishes when the order moves, and leaves ready to people under the manual rule', async () => {
    const r = await restaurant();
    await http().put('/v1/kitchen-stations/settings').set(auth(r.token)).send({ readyRule: 'MANUAL' }).expect(200);
    await place([r.items.dish, r.items.drink]);
    const order = await activeOrder(r.token);
    await http().patch(`/v1/orders/${order.id}/status`).set(auth(r.token)).send({ status: 'ACCEPTED' }).expect(200);
    expect((await activeOrder(r.token)).items.map((line) => line.prepStatus)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect((await move(r.token, order.id, order.items.map((line) => line.id), 'READY').expect(200)).body.status).toBe('PREPARING');
    const done = (await http().patch(`/v1/orders/${order.id}/status`).set(auth(r.token)).send({ status: 'READY' }).expect(200)).body;
    expect(done.status).toBe('READY');
  });

  it('marks rush orders, and keeps the waiter and the cashier away from the stove', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await place([r.items.dish]);
    const order = await activeOrder(r.token);
    expect((await http().patch(`/v1/orders/${order.id}/priority`).set(auth(r.token)).send({ priority: 'RUSH' }).expect(200)).body.priority).toBe('RUSH');
    await http().patch(`/v1/orders/${order.id}/priority`).set(auth(waiter)).send({ priority: 'NORMAL' }).expect(403);
    await move(waiter, order.id, [order.items[0]!.id], 'PREPARING').expect(403);
    await move(cashier, order.id, [order.items[0]!.id], 'PREPARING').expect(403);
    await http().post('/v1/kitchen-stations').set(auth(cashier)).send({ nameAr: 'بيتزا' }).expect(403);
    // Every restaurant account can read the stations (screens filter by them).
    await http().get('/v1/kitchen-stations').set(auth(waiter)).expect(200);
  });

  it('manages stations: the default cannot be removed, and removing one sends its dishes to the default', async () => {
    const r = await restaurant();
    const pizza = (await http().post('/v1/kitchen-stations').set(auth(r.token)).send({ nameAr: 'البيتزا', nameEn: 'Pizza', targetMinutes: 12 }).expect(201)).body as Station;
    await http().delete(`/v1/kitchen-stations/${r.station('MAIN').id}`).set(auth(r.token)).expect(409);
    const moved = (await http().patch(`/v1/kitchen-stations/${pizza.id}`).set(auth(r.token)).send({ isDefault: true }).expect(200)).body as { stations: Station[] };
    expect(moved.stations.filter((station) => station.isDefault).map((station) => station.id)).toEqual([pizza.id]);
    await http().delete(`/v1/kitchen-stations/${r.station('GRILL').id}`).set(auth(r.token)).expect(204);
    await place([r.items.grilled]);
    expect((await activeOrder(r.token)).items[0]!.stationId).toBe(pizza.id);
  });
});
