import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const GUEST = 'x-table-guest';

type Table = { id: string; label: string; publicCode: string };
type FloorRow = { id: string; status: string; openOrders: { id: string }[] };

/** An owner with ordering on, one dish and five tables. */
async function restaurant() {
  const token = await signUpOwner(t, 'owner@koshary.test');
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201)).body;
  const tables: Table[] = [];
  for (const label of ['T1', 'T2', 'T3', 'T4', 'T5']) tables.push((await http().post('/v1/tables').set(auth(token)).send({ label }).expect(201)).body);
  return { token, tables, dish: { menuItemId: koshary.id as string, variantId: koshary.variants[0].id as string } };
}

/** A guest at the table sends one dish with a note; returns the guest token. */
async function order(code: string, dish: { menuItemId: string; variantId: string }, guest?: string) {
  const token = guest ?? (await http().post(`/v1/public/restaurants/koshary/tables/${code}/join`).send({ displayName: 'Mona' }).expect(200)).body.guestToken as string;
  await http().post('/v1/public/table-session/items').set(GUEST, token).send({ ...dish, quantity: 2, note: 'no onions' }).expect(200);
  await http().post('/v1/public/table-session/submit').set(GUEST, token).set('Idempotency-Key', randomUUID()).send({}).expect(201);
  return token;
}

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('moving an order to another table', () => {
  it('moves the order with everything on it, takes the guests along, records the move, and updates both tables', async () => {
    const r = await restaurant();
    const [t1, t2, t3, t4, t5] = r.tables as [Table, Table, Table, Table, Table];
    const floor = async () => (await http().get('/v1/orders/floor').set(auth(r.token)).expect(200)).body as FloorRow[];
    const statusOf = async (id: string) => (await floor()).find((row) => row.id === id)!.status;
    const active = async () => (await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200)).body.items as { id: string; tableLabel: string }[];

    const guest = await order(t1.publicCode, r.dish);
    const [placed] = await active();
    await http().patch(`/v1/orders/${placed!.id}/status`).set(auth(r.token)).send({ status: 'ACCEPTED' }).expect(200);
    const before = (await http().get(`/v1/orders/${placed!.id}`).set(auth(r.token)).expect(200)).body;

    const moved = await http().post(`/v1/orders/${placed!.id}/transfer`).set(auth(r.token)).send({ tableId: t2.id, reason: 'Wanted the window' }).expect(200);
    // Everything but the table is as it was: items, quantities, prices, notes, payment, status history.
    for (const field of ['items', 'subtotalPiastres', 'paymentMethod', 'paid', 'status', 'history', 'number', 'customerName']) {
      expect(moved.body[field], field).toEqual(before[field]);
    }
    expect(moved.body.tableLabel).toBe('T2');
    expect(moved.body.transfers).toEqual([{ fromTableLabel: 'T1', toTableLabel: 'T2', at: expect.any(String), actorName: expect.any(String), reason: 'Wanted the window' }]);
    expect(await t.prisma.order.findUniqueOrThrow({ where: { id: placed!.id } })).toMatchObject({ tableId: t2.id, tableLabel: 'T2' });
    expect(await t.prisma.orderTableTransfer.findFirstOrThrow({ where: { orderId: placed!.id } })).toMatchObject({ fromTableId: t1.id, toTableId: t2.id });

    // The guests moved too: the new table is occupied, the old one is to be cleaned, and their session follows.
    expect(await statusOf(t2.id)).toBe('OCCUPIED');
    expect(await statusOf(t1.id)).toBe('CLEANING');
    expect(await t.prisma.tableSession.findFirstOrThrow({ where: { status: { not: 'CLOSED' } } })).toMatchObject({ tableId: t2.id });
    expect((await http().get('/v1/public/table-session').set(GUEST, guest).expect(200)).body.me.name).toBe('Mona');

    // Not onto a table being cleaned, switched off, booked, with other guests, or the one it is at.
    const move = (tableId: string) => http().post(`/v1/orders/${placed!.id}/transfer`).set(auth(r.token)).send({ tableId });
    expect((await move(t1.id).expect(409)).body.error).toMatchObject({ code: 'TABLE_TRANSFER_INVALID', details: { status: 'CLEANING' } });
    expect((await move(t2.id).expect(409)).body.error.details.status).toBe('SAME');
    await http().patch(`/v1/orders/tables/${t3.id}/status`).set(auth(r.token)).send({ status: 'UNAVAILABLE' }).expect(200);
    expect((await move(t3.id).expect(409)).body.error.details.status).toBe('UNAVAILABLE');
    await order(t4.publicCode, r.dish);
    expect((await move(t4.id).expect(409)).body.error.details.status).toBe('OCCUPIED');
    await http().post('/v1/reservations').set(auth(r.token)).send({ customerName: 'Karim', guests: 2, reservedAt: new Date(Date.now() + 30 * 60_000).toISOString(), tableId: t5.id }).expect(201);
    expect((await move(t5.id).expect(409)).body.error.details.status).toBe('RESERVED');
    expect((await move(randomUUID()).expect(404)).body.error.code).toBe('TABLE_NOT_FOUND');
    expect(await t.prisma.orderTableTransfer.count()).toBe(1);

    // Part of a party: a second order moves alone; the first stays, so do the guests and the table's status.
    await order(t2.publicCode, r.dish, guest);
    const second = (await active()).find((entry) => entry.tableLabel === 'T2' && entry.id !== placed!.id)!;
    await http().patch(`/v1/orders/tables/${t3.id}/status`).set(auth(r.token)).send({ status: 'AVAILABLE' }).expect(200);
    await http().post(`/v1/orders/${second.id}/transfer`).set(auth(r.token)).send({ tableId: t3.id }).expect(200);
    expect(await statusOf(t2.id)).toBe('OCCUPIED');
    expect(await statusOf(t3.id)).toBe('OCCUPIED');
    expect(await t.prisma.tableSession.findFirstOrThrow({ where: { status: { not: 'CLOSED' } }, orderBy: { startedAt: 'asc' } })).toMatchObject({ tableId: t2.id });

    // Rejected, or completed and paid: nothing to move.
    await http().patch(`/v1/orders/${second.id}/status`).set(auth(r.token)).send({ status: 'REJECTED', reason: 'Out of stock' }).expect(200);
    expect((await http().post(`/v1/orders/${second.id}/transfer`).set(auth(r.token)).send({ tableId: t1.id }).expect(409)).body.error.code).toBe('ORDER_NOT_TRANSFERABLE');
  });

  it('lets waiters move orders, not other restaurants', async () => {
    const r = await restaurant();
    const [t1, t2] = r.tables as [Table, Table];
    await order(t1.publicCode, r.dish);
    const [placed] = (await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200)).body.items as { id: string }[];
    await http().post('/v1/kitchen-accounts').set(auth(r.token))
      .send({ fullName: 'Waiter', email: 'waiter@koshary.test', password: 'staff-password', role: 'WAITER' }).expect(201);
    const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'waiter@koshary.test', password: 'staff-password' }).expect(200);
    const moved = await http().post(`/v1/orders/${placed!.id}/transfer`).set(auth(login.body.accessToken)).send({ tableId: t2.id }).expect(200);
    expect(moved.body.transfers[0]).toMatchObject({ fromTableLabel: 'T1', toTableLabel: 'T2', actorName: 'Waiter' });
    const other = await signUpOwner(t, 'other@koshary.test');
    await http().post(`/v1/orders/${placed!.id}/transfer`).set(auth(other)).send({ tableId: t2.id }).expect(404);
  });
});
