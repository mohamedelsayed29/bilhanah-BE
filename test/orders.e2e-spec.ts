import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Menu = { token: string; restaurantId: string; koshary: { id: string; small: string; large: string }; tea: { id: string; price: string } };

/** An owner with ordering switched on and two dishes: koshary (two sizes) and tea (one price). */
async function restaurantWithMenu(email = 'owner@koshary.test', subdomain = 'koshary'): Promise<Menu> {
  const token = await signUpOwner(t, email);
  const restaurant = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = await http()
    .post('/v1/menu/items')
    .set(auth(token))
    .send({
      categoryId: category.body.id,
      nameAr: 'كشري',
      nameEn: 'Koshary',
      variants: [
        { nameAr: 'صغير', nameEn: 'Small', pricePiastres: 3500 },
        { nameAr: 'كبير', nameEn: 'Large', pricePiastres: 5550 },
      ],
    })
    .expect(201);
  const tea = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'شاي', variants: [{ pricePiastres: 1500 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  return {
    token,
    restaurantId: restaurant.body.id,
    koshary: { id: koshary.body.id, small: koshary.body.variants[0].id, large: koshary.body.variants[1].id },
    tea: { id: tea.body.id, price: tea.body.variants[0].id },
  };
}

function placeOrder(menu: Menu, body: Record<string, unknown> = {}, key: string = randomUUID(), subdomain = 'koshary') {
  return http()
    .post(`/v1/public/restaurants/${subdomain}/orders`)
    .set('Idempotency-Key', key)
    .send({
      type: 'PICKUP',
      customerName: 'Mona',
      customerPhone: '010 9876 5432',
      items: [
        { menuItemId: menu.koshary.id, variantId: menu.koshary.large, quantity: 2, note: 'Extra daqqa' },
        { menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 1 },
      ],
      ...body,
    });
}

const setStatus = (token: string, id: string, status: string, reason?: string) =>
  http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status, reason });

function connect(namespace: '/owner' | '/track', token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}${namespace}`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

const nextEvent = <T>(socket: Socket, event: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event} event`)), 5_000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('placing orders', () => {
  it('only takes orders once the owner switches ordering on', async () => {
    const menu = await restaurantWithMenu();
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ orderingEnabled: false }).expect(200);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.ordering).toEqual({ accepting: false, dineIn: true, pickup: true, serviceRequests: true, sharedTable: false });
    const refused = await placeOrder(menu).expect(409);
    expect(refused.body.error.code).toBe('ORDERING_UNAVAILABLE');

    const mine = await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ orderingEnabled: true }).expect(200);
    expect(mine.body.ordering).toEqual({ included: true, enabled: true, acceptsDineIn: true, acceptsPickup: true, paused: false });
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.ordering.accepting).toBe(true);
  });

  it('prices the order from the menu and numbers orders per day', async () => {
    const menu = await restaurantWithMenu();

    const first = await placeOrder(menu).expect(201);
    expect(first.body.order).toMatchObject({
      number: 1,
      type: 'PICKUP',
      status: 'PLACED',
      subtotalPiastres: 2 * 5550 + 1500,
      restaurant: { name: 'Koshary Abou Tarek', subdomain: 'koshary' },
      items: [
        { nameAr: 'كشري', variantNameEn: 'Large', unitPricePiastres: 5550, quantity: 2, note: 'Extra daqqa', lineTotalPiastres: 11100 },
        { nameAr: 'شاي', variantNameAr: null, unitPricePiastres: 1500, quantity: 1 },
      ],
    });
    expect(first.body.order).not.toHaveProperty('customerPhone');
    expect((await placeOrder(menu).expect(201)).body.order.number).toBe(2);

    // Clients cannot set prices.
    const priced = await placeOrder(menu, { items: [{ menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 1, unitPricePiastres: 1 }] }).expect(400);
    expect(priced.body.error.code).toBe('VALIDATION_FAILED');

    const tracked = await http().get(`/v1/public/orders/${first.body.trackingToken}`).expect(200);
    expect(tracked.body).toMatchObject({ number: 1, status: 'PLACED' });
    const board = await http().get('/v1/orders').set(auth(menu.token)).expect(200);
    expect(board.body.items.map((order: { number: number; customerPhone: string }) => [order.number, order.customerPhone])).toEqual([
      [1, '01098765432'],
      [2, '01098765432'],
    ]);
  });

  it('returns the same order when a checkout is retried', async () => {
    const menu = await restaurantWithMenu();
    const key = randomUUID();
    const first = await placeOrder(menu, {}, key).expect(201);
    const retry = await placeOrder(menu, {}, key).expect(201);
    expect(retry.body.trackingToken).toBe(first.body.trackingToken);
    expect(await t.prisma.order.count()).toBe(1);

    await http().post('/v1/public/restaurants/koshary/orders').send({}).expect(400);
  });

  it('needs a table for dine-in and a phone for pickup', async () => {
    const menu = await restaurantWithMenu();
    const noTable = await placeOrder(menu, { type: 'DINE_IN', customerPhone: undefined }).expect(400);
    expect(noTable.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tableLabel' })]));
    await placeOrder(menu, { customerPhone: undefined }).expect(400);

    const typed = await placeOrder(menu, { type: 'DINE_IN', tableLabel: 'Terrace 3', customerPhone: undefined }).expect(201);
    expect(typed.body.order).toMatchObject({ type: 'DINE_IN', tableLabel: 'Terrace 3' });
  });

  it('refuses dishes that are sold out, hidden or from another restaurant', async () => {
    const menu = await restaurantWithMenu();
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    await http().patch(`/v1/menu/items/${menu.tea.id}`).set(auth(menu.token)).send({ isAvailable: false }).expect(200);

    const soldOut = await placeOrder(menu).expect(409);
    expect(soldOut.body.error).toMatchObject({ code: 'ITEMS_UNAVAILABLE', details: { menuItemIds: [menu.tea.id] } });

    const foreign = await placeOrder(menu, { items: [{ menuItemId: other.tea.id, variantId: other.tea.price, quantity: 1 }] }).expect(409);
    expect(foreign.body.error.details.menuItemIds).toEqual([other.tea.id]);

    const wrongSize = await placeOrder(menu, { items: [{ menuItemId: menu.koshary.id, variantId: other.koshary.small, quantity: 1 }] }).expect(409);
    expect(wrongSize.body.error.details.menuItemIds).toEqual([menu.koshary.id]);
  });

  it('respects opening hours, pauses, order types and the plan', async () => {
    const menu = await restaurantWithMenu();
    const closedAllWeek = { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] };
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ openingHours: { ...closedAllWeek, sat: [{ opens: '03:00', closes: '03:01' }] } }).expect(200);
    expect((await placeOrder(menu).expect(409)).body.error.code).toBe('RESTAURANT_CLOSED');
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ openingHours: null }).expect(200);

    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ ordersPaused: true }).expect(200);
    expect((await placeOrder(menu).expect(409)).body.error.code).toBe('ORDERING_UNAVAILABLE');
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ ordersPaused: false, acceptsPickup: false }).expect(200);
    expect((await placeOrder(menu).expect(400)).body.error.code).toBe('ORDER_TYPE_UNAVAILABLE');
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ acceptsPickup: true }).expect(200);

    // The Menu plan has no ordering.
    await t.prisma.entitlement.updateMany({ data: { planCode: 'MENU' } });
    expect((await placeOrder(menu).expect(409)).body.error.code).toBe('ORDERING_UNAVAILABLE');
    expect((await http().get('/v1/restaurants/mine').set(auth(menu.token)).expect(200)).body.ordering.included).toBe(false);
  });
});

describe('handling orders', () => {
  it('moves an order through the kitchen and records when', async () => {
    const menu = await restaurantWithMenu();
    const placed = await placeOrder(menu).expect(201);
    const [{ id }] = (await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.items;

    const invalid = await setStatus(menu.token, id, 'READY').expect(409);
    expect(invalid.body.error).toMatchObject({ code: 'INVALID_STATUS_CHANGE', details: { from: 'PLACED', to: 'READY', allowed: ['ACCEPTED', 'REJECTED'] } });

    expect((await setStatus(menu.token, id, 'ACCEPTED').expect(200)).body.acceptedAt).toEqual(expect.any(String));
    await setStatus(menu.token, id, 'PREPARING').expect(200);
    expect((await setStatus(menu.token, id, 'READY').expect(200)).body.readyAt).toEqual(expect.any(String));
    expect((await http().get(`/v1/public/orders/${placed.body.trackingToken}`).expect(200)).body.status).toBe('READY');
    await setStatus(menu.token, id, 'COMPLETED').expect(200);

    expect((await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.total).toBe(0);
    const history = await http().get('/v1/orders?view=history').set(auth(menu.token)).expect(200);
    expect(history.body.items[0]).toMatchObject({ id, status: 'COMPLETED' });
  });

  it('tells the diner why an order was rejected', async () => {
    const menu = await restaurantWithMenu();
    const placed = await placeOrder(menu).expect(201);
    const [{ id }] = (await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.items;
    await setStatus(menu.token, id, 'REJECTED', 'Out of koshary for today').expect(200);

    const tracked = await http().get(`/v1/public/orders/${placed.body.trackingToken}`).expect(200);
    expect(tracked.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Out of koshary for today', closedAt: expect.any(String) });
  });

  it("keeps each restaurant's orders private", async () => {
    const menu = await restaurantWithMenu();
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    await placeOrder(menu).expect(201);
    const [{ id }] = (await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.items;

    await http().get(`/v1/orders/${id}`).set(auth(other.token)).expect(404);
    await setStatus(other.token, id, 'ACCEPTED').expect(404);
    expect((await http().get('/v1/orders').set(auth(other.token)).expect(200)).body.total).toBe(0);
    await http().get('/v1/public/orders/AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
  });
});

describe('tables', () => {
  it('keeps each table\'s shape and seats for the floor plan', async () => {
    const menu = await restaurantWithMenu();
    const plain = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Bar' }).expect(201);
    expect(plain.body).toMatchObject({ shape: 'SQUARE', seats: 4 });
    const round = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Window', shape: 'ROUND', seats: 2 }).expect(201);
    expect(round.body).toMatchObject({ shape: 'ROUND', seats: 2 });
    await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Huge', seats: 21 }).expect(400);
    await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Odd', shape: 'OVAL' }).expect(400);

    const range = await http().post('/v1/tables/range').set(auth(menu.token)).send({ from: 1, to: 2, prefix: 'Family', shape: 'RECTANGLE', seats: 8 }).expect(201);
    expect(range.body.filter((row: { label: string }) => row.label.startsWith('Family'))).toEqual([
      expect.objectContaining({ shape: 'RECTANGLE', seats: 8 }),
      expect.objectContaining({ shape: 'RECTANGLE', seats: 8 }),
    ]);
    const updated = await http().patch(`/v1/tables/${plain.body.id}`).set(auth(menu.token)).send({ shape: 'RECTANGLE', seats: 6 }).expect(200);
    expect(updated.body).toMatchObject({ label: 'Bar', shape: 'RECTANGLE', seats: 6 });

    const floor = await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200);
    expect(floor.body.find((row: { id: string }) => row.id === round.body.id)).toMatchObject({ shape: 'ROUND', seats: 2 });
  });

  it('keeps whether each table is indoor or outdoor', async () => {
    const menu = await restaurantWithMenu();
    const inside = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Hall 1' }).expect(201);
    expect(inside.body).toMatchObject({ location: 'INDOOR' });
    const terrace = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Terrace 1', location: 'OUTDOOR' }).expect(201);
    expect(terrace.body).toMatchObject({ location: 'OUTDOOR' });
    await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Roof', location: 'ROOF' }).expect(400);

    const range = await http().post('/v1/tables/range').set(auth(menu.token)).send({ from: 1, to: 2, prefix: 'Garden', location: 'OUTDOOR' }).expect(201);
    expect(range.body.filter((row: { label: string }) => row.label.startsWith('Garden')).map((row: { location: string }) => row.location)).toEqual(['OUTDOOR', 'OUTDOOR']);

    const moved = await http().patch(`/v1/tables/${inside.body.id}`).set(auth(menu.token)).send({ location: 'OUTDOOR' }).expect(200);
    expect(moved.body).toMatchObject({ label: 'Hall 1', location: 'OUTDOOR' });
    const listed = await http().get('/v1/tables').set(auth(menu.token)).expect(200);
    expect(listed.body.find((row: { id: string }) => row.id === inside.body.id)).toMatchObject({ location: 'OUTDOOR' });

    const floor = await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200);
    expect(floor.body.find((row: { id: string }) => row.id === terrace.body.id)).toMatchObject({ location: 'OUTDOOR' });
  });

  it('creates tables with QR links and orders from a scanned table', async () => {
    const menu = await restaurantWithMenu();
    const table = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Table 1' }).expect(201);
    expect(table.body.qrUrl).toBe(`https://koshary.bilhanah.test/?t=${table.body.publicCode}`);
    expect((await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Table 1' }).expect(409)).body.error.code).toBe('TABLE_LABEL_TAKEN');

    const range = await http().post('/v1/tables/range').set(auth(menu.token)).send({ from: 1, to: 5, prefix: 'Table ' }).expect(201);
    expect(range.body.map((row: { label: string }) => row.label)).toEqual(['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Table 5']);
    const symbols = await http().post('/v1/tables/range').set(auth(menu.token)).send({ from: 1, to: 2, prefix: 'T-' }).expect(201);
    expect(symbols.body.map((row: { label: string }) => row.label).slice(-2)).toEqual(['T-1', 'T-2']);

    expect((await http().get(`/v1/public/restaurants/koshary/tables/${table.body.publicCode}`).expect(200)).body).toEqual({ label: 'Table 1', branch: 'main' });
    const order = await placeOrder(menu, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(201);
    expect(order.body.order.tableLabel).toBe('Table 1');

    // A new code retires the printed one and points to the same table, which keeps its settings and its orders.
    const configured = await http().patch(`/v1/tables/${table.body.id}`).set(auth(menu.token))
      .send({ seats: 6, shape: 'ROUND', notes: 'By the window', minOrderPiastres: 20_000 }).expect(200);
    const renewed = await http().post(`/v1/tables/${table.body.id}/code`).set(auth(menu.token)).expect(201);
    expect(renewed.body.publicCode).not.toBe(table.body.publicCode);
    expect(renewed.body.qrUrl).toBe(`https://koshary.bilhanah.test/?t=${renewed.body.publicCode}`);
    expect({ ...renewed.body, publicCode: undefined, qrUrl: undefined }).toEqual({ ...configured.body, publicCode: undefined, qrUrl: undefined });
    const stale = await placeOrder(menu, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(404);
    expect(stale.body.error.code).toBe('TABLE_NOT_FOUND');
    await http().get(`/v1/public/restaurants/koshary/tables/${table.body.publicCode}`).expect(404);
    expect((await http().get(`/v1/public/restaurants/koshary/tables/${renewed.body.publicCode}`).expect(200)).body).toEqual({ label: 'Table 1', branch: 'main' });
    await placeOrder(menu, { type: 'DINE_IN', tableCode: renewed.body.publicCode, customerPhone: undefined }).expect(201);
    // Both orders, before and after the new code, stay on the table's history.
    expect(await t.prisma.order.count({ where: { tableId: table.body.id } })).toBe(2);
    await http().delete(`/v1/tables/${table.body.id}`).set(auth(menu.token)).expect(204);
    expect((await http().get(`/v1/public/orders/${order.body.trackingToken}`).expect(200)).body.tableLabel).toBe('Table 1');
  });

  it("hides inactive tables and other restaurants' tables", async () => {
    const menu = await restaurantWithMenu();
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    const table = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Garden' }).expect(201);

    await http().patch(`/v1/tables/${table.body.id}`).set(auth(other.token)).send({ isActive: false }).expect(404);
    await http().patch(`/v1/tables/${table.body.id}`).set(auth(menu.token)).send({ isActive: false }).expect(200);
    await http().get(`/v1/public/restaurants/koshary/tables/${table.body.publicCode}`).expect(404);
    await http().get(`/v1/public/restaurants/other/tables/${table.body.publicCode}`).expect(404);
  });
});

describe('table areas', () => {
  const areas = (token: string) => http().get('/v1/table-areas').set(auth(token)).expect(200);

  it('creates, edits and lists areas, and their tables take the area\'s location', async () => {
    const menu = await restaurantWithMenu();
    const hall = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Main hall' }).expect(201);
    expect(hall.body).toMatchObject({ name: 'Main hall', location: 'INDOOR', theme: 'HALL', tableCount: 0, activeOrders: 0 });
    const garden = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Garden', location: 'OUTDOOR' }).expect(201);
    expect(garden.body.theme).toBe('TERRACE');
    const roof = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Roof', location: 'OUTDOOR', theme: 'ROOFTOP' }).expect(201);
    expect(roof.body.theme).toBe('ROOFTOP');
    expect((await http().patch(`/v1/table-areas/${garden.body.id}`).set(auth(menu.token)).send({ theme: 'GARDEN' }).expect(200)).body.theme).toBe('GARDEN');
    await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Pool', theme: 'POOL' }).expect(400);
    await http().delete(`/v1/table-areas/${roof.body.id}`).set(auth(menu.token)).expect(204);
    expect((await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Garden' }).expect(409)).body.error.code).toBe('TABLE_AREA_NAME_TAKEN');
    await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Moon', location: 'SPACE' }).expect(400);

    // Assigned when created: one table, and a range.
    const window = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Window', areaId: garden.body.id }).expect(201);
    expect(window.body).toMatchObject({ areaId: garden.body.id, location: 'OUTDOOR' });
    const range = await http().post('/v1/tables/range').set(auth(menu.token)).send({ from: 1, to: 2, prefix: 'Hall', areaId: hall.body.id, location: 'OUTDOOR' }).expect(201);
    expect(range.body.filter((row: { label: string }) => row.label.startsWith('Hall')).map((row: { areaId: string; location: string }) => [row.areaId, row.location]))
      .toEqual([[hall.body.id, 'INDOOR'], [hall.body.id, 'INDOOR']]);
    const loose = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Loose' }).expect(201);
    expect(loose.body.areaId).toBeNull();

    // Moved between areas, and out of any area.
    const moved = await http().patch(`/v1/tables/${window.body.id}`).set(auth(menu.token)).send({ areaId: hall.body.id }).expect(200);
    expect(moved.body).toMatchObject({ areaId: hall.body.id, location: 'INDOOR' });
    // While in an area, the table's own location follows the area.
    expect((await http().patch(`/v1/tables/${window.body.id}`).set(auth(menu.token)).send({ location: 'OUTDOOR' }).expect(200)).body.location).toBe('INDOOR');
    const out = await http().patch(`/v1/tables/${window.body.id}`).set(auth(menu.token)).send({ areaId: null, location: 'OUTDOOR' }).expect(200);
    expect(out.body).toMatchObject({ areaId: null, location: 'OUTDOOR' });

    // Renaming an area, and moving it outside moves its tables.
    const rooftop = await http().patch(`/v1/table-areas/${hall.body.id}`).set(auth(menu.token)).send({ name: 'Rooftop', location: 'OUTDOOR' }).expect(200);
    expect(rooftop.body).toMatchObject({ name: 'Rooftop', location: 'OUTDOOR', tableCount: 2 });
    const tables = (await http().get('/v1/tables').set(auth(menu.token)).expect(200)).body as { label: string; location: string }[];
    expect(tables.filter((row) => row.label.startsWith('Hall')).map((row) => row.location)).toEqual(['OUTDOOR', 'OUTDOOR']);
    expect((await areas(menu.token)).body.map((row: { name: string; tableCount: number }) => [row.name, row.tableCount])).toEqual([['Rooftop', 2], ['Garden', 0]]);

    const floor = await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200);
    expect(floor.body.find((row: { id: string }) => row.id === loose.body.id)).toMatchObject({ areaId: null });
  });

  it('refuses to delete an area with tables until they have somewhere to go', async () => {
    const menu = await restaurantWithMenu();
    const vip = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'VIP' }).expect(201);
    const garden = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Garden', location: 'OUTDOOR' }).expect(201);
    const table = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'VIP 1', areaId: vip.body.id }).expect(201);
    await placeOrder(menu, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(201);
    expect((await areas(menu.token)).body.find((row: { id: string }) => row.id === vip.body.id)).toMatchObject({ tableCount: 1, activeOrders: 1 });

    const refused = await http().delete(`/v1/table-areas/${vip.body.id}`).set(auth(menu.token)).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'TABLE_AREA_NOT_EMPTY', details: { tables: 1, activeOrders: 1 } });
    await http().delete(`/v1/table-areas/${vip.body.id}?moveTo=${vip.body.id}`).set(auth(menu.token)).expect(404);

    // Moved to the garden: the table takes its location and keeps its open order.
    await http().delete(`/v1/table-areas/${vip.body.id}?moveTo=${garden.body.id}`).set(auth(menu.token)).expect(204);
    const after = (await http().get('/v1/tables').set(auth(menu.token)).expect(200)).body.find((row: { id: string }) => row.id === table.body.id);
    expect(after).toMatchObject({ areaId: garden.body.id, location: 'OUTDOOR' });
    expect((await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200)).body.find((row: { id: string }) => row.id === table.body.id)).toMatchObject({ occupied: true });

    // "none" leaves the tables without an area; an empty area just goes.
    await http().delete(`/v1/table-areas/${garden.body.id}?moveTo=none`).set(auth(menu.token)).expect(204);
    expect((await http().get('/v1/tables').set(auth(menu.token)).expect(200)).body.find((row: { id: string }) => row.id === table.body.id)).toMatchObject({ areaId: null, location: 'OUTDOOR' });
    const empty = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Smoking' }).expect(201);
    await http().delete(`/v1/table-areas/${empty.body.id}`).set(auth(menu.token)).expect(204);
    expect((await areas(menu.token)).body).toEqual([]);
  });

  it("keeps each restaurant's areas to itself", async () => {
    const menu = await restaurantWithMenu();
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    const area = await http().post('/v1/table-areas').set(auth(menu.token)).send({ name: 'Garden' }).expect(201);
    expect((await areas(other.token)).body).toEqual([]);
    await http().patch(`/v1/table-areas/${area.body.id}`).set(auth(other.token)).send({ name: 'Mine' }).expect(404);
    await http().delete(`/v1/table-areas/${area.body.id}`).set(auth(other.token)).expect(404);
    expect((await http().post('/v1/tables').set(auth(other.token)).send({ label: 'Sneaky', areaId: area.body.id }).expect(404)).body.error.code).toBe('TABLE_AREA_NOT_FOUND');
  });
});

describe('floor plan details and reservations', () => {
  it('keeps where each table sits on the plan, its minimum order, notes and attributes', async () => {
    const menu = await restaurantWithMenu();
    const vip = await http().post('/v1/tables').set(auth(menu.token))
      .send({ label: 'VIP 1', minOrderPiastres: 50_000, notes: 'Near the window', attributes: ['VIP', 'WINDOW', 'VIP'] }).expect(201);
    expect(vip.body).toMatchObject({ minOrderPiastres: 50_000, notes: 'Near the window', attributes: ['VIP', 'WINDOW'], floorX: null, floorY: null });
    await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'Odd', attributes: ['JACUZZI'] }).expect(400);

    const placed = await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ floorX: 42.5, floorY: 18 }).expect(200);
    expect(placed.body).toMatchObject({ floorX: 42.5, floorY: 18, notes: 'Near the window' });
    await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ floorX: 140 }).expect(400);
    expect(placed.body).toMatchObject({ floorRotation: 0, floorScale: 1 });
    const turned = await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ floorRotation: -45, floorScale: 1.4 }).expect(200);
    expect(turned.body.floorRotation).toBe(315);
    expect(turned.body.floorScale).toBeCloseTo(1.4);
    await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ floorScale: 3 }).expect(400);
    expect((await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ floorRotation: 450 }).expect(200)).body.floorRotation).toBe(90);
    const cleared = await http().patch(`/v1/tables/${vip.body.id}`).set(auth(menu.token)).send({ minOrderPiastres: null, notes: '', attributes: [] }).expect(200);
    expect(cleared.body).toMatchObject({ minOrderPiastres: null, notes: null, attributes: [], floorX: 42.5 });
  });

  it('books tables, shows a booked table as reserved around its time, and lists bookings by day', async () => {
    const menu = await restaurantWithMenu();
    const table = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'T-3' }).expect(201);
    const soon = new Date(Date.now() + 45 * 60_000).toISOString();
    const later = new Date(Date.now() + 6 * 60 * 60_000).toISOString();

    const booking = await http().post('/v1/reservations').set(auth(menu.token))
      .send({ customerName: 'Mona', customerPhone: '0100 123 4567', guests: 4, reservedAt: soon, tableId: table.body.id }).expect(201);
    expect(booking.body).toMatchObject({ customerName: 'Mona', customerPhone: '01001234567', guests: 4, status: 'CONFIRMED', tableLabel: 'T-3' });
    await http().post('/v1/reservations').set(auth(menu.token)).send({ customerName: 'Karim', guests: 2, reservedAt: later }).expect(201);
    await http().post('/v1/reservations').set(auth(menu.token)).send({ customerName: 'Big', guests: 80, reservedAt: later }).expect(400);

    const floor = async () => (await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200)).body.find((row: { id: string }) => row.id === table.body.id);
    expect((await floor()).reservation).toMatchObject({ id: booking.body.id, customerName: 'Mona', guests: 4 });

    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const listed = await http().get(`/v1/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).set(auth(menu.token)).expect(200);
    expect(listed.body.map((row: { customerName: string }) => row.customerName)).toEqual(['Mona', 'Karim']);
    await http().get(`/v1/reservations?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`).set(auth(menu.token)).expect(400);

    // Filtering by status.
    const pendingOnly = await http().get(`/v1/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=PENDING`).set(auth(menu.token)).expect(200);
    expect(pendingOnly.body).toEqual([]);
    const confirmedOnly = await http().get(`/v1/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=CONFIRMED`).set(auth(menu.token)).expect(200);
    expect(confirmedOnly.body).toHaveLength(2);

    // No two active bookings on one table within RESERVATION_SLOT_MINUTES; a cancelled one frees its slot.
    const inAnHour = new Date(Date.parse(soon) + 60 * 60_000).toISOString();
    const clash = await http().post('/v1/reservations').set(auth(menu.token)).send({ customerName: 'Clash', guests: 2, reservedAt: inAnHour, tableId: table.body.id }).expect(409);
    expect(clash.body.error).toMatchObject({ code: 'RESERVATION_CONFLICT', details: { customerName: 'Mona' } });
    const threeHoursLater = new Date(Date.parse(soon) + 3 * 60 * 60_000).toISOString();
    const evening = await http().post('/v1/reservations').set(auth(menu.token)).send({ customerName: 'Evening', guests: 2, reservedAt: threeHoursLater, tableId: table.body.id }).expect(201);
    // Moving a booking onto a taken slot fails too; cancelling and coming back is checked again.
    expect((await http().patch(`/v1/reservations/${evening.body.id}`).set(auth(menu.token)).send({ reservedAt: inAnHour }).expect(409)).body.error.code).toBe('RESERVATION_CONFLICT');
    await http().patch(`/v1/reservations/${evening.body.id}`).set(auth(menu.token)).send({ status: 'CANCELLED' }).expect(200);
    await http().patch(`/v1/reservations/${evening.body.id}`).set(auth(menu.token)).send({ reservedAt: inAnHour }).expect(200);
    expect((await http().patch(`/v1/reservations/${evening.body.id}`).set(auth(menu.token)).send({ status: 'CONFIRMED' }).expect(409)).body.error.code).toBe('RESERVATION_CONFLICT');
    // Editing a booking's other details never trips over itself.
    await http().patch(`/v1/reservations/${booking.body.id}`).set(auth(menu.token)).send({ notes: 'Birthday', guests: 5 }).expect(200);

    // Only switched-on tables take bookings, and only a booking with a table can be seated.
    const off = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'T-9' }).expect(201);
    await http().patch(`/v1/tables/${off.body.id}`).set(auth(menu.token)).send({ isActive: false }).expect(200);
    expect((await http().post('/v1/reservations').set(auth(menu.token)).send({ customerName: 'Off', guests: 2, reservedAt: later, tableId: off.body.id }).expect(409)).body.error.code).toBe('RESERVATION_TABLE_UNAVAILABLE');
    const karim = listed.body.find((row: { customerName: string }) => row.customerName === 'Karim');
    expect((await http().patch(`/v1/reservations/${karim.id}`).set(auth(menu.token)).send({ status: 'SEATED' }).expect(409)).body.error.code).toBe('RESERVATION_TABLE_REQUIRED');

    // Seating the guests turns the hold into an occupied table with the party on it, until the bill is settled.
    const seated = await http().patch(`/v1/reservations/${booking.body.id}`).set(auth(menu.token)).send({ status: 'SEATED' }).expect(200);
    expect(seated.body.status).toBe('SEATED');
    expect(await floor()).toMatchObject({ occupied: true, reservation: null, seated: { id: booking.body.id, customerName: 'Mona', guests: 5 } });
    const settled = await http().post(`/v1/orders/tables/${table.body.id}/settle`).set(auth(menu.token)).send({}).expect(200);
    expect(settled.body.find((row: { id: string }) => row.id === table.body.id)).toMatchObject({ occupied: false, seated: null });
    const done = await http().get(`/v1/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=COMPLETED`).set(auth(menu.token)).expect(200);
    expect(done.body.map((row: { id: string }) => row.id)).toEqual([booking.body.id]);

    // Another restaurant cannot see, change or book onto these.
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    expect((await http().get(`/v1/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).set(auth(other.token)).expect(200)).body).toEqual([]);
    await http().patch(`/v1/reservations/${booking.body.id}`).set(auth(other.token)).send({ status: 'CANCELLED' }).expect(404);
    const stolen = await http().post('/v1/reservations').set(auth(other.token)).send({ customerName: 'X', guests: 2, reservedAt: soon, tableId: table.body.id }).expect(404);
    expect(stolen.body.error.code).toBe('TABLE_NOT_FOUND');
  });
});

describe('table statuses', () => {
  it('follows orders and bookings, turns to cleaning when the bill is paid, and refuses invalid changes', async () => {
    const menu = await restaurantWithMenu();
    const table = await http().post('/v1/tables').set(auth(menu.token)).send({ label: 'T-1' }).expect(201);
    expect(table.body.cleaning).toBe(false);
    const row = async () => (await http().get('/v1/orders/floor').set(auth(menu.token)).expect(200)).body.find((entry: { id: string }) => entry.id === table.body.id);
    const setStatus = (status: string) => http().patch(`/v1/orders/tables/${table.body.id}/status`).set(auth(menu.token)).send({ status });
    expect(await row()).toMatchObject({ status: 'AVAILABLE', occupied: false, cleaning: false });

    // An unpaid order makes it occupied; guests must be billed before it is cleaned or switched off.
    await placeOrder(menu, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(201);
    expect((await row()).status).toBe('OCCUPIED');
    const early = await setStatus('CLEANING').expect(409);
    expect(early.body.error).toMatchObject({ code: 'TABLE_STATUS_INVALID', details: { from: 'OCCUPIED', to: 'CLEANING' } });
    expect((await http().patch(`/v1/tables/${table.body.id}`).set(auth(menu.token)).send({ isActive: false }).expect(409)).body.error.code).toBe('TABLE_STATUS_INVALID');
    // OCCUPIED and RESERVED are never set by hand.
    await setStatus('OCCUPIED').expect(400);
    await setStatus('RESERVED').expect(400);

    // Settling the bill: the guests left, the table is to be cleaned (kept in the database), then ready again.
    const settled = await http().post(`/v1/orders/tables/${table.body.id}/settle`).set(auth(menu.token)).send({}).expect(200);
    expect(settled.body.find((entry: { id: string }) => entry.id === table.body.id)).toMatchObject({ status: 'CLEANING', occupied: false, cleaning: true });
    expect((await t.prisma.table.findUniqueOrThrow({ where: { id: table.body.id } })).condition).toBe('CLEANING');
    expect((await setStatus('AVAILABLE').expect(200)).body.find((entry: { id: string }) => entry.id === table.body.id).status).toBe('AVAILABLE');
    expect((await t.prisma.table.findUniqueOrThrow({ where: { id: table.body.id } })).condition).toBe('READY');

    // Paying the last open order on its own frees the table the same way.
    await placeOrder(menu, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(201);
    const open = await t.prisma.order.findFirstOrThrow({ where: { tableId: table.body.id, paidAt: null } });
    await http().patch(`/v1/orders/${open.id}/payment`).set(auth(menu.token)).send({ paid: true }).expect(200);
    expect((await row()).status).toBe('CLEANING');
    await setStatus('AVAILABLE').expect(200);

    // Switched off by hand: unavailable, off the floor and the menu; on again, available.
    await setStatus('UNAVAILABLE').expect(200);
    expect((await http().get('/v1/tables').set(auth(menu.token)).expect(200)).body.find((entry: { id: string }) => entry.id === table.body.id).isActive).toBe(false);
    expect(await row()).toBeUndefined();
    await http().get(`/v1/public/restaurants/koshary/tables/${table.body.publicCode}`).expect(404);
    await setStatus('AVAILABLE').expect(200);
    expect((await row()).status).toBe('AVAILABLE');

    // A booking holds it as reserved; cleaning before the guests arrive shows first.
    await http().post('/v1/reservations').set(auth(menu.token))
      .send({ customerName: 'Mona', guests: 2, reservedAt: new Date(Date.now() + 30 * 60_000).toISOString(), tableId: table.body.id }).expect(201);
    expect((await row()).status).toBe('RESERVED');
    await setStatus('CLEANING').expect(200);
    expect(await row()).toMatchObject({ status: 'CLEANING', reservation: { customerName: 'Mona' } });
    // Setting the status it already has changes nothing.
    await setStatus('CLEANING').expect(200);
    await setStatus('AVAILABLE').expect(200);
    expect((await row()).status).toBe('RESERVED');
  });
});

describe('rules', () => {
  it('keeps at least one order type and ordering only on plans that include it', async () => {
    const menu = await restaurantWithMenu();
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ acceptsDineIn: false }).expect(200);
    const none = await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ acceptsPickup: false }).expect(400);
    expect(none.body.error.code).toBe('VALIDATION_FAILED');

    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ orderingEnabled: false }).expect(200);
    await t.prisma.entitlement.updateMany({ data: { planCode: 'MENU' } });
    const upsell = await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ orderingEnabled: true }).expect(409);
    expect(upsell.body.error.code).toBe('ORDERING_UNAVAILABLE');
  });

  it('needs a reason to reject or cancel, and stamps every change', async () => {
    const menu = await restaurantWithMenu();
    const placed = await placeOrder(menu).expect(201);
    expect(placed.body.order.updatedAt).toEqual(expect.any(String));
    const [{ id }] = (await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.items;

    expect((await setStatus(menu.token, id, 'REJECTED').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    const accepted = await setStatus(menu.token, id, 'ACCEPTED').expect(200);
    expect(Date.parse(accepted.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(placed.body.order.updatedAt));
    await setStatus(menu.token, id, 'CANCELLED').expect(400);
    await setStatus(menu.token, id, 'CANCELLED', 'Gas cut').expect(200);
  });

  it('treats malformed tracking links as unknown orders', async () => {
    await http().get('/v1/public/orders/not-a-token').expect(404);
  });
});

describe('live updates', () => {
  it('pushes new orders to the restaurant and status changes to both sides', async () => {
    const menu = await restaurantWithMenu();
    const other = await restaurantWithMenu('other@koshary.test', 'other');
    const owner = await connect('/owner', menu.token);
    const outsider = await connect('/owner', other.token);
    let leaked = false;
    outsider.on('order.created', () => (leaked = true));

    const created = nextEvent<{ order: { number: number; customerPhone: string } }>(owner, 'order.created');
    const placed = await placeOrder(menu).expect(201);
    expect((await created).order).toMatchObject({ number: 1, customerPhone: '01098765432' });

    const diner = await connect('/track', placed.body.trackingToken);
    const ownerUpdate = nextEvent<{ order: { status: string } }>(owner, 'order.updated');
    const dinerUpdate = nextEvent<{ order: { status: string; customerPhone?: string } }>(diner, 'order.updated');
    const [{ id }] = (await http().get('/v1/orders').set(auth(menu.token)).expect(200)).body.items;
    await setStatus(menu.token, id, 'ACCEPTED').expect(200);

    expect((await ownerUpdate).order.status).toBe('ACCEPTED');
    const update = await dinerUpdate;
    expect(update.order.status).toBe('ACCEPTED');
    expect(update.order).not.toHaveProperty('customerPhone');
    expect(leaked).toBe(false);

    for (const socket of [owner, outsider, diner]) socket.close();
  });

  it("tells the owner's other devices when ordering settings change", async () => {
    const menu = await restaurantWithMenu();
    const owner = await connect('/owner', menu.token);
    const update = nextEvent<{ ordering: { paused: boolean } }>(owner, 'restaurant.updated');
    await http().patch('/v1/restaurants/mine').set(auth(menu.token)).send({ ordersPaused: true }).expect(200);
    expect((await update).ordering.paused).toBe(true);
    owner.close();
  });

  it('refuses sockets without a valid token', async () => {
    await expect(connect('/owner', 'not-a-token')).rejects.toThrow('UNAUTHENTICATED');
    await expect(connect('/track', 'AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA')).rejects.toThrow('ORDER_NOT_FOUND');
  });

  it('cleans up order numbers by day', async () => {
    const menu = await restaurantWithMenu();
    await placeOrder(menu).expect(201);
    // Yesterday's counter does not affect today's numbers.
    await t.prisma.orderCounter.create({
      data: { branchId: (await t.prisma.branch.findFirstOrThrow({ where: { restaurantId: menu.restaurantId, isMain: true } })).id, businessDay: new Date(Date.now() - DAY_MS), lastNumber: 99 },
    });
    expect((await placeOrder(menu).expect(201)).body.order.number).toBe(2);
  });
});
