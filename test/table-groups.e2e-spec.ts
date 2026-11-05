import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const GUEST = 'x-table-guest';

type Table = { id: string; label: string; publicCode: string; seats: number; groupId: string | null };
type FloorRow = { id: string; status: string; occupied: boolean; openOrders: unknown[]; group: { id: string; tableIds: string[]; seats: number; leadTableId: string } | null };

/** An owner with ordering on, one dish and six tables (T1..T6, four seats each, T6 outdoors). */
async function restaurant() {
  const token = await signUpOwner(t, 'owner@koshary.test');
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201)).body;
  const tables: Table[] = [];
  for (const label of ['T1', 'T2', 'T3', 'T4', 'T5']) tables.push((await http().post('/v1/tables').set(auth(token)).send({ label, seats: 4 }).expect(201)).body);
  tables.push((await http().post('/v1/tables').set(auth(token)).send({ label: 'T6', seats: 4, location: 'OUTDOOR' }).expect(201)).body);
  return { token, tables, dish: { menuItemId: koshary.id as string, variantId: koshary.variants[0].id as string } };
}

const join = (code: string) => http().post(`/v1/public/restaurants/koshary/tables/${code}/join`).send({});
const order = async (code: string, dish: { menuItemId: string; variantId: string }) => {
  const guest = (await join(code).expect(200)).body.guestToken as string;
  await http().post('/v1/public/table-session/items').set(GUEST, guest).send({ ...dish, quantity: 1 }).expect(200);
  await http().post('/v1/public/table-session/submit').set(GUEST, guest).set('Idempotency-Key', randomUUID()).send({}).expect(201);
  return guest;
};

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('merged tables', () => {
  it('merges tables into one seating with their seats, one session, one status and one bill, then separates them', async () => {
    const r = await restaurant();
    const [t1, t2, t3] = r.tables as [Table, Table, Table];
    const floor = async () => (await http().get('/v1/orders/floor').set(auth(r.token)).expect(200)).body as FloorRow[];
    const row = async (id: string) => (await floor()).find((entry) => entry.id === id)!;

    const group = await http().post('/v1/table-groups').set(auth(r.token)).send({ tableIds: [t1.id, t2.id], label: 'Family' }).expect(201);
    expect(group.body).toMatchObject({ label: 'Family', tableIds: [t1.id, t2.id], tableLabels: ['T1', 'T2'], seats: 8, leadTableId: t1.id });
    expect((await row(t1.id)).group).toMatchObject({ id: group.body.id, tableIds: [t1.id, t2.id], seats: 8 });
    expect((await http().get('/v1/tables').set(auth(r.token)).expect(200)).body.find((table: Table) => table.id === t2.id).groupId).toBe(group.body.id);

    // A merged table is in one group only, and moves with it.
    expect((await http().post('/v1/table-groups').set(auth(r.token)).send({ tableIds: [t2.id, t3.id] }).expect(409)).body.error.code).toBe('TABLE_GROUP_INVALID');
    expect((await http().patch(`/v1/tables/${t2.id}`).set(auth(r.token)).send({ isActive: false }).expect(409)).body.error.code).toBe('TABLE_IN_GROUP');
    expect((await http().patch(`/v1/orders/tables/${t2.id}/status`).set(auth(r.token)).send({ status: 'UNAVAILABLE' }).expect(409)).body.error.code).toBe('TABLE_IN_GROUP');
    expect((await http().delete(`/v1/tables/${t2.id}`).set(auth(r.token)).expect(409)).body.error.code).toBe('TABLE_IN_GROUP');

    // Scanning either table joins the same session; an order from T2 makes the whole group occupied.
    const fromT1 = (await join(t1.publicCode).expect(200)).body.sessionToken;
    const fromT2 = (await join(t2.publicCode).expect(200)).body.sessionToken;
    expect(fromT2).toBe(fromT1);
    expect(await t.prisma.tableSession.count({ where: { status: { not: 'CLOSED' } } })).toBe(1);
    await order(t2.publicCode, r.dish);
    expect((await row(t1.id)).status).toBe('OCCUPIED');
    expect((await row(t2.id)).status).toBe('OCCUPIED');

    // Guests at the group: it cannot be separated until the bill is settled; settling one member settles all.
    expect((await http().delete(`/v1/table-groups/${group.body.id}`).set(auth(r.token)).expect(409)).body.error.code).toBe('TABLE_GROUP_BUSY');
    const settled = (await http().post(`/v1/orders/tables/${t2.id}/settle`).set(auth(r.token)).send({}).expect(200)).body as FloorRow[];
    for (const id of [t1.id, t2.id]) expect(settled.find((entry) => entry.id === id)).toMatchObject({ status: 'CLEANING', openOrders: [] });
    expect(await t.prisma.tableSession.count({ where: { status: { not: 'CLOSED' } } })).toBe(0);
    // Cleaning one member cleans the group.
    await http().patch(`/v1/orders/tables/${t1.id}/status`).set(auth(r.token)).send({ status: 'AVAILABLE' }).expect(200);
    expect((await row(t2.id)).status).toBe('AVAILABLE');

    // Separated: each table on its own again, with its history.
    await http().delete(`/v1/table-groups/${group.body.id}`).set(auth(r.token)).expect(204);
    for (const id of [t1.id, t2.id]) expect((await row(id)).group).toBeNull();
    const kept = await t.prisma.tableGroup.findUniqueOrThrow({ where: { id: group.body.id } });
    expect(kept).toMatchObject({ tableIds: [t1.id, t2.id] });
    expect(kept.dissolvedAt).not.toBeNull();
    expect(await t.prisma.order.count({ where: { tableId: { in: [t1.id, t2.id] }, paidAt: { not: null } } })).toBe(1);
    expect((await http().get('/v1/tables').set(auth(r.token)).expect(200)).body.find((table: Table) => table.id === t2.id)).toMatchObject({ groupId: null, seats: 4 });
    await http().delete(`/v1/table-groups/${group.body.id}`).set(auth(r.token)).expect(404);
    // Each table now has its own session again.
    expect((await join(t2.publicCode).expect(200)).body.sessionToken).not.toBe(fromT1);
  });

  it('refuses tables with different parties, other areas, switched-off tables and single tables', async () => {
    const r = await restaurant();
    const [t1, t2, t3, t4, t5, t6] = r.tables as [Table, Table, Table, Table, Table, Table];
    const merge = (tableIds: string[]) => http().post('/v1/table-groups').set(auth(r.token)).send({ tableIds });

    // Guests at two tables: two parties.
    await order(t1.publicCode, r.dish);
    await order(t2.publicCode, r.dish);
    const clash = await merge([t1.id, t2.id]).expect(409);
    expect(clash.body.error).toMatchObject({ code: 'TABLE_GROUP_CONFLICT', details: { tables: ['T1', 'T2'] } });
    // Guests at one and a booking coming at another: also two parties.
    await http().post('/v1/reservations').set(auth(r.token)).send({ customerName: 'Mona', guests: 6, reservedAt: new Date(Date.now() + 30 * 60_000).toISOString(), tableId: t3.id }).expect(201);
    expect((await merge([t1.id, t3.id]).expect(409)).body.error.code).toBe('TABLE_GROUP_CONFLICT');
    // One party is fine: the group shares its table's session, so that table leads.
    const withParty = await merge([t4.id, t1.id]).expect(201);
    expect(withParty.body.leadTableId).toBe(t1.id);
    // A booking with a free table is fine too.
    expect((await merge([t3.id, t5.id]).expect(201)).body.leadTableId).toBe(t3.id);

    // Another location, a switched-off table, one table, too many.
    await http().patch(`/v1/tables/${t2.id}`).set(auth(r.token)).send({ isActive: true }).expect(200);
    expect((await merge([t2.id, t6.id]).expect(409)).body.error.code).toBe('TABLE_GROUP_INVALID');
    await http().post(`/v1/orders/tables/${t2.id}/settle`).set(auth(r.token)).send({}).expect(200);
    await http().patch(`/v1/orders/tables/${t6.id}/status`).set(auth(r.token)).send({ status: 'UNAVAILABLE' }).expect(200);
    await http().patch(`/v1/tables/${t6.id}`).set(auth(r.token)).send({ location: 'INDOOR' }).expect(200);
    expect((await merge([t2.id, t6.id]).expect(409)).body.error.code).toBe('TABLE_GROUP_INVALID');
    await merge([t2.id]).expect(400);
    await merge([t2.id, t2.id]).expect(400);
    await merge(Array.from({ length: 9 }, () => randomUUID())).expect(400);
  });
});
