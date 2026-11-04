import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ROLE_PERMISSIONS } from '@bilhanah/contracts';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An owner with ordering on and one dish. */
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
  return { token, subdomain, item: { id: item.body.id as string, variant: item.body.variants[0].id as string } };
}

/** Creates a staff account with the owner's (or a manager's) token and signs it in. */
async function staff(by: string, role: string, email: string, extra: Record<string, unknown> = {}) {
  const created = await http().post('/v1/kitchen-accounts').set(auth(by)).send({ fullName: `${role} one`, email, password: 'staff-password', role, ...extra }).expect(201);
  const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200);
  return { id: created.body.id as string, token: login.body.accessToken as string };
}

const placeOrder = (item: { id: string; variant: string }, subdomain = 'koshary') =>
  http()
    .post(`/v1/public/restaurants/${subdomain}/orders`)
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: item.id, variantId: item.variant, quantity: 1 }] })
    .expect(201);

const status = (token: string, id: string, to: string) => http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status: to });

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('roles and permissions', () => {
  it('sends each account its permissions, and 401s without a session', async () => {
    const r = await restaurant();
    const me = await http().get('/v1/auth/me').set(auth(r.token)).expect(200);
    expect(me.body.permissions).toEqual(expect.arrayContaining(['billing.manage', 'roles.assign', 'staff.manage']));
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    const context = await http().get('/v1/kitchen/context').set(auth(cashier.token)).expect(200);
    expect(context.body.role).toBe('CASHIER');
    expect([...context.body.permissions].sort()).toEqual([...ROLE_PERMISSIONS.CASHIER].sort());
    await http().get('/v1/orders?view=active').expect(401);
  });

  it('a cashier takes payments and completes orders, but cannot change the menu, staff, settings or refund', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    const order = (await placeOrder(r.item)).body.order;
    const { id } = (await http().get('/v1/orders?view=active').set(auth(cashier.token)).expect(200)).body.items[0];

    // Accepting is the kitchen's (orders.update); completing a ready order is the cashier's.
    expect((await status(cashier.token, id, 'ACCEPTED').expect(403)).body.error.code).toBe('FORBIDDEN');
    await status(r.token, id, 'ACCEPTED').expect(200);
    await status(r.token, id, 'READY').expect(200);
    await status(cashier.token, id, 'COMPLETED').expect(200);

    await http().patch(`/v1/orders/${id}/payment`).set(auth(cashier.token)).send({ paid: true }).expect(200);
    // Marking it unpaid again is a refund, which a cashier needs to be granted.
    await http().patch(`/v1/orders/${id}/payment`).set(auth(cashier.token)).send({ paid: false }).expect(403);

    await http().post('/v1/menu/categories').set(auth(cashier.token)).send({ nameAr: 'حلو' }).expect(403);
    await http().patch(`/v1/menu/items/${r.item.id}`).set(auth(cashier.token)).send({ isAvailable: false }).expect(403);
    await http().get('/v1/kitchen-accounts').set(auth(cashier.token)).expect(403);
    await http().patch('/v1/restaurants/mine').set(auth(cashier.token)).send({ name: 'Mine' }).expect(403);
    await http().get('/v1/billing').set(auth(cashier.token)).expect(403);
    await http().get('/v1/restaurants/mine/stats/branches').set(auth(cashier.token)).expect(403);
    // The dashboard's figures, without revenue.
    const stats = await http().get('/v1/restaurants/mine/stats?days=7').set(auth(cashier.token)).expect(200);
    expect(stats.body).toMatchObject({ financial: false, totals: { revenuePiastres: 0 } });
    expect(order.status).toBe('PLACED');
  });

  it('a granted refund applies at once, without signing in again', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await placeOrder(r.item);
    const { id } = (await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200)).body.items[0];
    await http().patch(`/v1/orders/${id}/payment`).set(auth(cashier.token)).send({ paid: true }).expect(200);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(cashier.token)).send({ paid: false }).expect(403);
    await http().patch(`/v1/kitchen-accounts/${cashier.id}`).set(auth(r.token)).send({ permissions: ['payments.refund'] }).expect(200);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(cashier.token)).send({ paid: false }).expect(200);
    // A waiter cannot be given refunds.
    const refused = await http().post('/v1/kitchen-accounts').set(auth(r.token))
      .send({ fullName: 'Waiter', email: 'w@koshary.test', password: 'staff-password', role: 'WAITER', permissions: ['payments.refund'] }).expect(403);
    expect(refused.body.error.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('a waiter sees tables and takes bookings, but cannot take payments or read finances', async () => {
    const r = await restaurant();
    await http().post('/v1/tables').set(auth(r.token)).send({ label: 'T1' }).expect(201);
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    const tables = (await http().get('/v1/tables').set(auth(waiter.token)).expect(200)).body;
    expect(tables).toHaveLength(1);
    await http().get('/v1/orders/floor').set(auth(waiter.token)).expect(200);
    await http().post('/v1/tables').set(auth(waiter.token)).send({ label: 'T2' }).expect(403);
    await http()
      .post('/v1/reservations').set(auth(waiter.token))
      .send({ customerName: 'Ali', guests: 2, reservedAt: new Date(Date.now() + 3_600_000).toISOString(), tableId: tables[0].id })
      .expect(201);
    const range = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`;
    expect((await http().get(`/v1/reservations?${range}`).set(auth(waiter.token)).expect(200)).body).toHaveLength(1);
    await http().post(`/v1/orders/tables/${tables[0].id}/settle`).set(auth(waiter.token)).expect(403);
    await http().get('/v1/restaurants/mine/stats?days=7').set(auth(waiter.token)).expect(403);
    await http().get('/v1/orders/tracking-stats?days=7').set(auth(waiter.token)).expect(403);
  });

  it('the kitchen moves orders but cannot take payments, manage tables or bookings', async () => {
    const r = await restaurant();
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    await placeOrder(r.item);
    const { id } = (await http().get('/v1/orders?view=active').set(auth(kitchen.token)).expect(200)).body.items[0];
    await status(kitchen.token, id, 'ACCEPTED').expect(200);
    await status(kitchen.token, id, 'PREPARING').expect(200);
    await status(kitchen.token, id, 'READY').expect(200);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(kitchen.token)).send({ paid: true }).expect(403);
    await http().get('/v1/tables').set(auth(kitchen.token)).expect(403);
    await http().get('/v1/reservations').set(auth(kitchen.token)).expect(403);
    await http().get('/v1/restaurants/mine/stats?days=7').set(auth(kitchen.token)).expect(403);
  });
});

describe('staff management', () => {
  it('a manager manages the roles below theirs, never owners, managers, or themselves', async () => {
    const r = await restaurant();
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    const other = await staff(r.token, 'MANAGER', 'manager2@koshary.test');

    const options = (await http().get('/v1/kitchen-accounts/options').set(auth(manager.token)).expect(200)).body;
    expect(options.roles).toEqual(['CASHIER', 'WAITER', 'KITCHEN']);

    const waiter = await staff(manager.token, 'WAITER', 'waiter@koshary.test');
    // Promote a waiter to manager, or make a manager: refused.
    expect((await http().patch(`/v1/kitchen-accounts/${waiter.id}`).set(auth(manager.token)).send({ role: 'MANAGER' }).expect(403)).body.error.code).toBe('ROLE_NOT_ASSIGNABLE');
    await http().post('/v1/kitchen-accounts').set(auth(manager.token)).send({ fullName: 'Xavier', email: 'x@koshary.test', password: 'staff-password', role: 'MANAGER' }).expect(403);
    // OWNER is not a role anyone can give.
    await http().post('/v1/kitchen-accounts').set(auth(r.token)).send({ fullName: 'Xavier', email: 'x@koshary.test', password: 'staff-password', role: 'OWNER' }).expect(400);
    // Another manager's account, and their own.
    await http().patch(`/v1/kitchen-accounts/${other.id}`).set(auth(manager.token)).send({ active: false }).expect(403);
    expect((await http().patch(`/v1/kitchen-accounts/${manager.id}`).set(auth(manager.token)).send({ permissions: ['payments.refund'] }).expect(403)).body.error.code).toBe('SELF_CHANGE_FORBIDDEN');
    // A grant they do not hold themselves.
    await http().patch(`/v1/kitchen-accounts/${waiter.id}`).set(auth(manager.token)).send({ role: 'CASHIER', permissions: ['payments.refund'] }).expect(403);
    // What they may do works.
    await http().patch(`/v1/kitchen-accounts/${waiter.id}`).set(auth(manager.token)).send({ role: 'CASHIER' }).expect(200);
  });

  it('deactivating signs the account out at once, and every change is logged', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await http().get('/v1/tables').set(auth(waiter.token)).expect(200);
    await http().patch(`/v1/kitchen-accounts/${waiter.id}`).set(auth(r.token)).send({ active: false }).expect(200);
    await http().get('/v1/tables').set(auth(waiter.token)).expect(401);
    const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'waiter@koshary.test', password: 'staff-password' }).expect(403);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');

    await http().patch(`/v1/kitchen-accounts/${waiter.id}`).set(auth(r.token)).send({ active: true, role: 'CASHIER' }).expect(200);
    const log = (await http().get('/v1/kitchen-accounts/activity').set(auth(r.token)).expect(200)).body as { action: string; actorName: string; from: string | null; to: string | null }[];
    // Newest first; the last two were one change.
    expect(log.map((entry) => entry.action).slice(2)).toEqual(['staff.deactivated', 'staff.created']);
    expect(log.map((entry) => entry.action).slice(0, 2).sort()).toEqual(['staff.activated', 'staff.role_changed']);
    expect(log.find((entry) => entry.action === 'staff.role_changed')).toMatchObject({ from: 'WAITER', to: 'CASHIER' });
    expect(log.every((entry) => entry.actorName)).toBe(true);
  });

  it('keeps restaurants apart: another restaurant\'s staff and orders look unknown', async () => {
    const a = await restaurant();
    const b = await restaurant('owner@felfela.test', 'felfela');
    const bWaiter = await staff(b.token, 'WAITER', 'waiter@felfela.test');
    await placeOrder(a.item);
    const { id } = (await http().get('/v1/orders?view=active').set(auth(a.token)).expect(200)).body.items[0];

    await http().patch(`/v1/kitchen-accounts/${bWaiter.id}`).set(auth(a.token)).send({ active: false }).expect(404);
    await http().delete(`/v1/kitchen-accounts/${bWaiter.id}`).set(auth(a.token)).expect(404);
    await http().get(`/v1/orders/${id}`).set(auth(b.token)).expect(404);
    await status(b.token, id, 'ACCEPTED').expect(404);
    expect((await http().get('/v1/kitchen-accounts').set(auth(a.token)).expect(200)).body).toEqual([]);
  });
});
