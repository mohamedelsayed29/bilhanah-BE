import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const KITCHEN = { fullName: 'Main kitchen', email: 'kitchen@koshary.test', password: 'kitchen-password' };

/** An owner with ordering on and one dish; returns the owner's token and the dish. */
async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const item = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  return { token, item: { id: item.body.id as string, variant: item.body.variants[0].id as string } };
}

const login = (email: string, password: string) => http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password });

const placeOrder = (item: { id: string; variant: string }, subdomain = 'koshary') =>
  http()
    .post(`/v1/public/restaurants/${subdomain}/orders`)
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: item.id, variantId: item.variant, quantity: 1 }] })
    .expect(201);

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/owner`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

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

describe('kitchen accounts', () => {
  it('lets the owner create one that signs in, sees the board live and moves orders, and nothing else', async () => {
    const owner = await restaurant();
    const created = await http().post('/v1/kitchen-accounts').set(auth(owner.token)).send(KITCHEN).expect(201);
    expect(created.body).toMatchObject({ fullName: 'Main kitchen', email: 'kitchen@koshary.test', active: true, lastSeenAt: null });

    const session = await login(KITCHEN.email, KITCHEN.password).expect(200);
    expect(session.body.user.role).toBe('KITCHEN');
    const token = session.body.accessToken as string;

    const context = await http().get('/v1/kitchen/context').set(auth(token)).expect(200);
    expect(context.body).toMatchObject({ restaurant: { name: 'Koshary Abou Tarek', subdomain: 'koshary' }, ordering: { included: true, enabled: true, paused: false } });

    const socket = await connect(token);
    const event = new Promise<{ order: { id: string } }>((resolve) => socket.once('order.created', resolve));
    const placed = await placeOrder(owner.item);
    const live = await event;
    socket.close();

    const board = await http().get('/v1/orders?view=active').set(auth(token)).expect(200);
    expect(board.body.items).toHaveLength(1);
    const id = board.body.items[0].id as string;
    expect(live.order.id).toBe(id);
    expect(placed.body.order.number).toBe(board.body.items[0].number);
    await http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status: 'ACCEPTED' }).expect(200);
    await http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status: 'PREPARING' }).expect(200);
    const ready = await http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status: 'READY' }).expect(200);
    expect(ready.body.status).toBe('READY');

    // Owner-only routes are refused.
    await http().patch(`/v1/orders/${id}/payment`).set(auth(token)).send({ paid: true }).expect(403);
    await http().get('/v1/restaurants/mine').set(auth(token)).expect(403);
    await http().get('/v1/menu').set(auth(token)).expect(403);
    await http().get('/v1/kitchen-accounts').set(auth(token)).expect(403);
    await http().get('/v1/kitchen/context').set(auth(owner.token)).expect(403);
  });

  it('refuses a taken email and keeps other restaurants’ accounts out of reach', async () => {
    const first = await restaurant();
    const second = await restaurant('owner@fatta.test', 'fatta');
    const taken = await http().post('/v1/kitchen-accounts').set(auth(first.token)).send({ ...KITCHEN, email: 'owner@fatta.test' }).expect(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');

    const account = await http().post('/v1/kitchen-accounts').set(auth(first.token)).send(KITCHEN).expect(201);
    await http().delete(`/v1/kitchen-accounts/${account.body.id}`).set(auth(second.token)).expect(404);
    expect((await http().get('/v1/kitchen-accounts').set(auth(second.token)).expect(200)).body).toEqual([]);

    // A kitchen only sees its own restaurant's orders.
    await placeOrder(second.item, 'fatta');
    const token = (await login(KITCHEN.email, KITCHEN.password).expect(200)).body.accessToken as string;
    expect((await http().get('/v1/orders?view=active').set(auth(token)).expect(200)).body.items).toEqual([]);
  });

  it('signs the screens out when the owner turns the account off, changes its password or deletes it', async () => {
    const owner = await restaurant();
    const id = (await http().post('/v1/kitchen-accounts').set(auth(owner.token)).send(KITCHEN).expect(201)).body.id as string;

    let token = (await login(KITCHEN.email, KITCHEN.password).expect(200)).body.accessToken as string;
    const off = await http().patch(`/v1/kitchen-accounts/${id}`).set(auth(owner.token)).send({ active: false }).expect(200);
    expect(off.body.active).toBe(false);
    await http().get('/v1/orders?view=active').set(auth(token)).expect(401);
    expect((await login(KITCHEN.email, KITCHEN.password).expect(403)).body.error.code).toBe('ACCOUNT_SUSPENDED');

    await http().patch(`/v1/kitchen-accounts/${id}`).set(auth(owner.token)).send({ active: true }).expect(200);
    token = (await login(KITCHEN.email, KITCHEN.password).expect(200)).body.accessToken as string;
    await http().post(`/v1/kitchen-accounts/${id}/password`).set(auth(owner.token)).send({ password: 'a-new-password' }).expect(204);
    await http().get('/v1/orders?view=active').set(auth(token)).expect(401);
    await login(KITCHEN.email, KITCHEN.password).expect(401);
    token = (await login(KITCHEN.email, 'a-new-password').expect(200)).body.accessToken as string;

    await http().delete(`/v1/kitchen-accounts/${id}`).set(auth(owner.token)).expect(204);
    await http().get('/v1/orders?view=active').set(auth(token)).expect(401);
    expect(await t.prisma.user.count({ where: { id } })).toBe(0);
  });
});
