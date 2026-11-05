import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const GUEST = 'x-table-guest';

/** An owner with ordering on, two dishes and one table. */
async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201)).body;
  const tea = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'شاي', variants: [{ pricePiastres: 1000 }] }).expect(201)).body;
  const table = (await http().post('/v1/tables').set(auth(token)).send({ label: '7' }).expect(201)).body as { id: string; publicCode: string };
  const dish = (item: { id: string; variants: { id: string }[] }) => ({ menuItemId: item.id, variantId: item.variants[0]!.id });
  return { token, subdomain, table, koshary: dish(koshary), tea: dish(tea), kosharyItem: koshary };
}

const join = (subdomain: string, code: string, body: Record<string, unknown> = {}) => http().post(`/v1/public/restaurants/${subdomain}/tables/${code}/join`).send(body);
const view = (guest: string) => http().get('/v1/public/table-session').set(GUEST, guest);
const add = (guest: string, dish: { menuItemId: string; variantId: string }, quantity = 1, note?: string) =>
  http().post('/v1/public/table-session/items').set(GUEST, guest).send({ ...dish, quantity, ...(note && { note }) });
const submit = (guest: string, body: Record<string, unknown> = {}, key = randomUUID()) =>
  http().post('/v1/public/table-session/submit').set(GUEST, guest).set('Idempotency-Key', key).send(body);

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('shared table sessions', () => {
  it('lets several guests join one session, add their own dishes, and send them as attributed orders', async () => {
    const r = await restaurant();
    // Six phones scan at the same moment: one session, six guests.
    const joins = await Promise.all(Array.from({ length: 6 }, (_, index) => join(r.subdomain, r.table.publicCode, index === 0 ? { displayName: 'Mona' } : {})));
    for (const response of joins) expect(response.status).toBe(200);
    expect(new Set(joins.map((response) => response.body.sessionToken)).size).toBe(1);
    expect(await t.prisma.tableSession.count({ where: { tableId: r.table.id, status: { not: 'CLOSED' } } })).toBe(1);
    const mona = joins[0]!.body.guestToken as string;
    const ali = joins[1]!.body.guestToken as string;
    expect(new Set(joins.map((response) => response.body.me.number))).toEqual(new Set([1, 2, 3, 4, 5, 6]));

    // Rejoining (a refresh) keeps the same guest.
    const again = await join(r.subdomain, r.table.publicCode, { guestToken: mona }).expect(200);
    expect(again.body.me).toMatchObject({ id: joins[0]!.body.me.id, name: 'Mona' });

    // Concurrent adds from two phones: nobody loses dishes.
    await Promise.all([add(mona, r.koshary, 2), add(ali, r.tea, 1), add(ali, r.koshary, 1)]);
    const shared = (await view(mona).expect(200)).body;
    expect(shared.items).toHaveLength(3);
    expect(shared.draftTotalPiastres).toBe(2 * 3500 + 1000 + 3500);
    expect(shared.myDraftTotalPiastres).toBe(7000);
    const alisKoshary = shared.items.find((item: { mine: boolean; menuItemId: string }) => !item.mine && item.menuItemId === r.koshary.menuItemId);
    expect(alisKoshary).toMatchObject({ editable: false, guest: { id: joins[1]!.body.me.id } });

    // Only their own unsent dishes: Mona cannot touch Ali's.
    expect((await http().patch(`/v1/public/table-session/items/${alisKoshary.id}`).set(GUEST, mona).send({ quantity: 3, version: alisKoshary.version }).expect(403)).body.error.code).toBe('TABLE_SESSION_ITEM_NOT_YOURS');
    await http().delete(`/v1/public/table-session/items/${alisKoshary.id}`).set(GUEST, mona).expect(403);
    // A stale version is refused.
    const alisView = (await view(ali).expect(200)).body;
    const own = alisView.items.find((item: { id: string }) => item.id === alisKoshary.id);
    await http().patch(`/v1/public/table-session/items/${own.id}`).set(GUEST, ali).send({ quantity: 2, version: own.version }).expect(200);
    expect((await http().patch(`/v1/public/table-session/items/${own.id}`).set(GUEST, ali).send({ quantity: 4, version: own.version }).expect(409)).body.error.code).toBe('TABLE_SESSION_ITEM_STALE');

    // Mona sends hers: an ordinary dine-in order on the board, attributed to her.
    const total = (await view(mona)).body.myDraftTotalPiastres;
    const key = randomUUID();
    const sent = await submit(mona, { scope: 'MINE', expectedTotalPiastres: total }, key).expect(201);
    expect(sent.body.order).toMatchObject({ type: 'DINE_IN', tableLabel: '7', subtotalPiastres: 7000 });
    expect(sent.body.order.items[0].guestName).toBe('Mona');
    // A retry with the same key returns the same order; nothing is sent twice.
    const retry = await submit(mona, { scope: 'MINE' }, key).expect(201);
    expect(retry.body.order.number).toBe(sent.body.order.number);
    expect(await t.prisma.order.count()).toBe(1);
    // Sent dishes no longer change through the cart.
    const sentItem = sent.body.session.items.find((item: { status: string }) => item.status === 'SUBMITTED');
    expect(sentItem).toMatchObject({ editable: false, order: { number: sent.body.order.number, status: 'PLACED' } });
    expect((await http().delete(`/v1/public/table-session/items/${sentItem.id}`).set(GUEST, mona).expect(409)).body.error.code).toBe('TABLE_SESSION_ITEM_SUBMITTED');
    expect((await submit(mona, { scope: 'MINE' }).expect(409)).body.error.code).toBe('TABLE_SESSION_NOTHING_TO_SUBMIT');

    // Ali sends the rest of the table as one round.
    const board = await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200);
    expect(board.body.items).toHaveLength(1);
    const round = await submit(ali, { scope: 'TABLE' }).expect(201);
    expect(round.body.order.subtotalPiastres).toBe(1000 + 2 * 3500);
    const owner = await http().get(`/v1/orders/${board.body.items[0].id}`).set(auth(r.token)).expect(200);
    expect(owner.body.items.map((line: { guestName: string }) => line.guestName)).toEqual(['Mona']);
  });

  it('checks availability and prices again before sending', async () => {
    const r = await restaurant();
    const guest = (await join(r.subdomain, r.table.publicCode).expect(200)).body.guestToken;
    await add(guest, r.koshary, 1).expect(200);
    // The branch raises the price after the dish was added.
    const branchId = (await http().get('/v1/branches').set(auth(r.token)).expect(200)).body.branches[0].id;
    await http().put(`/v1/branches/${branchId}/menu/items/${r.kosharyItem.id}`).set(auth(r.token)).send({ prices: [{ variantId: r.koshary.variantId, pricePiastres: 4000 }] }).expect(200);
    const changed = await submit(guest).expect(409);
    expect(changed.body.error).toMatchObject({ code: 'TABLE_SESSION_PRICES_CHANGED', details: { totalPiastres: 4000 } });
    expect((await view(guest)).body.draftTotalPiastres).toBe(4000);
    await submit(guest, { expectedTotalPiastres: 4000 }).expect(201);

    await add(guest, r.tea, 1).expect(200);
    await http().patch(`/v1/menu/items/${r.tea.menuItemId}`).set(auth(r.token)).send({ isAvailable: false }).expect(200);
    expect((await submit(guest).expect(409)).body.error.code).toBe('ITEMS_UNAVAILABLE');
    expect((await add(guest, r.tea, 1).expect(409)).body.error.code).toBe('ITEMS_UNAVAILABLE');
  });

  it('stops new dishes once the table asks for the bill, and closes with the bill', async () => {
    const r = await restaurant();
    const joined = (await join(r.subdomain, r.table.publicCode).expect(200)).body;
    const guest = joined.guestToken;
    await add(guest, r.koshary).expect(200);

    const socket: Socket = await new Promise((resolve, reject) => {
      const live = io(`${baseUrl}/table`, { path: '/v1/realtime', transports: ['websocket'], auth: { token: joined.sessionToken }, reconnection: false });
      live.on('connect', () => resolve(live));
      live.on('connect_error', reject);
    });
    const event = new Promise<{ status: string }>((resolve) => socket.once('table-session.updated', resolve));
    await http().post('/v1/public/service-requests').send({ sessionToken: joined.sessionToken, type: 'REQUEST_BILL' }).expect(200);
    expect((await event).status).toBe('CLOSING');
    socket.close();
    expect((await view(guest)).body.status).toBe('CLOSING');
    expect((await add(guest, r.tea).expect(409)).body.error.code).toBe('TABLE_SESSION_CLOSING');

    // The staff reopen it, the guests order, and the bill settles the table.
    const [open] = (await http().get('/v1/table-sessions').set(auth(r.token)).expect(200)).body;
    expect(open).toMatchObject({ tableLabel: '7', status: 'CLOSING', guests: 1, draftItems: 1 });
    await http().patch(`/v1/table-sessions/${open.id}`).set(auth(r.token)).send({ status: 'ACTIVE' }).expect(200);
    await submit(guest).expect(201);
    await http().post(`/v1/orders/tables/${r.table.id}/settle`).set(auth(r.token)).send({ method: 'CARD' }).expect(200);
    expect((await view(guest)).body).toMatchObject({ status: 'CLOSED', closedReason: 'SETTLED' });
    expect((await add(guest, r.tea).expect(409)).body.error).toMatchObject({ code: 'TABLE_SESSION_CLOSED', details: { reason: 'SETTLED' } });
    // The next scan starts a new session; the old guest token does not rejoin a closed one.
    const next = await join(r.subdomain, r.table.publicCode, { guestToken: guest }).expect(200);
    expect(next.body.sessionToken).not.toBe(joined.sessionToken);
    expect(next.body.items).toEqual([]);

    const stats = await http().get('/v1/table-sessions/stats').set(auth(r.token)).expect(200);
    expect(stats.body).toMatchObject({ sessions: 2, joinedSessions: 2, guests: 2, sessionsWithOrders: 1, dineInOrders: 1, sharedOrders: 1, adoptionRate: 1, duplicateIncidents: 0 });
  });

  it('expires idle sessions and isolates sessions by restaurant', async () => {
    const r = await restaurant();
    const guest = (await join(r.subdomain, r.table.publicCode).expect(200)).body.guestToken;
    expect((await view('forged.token').expect(401)).body.error.code).toBe('TABLE_GUEST_INVALID');
    await http().get('/v1/public/table-session').expect(401);
    // Another restaurant's code under this subdomain is unknown.
    const other = await restaurant('owner@felfela.test', 'felfela');
    await join(r.subdomain, other.table.publicCode).expect(404);
    expect((await http().get('/v1/table-sessions').set(auth(other.token)).expect(200)).body).toEqual([]);

    await t.prisma.tableSession.updateMany({ data: { lastActivityAt: new Date(Date.now() - 5 * 3600_000) } });
    expect((await view(guest)).body).toMatchObject({ status: 'CLOSED', closedReason: 'EXPIRED' });
    expect((await add(guest, r.koshary).expect(409)).body.error.code).toBe('TABLE_SESSION_CLOSED');

    // Switched off by the owner: the menu works as before, without shared sessions.
    await http().patch('/v1/restaurants/mine').set(auth(r.token)).send({ tableSessionsEnabled: false }).expect(200);
    expect((await join(r.subdomain, r.table.publicCode).expect(403)).body.error.code).toBe('TABLE_SESSION_UNAVAILABLE');
    await http().post(`/v1/public/restaurants/${r.subdomain}/orders`).set('Idempotency-Key', randomUUID())
      .send({ type: 'DINE_IN', tableCode: r.table.publicCode, customerName: 'Mona', items: [{ ...r.koshary, quantity: 1 }] }).expect(201);
  });
});
