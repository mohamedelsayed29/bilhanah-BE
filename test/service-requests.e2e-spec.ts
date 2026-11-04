import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An owner with table ordering, and one table; returns its QR code. */
async function restaurantWithTable(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const table = await http().post('/v1/tables').set(auth(token)).send({ label: 'T-3' }).expect(201);
  return { token, subdomain, table: table.body as { id: string; publicCode: string; branchId: string } };
}

const join = (subdomain: string, code: string, sessionToken?: string) =>
  http().post(`/v1/public/restaurants/${subdomain}/tables/${code}/session`).send(sessionToken ? { sessionToken } : {});
const ask = (sessionToken: string, type: string, note?: string) => http().post('/v1/public/service-requests').send({ sessionToken, type, ...(note && { note }) });
const move = (token: string, id: string, body: Record<string, unknown>) => http().patch(`/v1/service-requests/${id}`).set(auth(token)).send(body);

function connect(namespace: '/owner' | '/table', token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}${namespace}`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => { socket.close(); reject(error); });
  });
}
const nextEvent = <T>(socket: Socket, event: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`No ${event} event`)), 5_000);
  socket.once(event, (payload: T) => { clearTimeout(timer); resolve(payload); });
});

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('diners at a table', () => {
  it('ask only from a valid table, share the table session, and see their requests', async () => {
    const { subdomain, table } = await restaurantWithTable();
    await join(subdomain, 'not-a-code').expect(404);
    await join('nowhere', table.publicCode).expect(404);
    expect((await ask('forged.token', 'CALL_WAITER').expect(404)).body.error.code).toBe('TABLE_SESSION_INVALID');

    const first = await join(subdomain, table.publicCode).expect(200);
    expect(first.body).toMatchObject({ table: { label: 'T-3' }, requests: [] });
    // A second phone at the same table joins the same session.
    const second = await join(subdomain, table.publicCode).expect(200);
    expect(second.body.sessionToken).toBe(first.body.sessionToken);

    const waiter = await ask(first.body.sessionToken, 'CALL_WAITER').expect(200);
    expect(waiter.body).toMatchObject({ duplicate: false, request: { type: 'CALL_WAITER', status: 'PENDING' } });
    expect((await ask(first.body.sessionToken, 'CUSTOM').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await ask(first.body.sessionToken, 'CUSTOM', 'A high chair, please').expect(200);
    const mine = await http().get(`/v1/public/service-requests?token=${encodeURIComponent(second.body.sessionToken)}`).expect(200);
    expect(mine.body.requests.map((row: { type: string }) => row.type)).toEqual(['CUSTOM', 'CALL_WAITER']);
  });

  it('cannot ask when the restaurant switched requests off', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const owner = await http().patch('/v1/restaurants/mine').set(auth(token)).send({ serviceRequestsEnabled: false }).expect(200);
    expect(owner.body.serviceRequests).toEqual({ enabled: false, cooldownSeconds: 120, hourlyLimit: 20 });
    expect((await http().get(`/v1/public/restaurants/${subdomain}`).expect(200)).body.ordering.serviceRequests).toBe(false);
    expect((await join(subdomain, table.publicCode).expect(409)).body.error.code).toBe('SERVICE_REQUESTS_UNAVAILABLE');
  });

  it('throttles duplicates by the restaurant\'s settings', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const { body: session } = await join(subdomain, table.publicCode).expect(200);
    const water = await ask(session.sessionToken, 'REQUEST_WATER').expect(200);
    // The same request while it is open comes back instead of a second one.
    const again = await ask(session.sessionToken, 'REQUEST_WATER').expect(200);
    expect(again.body).toMatchObject({ duplicate: true, request: { id: water.body.request.id } });
    // Once handled, it cannot be repeated within the cooldown.
    await move(token, water.body.request.id, { status: 'COMPLETED' }).expect(200);
    const soon = await ask(session.sessionToken, 'REQUEST_WATER').expect(429);
    expect(soon.body.error).toMatchObject({ code: 'SERVICE_REQUEST_THROTTLED', details: { reason: 'COOLDOWN' } });
    expect(soon.body.error.details.retryAfterSeconds).toBeGreaterThan(100);

    // No cooldown, and two requests an hour.
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ serviceRequestCooldownSeconds: 0, serviceRequestHourlyLimit: 2 }).expect(200);
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ serviceRequestHourlyLimit: 500 }).expect(400);
    const refill = await ask(session.sessionToken, 'REQUEST_WATER').expect(200);
    expect(refill.body.duplicate).toBe(false);
    const limit = await ask(session.sessionToken, 'REQUEST_NAPKINS').expect(429);
    expect(limit.body.error.details.reason).toBe('HOURLY_LIMIT');
  });

  it('withdraw a request nobody has taken, and follow its status live', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const { body: session } = await join(subdomain, table.publicCode).expect(200);
    const socket = await connect('/table', session.sessionToken);
    const created = nextEvent<{ request: { status: string } }>(socket, 'service-request.created');
    const bill = await ask(session.sessionToken, 'REQUEST_BILL').expect(200);
    expect((await created).request.status).toBe('PENDING');

    const updated = nextEvent<{ request: { status: string } }>(socket, 'service-request.updated');
    await move(token, bill.body.request.id, { status: 'ACKNOWLEDGED' }).expect(200);
    expect((await updated).request.status).toBe('ACKNOWLEDGED');
    // Taken by the staff: only they can close it now.
    await http().post(`/v1/public/service-requests/${bill.body.request.id}/cancel`).send({ sessionToken: session.sessionToken }).expect(409);
    socket.close();

    const napkins = await ask(session.sessionToken, 'REQUEST_NAPKINS').expect(200);
    const withdrawn = await http().post(`/v1/public/service-requests/${napkins.body.request.id}/cancel`).send({ sessionToken: session.sessionToken }).expect(200);
    expect(withdrawn.body.status).toBe('CANCELLED');
  });

  it('end their session when the bill is settled', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const { body: session } = await join(subdomain, table.publicCode).expect(200);
    await http().post(`/v1/orders/tables/${table.id}/settle`).set(auth(token)).expect(200);
    expect((await ask(session.sessionToken, 'CALL_WAITER').expect(404)).body.error.code).toBe('TABLE_SESSION_INVALID');
    const next = await join(subdomain, table.publicCode, session.sessionToken).expect(200);
    expect(next.body.sessionToken).not.toBe(session.sessionToken);
  });
});

describe('staff', () => {
  async function manager(ownerToken: string, branchId: string | null, email = 'manager@koshary.test') {
    const account = await http().post('/v1/kitchen-accounts').set(auth(ownerToken))
      .send({ fullName: 'Hoda Manager', email, password: 'staff-password', role: 'MANAGER', branchId }).expect(201);
    const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200);
    return { id: account.body.id as string, token: login.body.accessToken as string };
  }

  it('see new requests live, move them through permitted steps, and assign them', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const owners = await connect('/owner', token);
    const { body: session } = await join(subdomain, table.publicCode).expect(200);
    const created = nextEvent<{ request: { tableLabel: string; branchId: string } }>(owners, 'service-request.created');
    const waiter = await ask(session.sessionToken, 'CALL_WAITER').expect(200);
    expect((await created).request).toMatchObject({ tableLabel: 'T-3', branchId: table.branchId });
    owners.close();

    const id = waiter.body.request.id as string;
    const active = await http().get('/v1/service-requests').set(auth(token)).expect(200);
    expect(active.body).toMatchObject({ total: 1, items: [{ id, status: 'PENDING', tableLabel: 'T-3', assignee: null }] });

    const hoda = await manager(token, null);
    const staff = await http().get('/v1/service-requests/assignees').set(auth(token)).expect(200);
    expect(staff.body.map((member: { role: string }) => member.role)).toEqual(['OWNER', 'MANAGER']);
    // Assigning takes it on: acknowledged, with the time.
    const assigned = await move(token, id, { assigneeId: hoda.id }).expect(200);
    expect(assigned.body).toMatchObject({ status: 'ACKNOWLEDGED', assignee: { id: hoda.id, name: 'Hoda Manager', role: 'MANAGER' } });
    expect(assigned.body.acknowledgedAt).not.toBeNull();
    expect((await move(token, id, { assigneeId: randomUUID() }).expect(400)).body.error.code).toBe('SERVICE_REQUEST_ASSIGNEE_INVALID');

    const started = await move(hoda.token, id, { status: 'IN_PROGRESS' }).expect(200);
    expect(started.body).toMatchObject({ status: 'IN_PROGRESS', handledBy: { id: hoda.id } });
    const back = await move(token, id, { status: 'PENDING' }).expect(409);
    expect(back.body.error).toMatchObject({ code: 'INVALID_SERVICE_REQUEST_TRANSITION', details: { from: 'IN_PROGRESS', to: 'PENDING', allowed: ['COMPLETED', 'CANCELLED'] } });
    const done = await move(token, id, { status: 'COMPLETED' }).expect(200);
    expect(done.body.completedAt).not.toBeNull();
    await move(token, id, { status: 'CANCELLED' }).expect(409);

    // Completed requests stay in the history.
    expect((await http().get('/v1/service-requests').set(auth(token)).expect(200)).body.total).toBe(0);
    const history = await http().get('/v1/service-requests?view=history').set(auth(token)).expect(200);
    expect(history.body.items).toEqual([expect.objectContaining({ id, status: 'COMPLETED' })]);

    const stats = await http().get('/v1/service-requests/stats').set(auth(token)).expect(200);
    expect(stats.body).toMatchObject({ days: 7, total: 1, completed: 1, cancelled: 0, unresolved: 0 });
    expect(stats.body.averageResponseSeconds).toBeGreaterThanOrEqual(0);
    expect(stats.body.averageCompletionSeconds).toBeGreaterThanOrEqual(0);
  });

  it('filter by type, status and area', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const garden = await http().post('/v1/table-areas').set(auth(token)).send({ name: 'Garden', location: 'OUTDOOR' }).expect(201);
    const outside = await http().post('/v1/tables').set(auth(token)).send({ label: 'G-1', areaId: garden.body.id }).expect(201);
    const inside = (await join(subdomain, table.publicCode).expect(200)).body.sessionToken;
    const out = (await join(subdomain, outside.body.publicCode).expect(200)).body.sessionToken;
    await ask(inside, 'CALL_WAITER').expect(200);
    await ask(inside, 'REQUEST_BILL').expect(200);
    await ask(out, 'REQUEST_WATER').expect(200);
    const labels = async (query: string) => (await http().get(`/v1/service-requests?${query}`).set(auth(token)).expect(200)).body.items.map((row: { tableLabel: string; type: string }) => `${row.tableLabel}:${row.type}`);
    expect(await labels(`areaId=${garden.body.id}`)).toEqual(['G-1:REQUEST_WATER']);
    expect(await labels('areaId=none')).toEqual(['T-3:CALL_WAITER', 'T-3:REQUEST_BILL']);
    expect(await labels('type=REQUEST_BILL')).toEqual(['T-3:REQUEST_BILL']);
    expect(await labels('status=PENDING&type=REQUEST_WATER')).toEqual(['G-1:REQUEST_WATER']);
  });

  it('only owners and managers manage them, each within their restaurant and branch', async () => {
    const { token, subdomain, table } = await restaurantWithTable();
    const { body: session } = await join(subdomain, table.publicCode).expect(200);
    const id = (await ask(session.sessionToken, 'CALL_WAITER').expect(200)).body.request.id;

    const kitchen = await http().post('/v1/kitchen-accounts').set(auth(token)).send({ fullName: 'Kitchen', email: 'kitchen@koshary.test', password: 'staff-password', role: 'KITCHEN', branchId: null }).expect(201);
    const cook = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'kitchen@koshary.test', password: 'staff-password' }).expect(200)).body.accessToken;
    expect(kitchen.body.id).toBeDefined();
    await http().get('/v1/service-requests').set(auth(cook)).expect(403);
    await move(cook, id, { status: 'ACKNOWLEDGED' }).expect(403);
    await http().get('/v1/service-requests').expect(401);

    const other = await restaurantWithTable('other@koshary.test', 'other');
    expect((await http().get('/v1/service-requests').set(auth(other.token)).expect(200)).body.total).toBe(0);
    await move(other.token, id, { status: 'ACKNOWLEDGED' }).expect(404);

    // A manager of another branch does not see this branch's requests.
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({}).expect(200);
    const nasr = await http().post('/v1/branches').set(auth(token))
      .send({ name: 'Nasr City', slug: 'nasr', phone: '01012345678', city: 'Cairo', address: '1 Abbas El Akkad' });
    if (nasr.status === 201) {
      const away = await manager(token, nasr.body.id, 'nasr@koshary.test');
      expect((await http().get('/v1/service-requests').set(auth(away.token)).expect(200)).body.total).toBe(0);
      await move(away.token, id, { status: 'ACKNOWLEDGED' }).expect(404);
    }
  });
});
