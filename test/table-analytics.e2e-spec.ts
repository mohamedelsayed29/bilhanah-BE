import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const GUEST = 'x-table-guest';

type Table = { id: string; label: string; publicCode: string };
type Row = { id: string; label: string; seatings: number; orders: number; revenuePiastres: number | null; scans: number; averageOccupancyMinutes: number | null; turnoverRate: number; areaName: string | null };

async function restaurant() {
  const token = await signUpOwner(t, 'owner@koshary.test');
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201)).body;
  const garden = (await http().post('/v1/table-areas').set(auth(token)).send({ name: 'Garden', location: 'OUTDOOR' }).expect(201)).body;
  const t1: Table = (await http().post('/v1/tables').set(auth(token)).send({ label: 'T1', areaId: garden.id }).expect(201)).body;
  const t2: Table = (await http().post('/v1/tables').set(auth(token)).send({ label: 'T2' }).expect(201)).body;
  const t3: Table = (await http().post('/v1/tables').set(auth(token)).send({ label: 'T3' }).expect(201)).body;
  const dish = { menuItemId: koshary.id as string, variantId: koshary.variants[0].id as string };
  return { token, garden, t1, t2, t3, dish };
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('table analytics', () => {
  it('counts seatings, occupancy, paid revenue, turnover and QR scans per table, by period and area', async () => {
    const r = await restaurant();
    const stats = (query = '') => http().get(`/v1/restaurants/mine/stats/tables?from=${today()}&to=${today()}${query}`).set(auth(r.token));

    // QR scans: the same phone again within half an hour is one scan; another phone is another.
    const scan = (code: string, agent: string) => http().get(`/v1/public/restaurants/koshary/tables/${code}`).set('User-Agent', agent).expect(200);
    await scan(r.t1.publicCode, 'phone-a');
    await scan(r.t1.publicCode, 'phone-a');
    await scan(r.t1.publicCode, 'phone-b');
    await scan(r.t2.publicCode, 'phone-a');

    // T1: a shared table session, paid and closed by settling the table.
    const guest = (await http().post(`/v1/public/restaurants/koshary/tables/${r.t1.publicCode}/join`).send({}).expect(200)).body.guestToken;
    await http().post('/v1/public/table-session/items').set(GUEST, guest).send({ ...r.dish, quantity: 2 }).expect(200);
    await http().post('/v1/public/table-session/submit').set(GUEST, guest).set('Idempotency-Key', randomUUID()).send({}).expect(201);
    await http().post(`/v1/orders/tables/${r.t1.id}/settle`).set(auth(r.token)).send({}).expect(200);
    // T2: two orders without a session, paid together: one seating from the first order to the payment.
    const place = (code: string) => http().post('/v1/public/restaurants/koshary/orders').set('Idempotency-Key', randomUUID())
      .send({ type: 'DINE_IN', tableCode: code, customerName: 'Ali', items: [{ ...r.dish, quantity: 1 }] }).expect(201);
    await place(r.t2.publicCode);
    await place(r.t2.publicCode);
    await http().post(`/v1/orders/tables/${r.t2.id}/settle`).set(auth(r.token)).send({}).expect(200);
    // T3: an order not paid yet: used, but no revenue and no finished seating.
    await place(r.t3.publicCode);
    // A rejected order counts for nothing.
    await place(r.t3.publicCode);
    const rejected = await t.prisma.order.findFirstOrThrow({ where: { tableId: r.t3.id }, orderBy: { placedAt: 'desc' } });
    await http().patch(`/v1/orders/${rejected.id}/status`).set(auth(r.token)).send({ status: 'REJECTED', reason: 'Closed' }).expect(200);

    const all = (await stats().expect(200)).body;
    expect(all).toMatchObject({ from: today(), to: today(), days: 1 });
    expect(all.now).toEqual({ total: 3, available: 0, occupied: 1, reserved: 0, cleaning: 2, unavailable: 0 });
    const row = (label: string) => (all.tables as Row[]).find((entry) => entry.label === label)!;
    expect(row('T1')).toMatchObject({ seatings: 1, orders: 1, revenuePiastres: 7000, scans: 2, areaName: 'Garden', turnoverRate: 1 });
    expect(row('T2')).toMatchObject({ seatings: 1, orders: 2, revenuePiastres: 7000, scans: 1 });
    expect(row('T3')).toMatchObject({ seatings: 1, orders: 1, revenuePiastres: 0, scans: 0, averageOccupancyMinutes: null });
    expect(row('T1').averageOccupancyMinutes).toEqual(expect.any(Number));
    expect(all.summary).toMatchObject({ seatings: 3, orders: 4, revenuePiastres: 14_000, scans: 3, turnoverRate: 1, scanTrackingSince: today() });

    // By area: the garden alone, or the tables in no area.
    const garden = (await stats(`&areaId=${r.garden.id}`).expect(200)).body;
    expect(garden.tables.map((entry: Row) => entry.label)).toEqual(['T1']);
    expect(garden.now.total).toBe(1);
    const none = (await stats('&areaId=NONE').expect(200)).body;
    expect(none.tables.map((entry: Row) => entry.label).sort()).toEqual(['T2', 'T3']);

    // An earlier period has nothing yet.
    const lastYear = `${Number(today().slice(0, 4)) - 1}${today().slice(4)}`;
    const before = (await http().get(`/v1/restaurants/mine/stats/tables?from=${lastYear}&to=${lastYear}`).set(auth(r.token)).expect(200)).body;
    expect(before.summary).toMatchObject({ seatings: 0, orders: 0, scans: 0 });

    // Ranges are checked; waiters do not read analytics.
    await http().get(`/v1/restaurants/mine/stats/tables?from=${today()}&to=${lastYear}`).set(auth(r.token)).expect(400);
    await http().get(`/v1/restaurants/mine/stats/tables?from=${lastYear}&to=${today()}`).set(auth(r.token)).expect(400);
    await http().post('/v1/kitchen-accounts').set(auth(r.token)).send({ fullName: 'Waiter', email: 'waiter@koshary.test', password: 'staff-password', role: 'WAITER' }).expect(201);
    const waiter = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'waiter@koshary.test', password: 'staff-password' }).expect(200)).body.accessToken;
    await http().get(`/v1/restaurants/mine/stats/tables?from=${today()}&to=${today()}`).set(auth(waiter)).expect(403);
  });
});
