import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

/**
 * POS security (docs/POS.md): subscription entitlements, registered devices, branch scope, permissions,
 * the administrator's controls, and PIN sign-in. Every POS request passes, in order: the signed-in account,
 * an active subscription with the POS on, an ACTIVE registered device of that restaurant and branch, and
 * the permission it needs.
 */
let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const on = (token: string, device: string) => ({ ...auth(token), 'X-Pos-Device': device });
const login = async (email: string, password = 'staff-password') =>
  (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password }).expect(200)).body.accessToken as string;

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

const SETTINGS = {
  taxRateBps: 0, taxInclusive: true, serviceChargeBps: 0, serviceChargeDineInOnly: true, paymentMethods: ['CASH', 'CARD'],
  cashierMaxDiscountPercent: 0, requireOpenShift: false, receiptHeader: null, receiptFooter: null, receiptShowLogo: false,
};

/** An owner with an ACTIVE POS, a dish, a cashier, and one device registered at the main branch. */
async function setUp(email = 'owner@koshary.test', subdomain = 'koshary', admin?: string) {
  const token = await signUpOwner(t, email);
  const restaurant = (await http().post('/v1/restaurants').set(auth(token))
    .send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201)).body;
  const adminToken = admin ?? (await signInAdmin(t)).token;
  await http().put('/v1/admin/pos/settings').set(auth(adminToken)).send({ enabled: true, plans: ['ORDERS', 'ADVANCED'] }).expect(200);
  await http().post('/v1/pos/activate').set(auth(token)).send({ mode: 'BILHANAH' }).expect(201);
  await http().put('/v1/pos/settings').set(auth(token)).send(SETTINGS).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const dish = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 5000 }] }).expect(201)).body;
  const branchId = (await http().get('/v1/branches').set(auth(token)).expect(200)).body.branches[0].id as string;
  const device = (await http().post('/v1/pos/devices').set(auth(token)).send({ name: 'Counter', branchId }).expect(201)).body;
  const cashierEmail = `cashier@${subdomain}.test`;
  const cashierAccount = (await http().post('/v1/kitchen-accounts').set(auth(token)).send({ fullName: 'Cashier One', email: cashierEmail, password: 'staff-password', role: 'CASHIER' }).expect(201)).body;
  return {
    token, admin: adminToken, id: restaurant.id as string, branchId, device: device.deviceKey as string, deviceId: device.device.id as string,
    cashier: await login(cashierEmail), cashierId: cashierAccount.id as string,
    line: { menuItemId: dish.id as string, variantId: dish.variants[0].id as string, quantity: 1 },
  };
}
let keys = 0;
const place = (headers: Record<string, string>, body: Record<string, unknown>) =>
  http().post('/v1/pos/orders').set(headers).set('Idempotency-Key', `k-${++keys}-${Date.now()}`).send(body);

describe('subscription entitlements', () => {
  it('1. refuses a restaurant whose plan does not include the POS', async () => {
    const pos = await setUp();
    await http().put('/v1/admin/pos/settings').set(auth(pos.admin)).send({ enabled: true, plans: ['ADVANCED'] }).expect(200);
    await t.prisma.entitlement.updateMany({ where: { restaurantId: pos.id }, data: { planCode: 'ORDERS' } });
    const refused = await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'POS_UNAVAILABLE', details: { status: 'DISABLED' } });
  });

  it('2. refuses once the subscription has expired', async () => {
    const pos = await setUp();
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(201);
    await t.prisma.entitlement.updateMany({ where: { restaurantId: pos.id }, data: { startsAt: new Date(Date.now() - 40 * 86_400_000), endsAt: new Date(Date.now() - 86_400_000) } });
    expect((await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(409)).body.error.code).toBe('POS_UNAVAILABLE');
  });

  it('3. refuses when the administrator disables the POS for the restaurant', async () => {
    const pos = await setUp();
    await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.admin)).send({ access: 'DISABLED', reason: 'Unpaid', allowedModes: ['BILHANAH'] }).expect(200);
    expect((await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(409)).body.error).toMatchObject({ code: 'POS_UNAVAILABLE', details: { status: 'DISABLED' } });
  });
});

describe('restaurant and branch isolation', () => {
  it('4. keeps a cashier out of another restaurant, even with its device key', async () => {
    const a = await setUp();
    const b = await setUp('owner@b.test', 'bistro', a.admin);
    // B's cashier with A's device: refused, as if the device were unknown.
    expect((await place(on(b.cashier, a.device), { type: 'PICKUP', items: [b.line] }).expect(403)).body.error.code).toBe('POS_DEVICE_REVOKED');
    // A's order is invisible to B, on B's own device.
    const order = (await place(on(a.cashier, a.device), { type: 'PICKUP', items: [a.line] }).expect(201)).body;
    await http().get(`/v1/pos/orders/${order.id}/payments`).set(on(b.cashier, b.device)).expect(404);
    await http().get(`/v1/pos/orders/${order.id}/receipt`).set(on(b.cashier, b.device)).expect(404);
  });

  it('5. keeps a branch cashier off another branch’s device and orders', async () => {
    const pos = await setUp();
    const second = (await http().post('/v1/branches').set(auth(pos.token)).send({ name: 'Nasr City', slug: 'nasr', phone: '01012345678', city: 'Cairo', address: '1 Abbas St' }).expect(201)).body;
    const there = (await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Nasr counter', branchId: second.id }).expect(201)).body.deviceKey as string;
    await http().post('/v1/kitchen-accounts').set(auth(pos.token)).send({ fullName: 'Main Cashier', email: 'main@koshary.test', password: 'staff-password', role: 'CASHIER', branchId: pos.branchId }).expect(201);
    const mainCashier = await login('main@koshary.test');
    expect((await place(on(mainCashier, there), { type: 'PICKUP', items: [pos.line] }).expect(403)).body.error.code).toBe('POS_DEVICE_WRONG_BRANCH');
    // An order of the other branch cannot be paid on this branch's device.
    const nasrOrder = (await place(on(pos.token, there), { type: 'PICKUP', items: [pos.line] }).expect(201)).body;
    expect((await http().post(`/v1/pos/orders/${nasrOrder.id}/payments`).set(on(pos.token, pos.device)).set('Idempotency-Key', 'pay-branch-check-0001').send({ method: 'CARD', amountPiastres: 5000 }).expect(403)).body.error.code).toBe('POS_DEVICE_WRONG_BRANCH');
    // And a branch the device is not at is refused for takeaway too.
    expect((await place(on(pos.token, pos.device), { type: 'PICKUP', branchId: second.id, items: [pos.line] }).expect(403)).body.error.code).toBe('POS_DEVICE_WRONG_BRANCH');
  });
});

describe('devices', () => {
  it('6. needs a registered device; a paused or revoked one stops working at once', async () => {
    const pos = await setUp();
    expect((await place(auth(pos.cashier), { type: 'PICKUP', items: [pos.line] }).expect(403)).body.error.code).toBe('POS_DEVICE_REQUIRED');
    expect((await place(on(pos.cashier, 'posd_not-a-real-key'), { type: 'PICKUP', items: [pos.line] }).expect(403)).body.error.code).toBe('POS_DEVICE_REVOKED');
    await http().patch(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).send({ status: 'DISABLED' }).expect(200);
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(403);
    await http().patch(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).send({ status: 'ACTIVE' }).expect(200);
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(201);
    await http().delete(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).expect(200);
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(403);
    // Revoked is final.
    expect((await http().patch(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).send({ status: 'ACTIVE' }).expect(409)).body.error.code).toBe('POS_DEVICE_REVOKED');
  });

  it('7. enforces the device limit the administrator sets (revoked devices free a place)', async () => {
    const pos = await setUp();
    await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.admin)).send({ access: 'ENABLED', allowedModes: ['BILHANAH', 'EXTERNAL'], maxDevices: 2 }).expect(200);
    await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Second', branchId: pos.branchId }).expect(201);
    const over = await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Third', branchId: pos.branchId }).expect(409);
    expect(over.body.error).toMatchObject({ code: 'POS_DEVICE_LIMIT', details: { maxDevices: 2 } });
    expect((await http().get('/v1/pos').set(auth(pos.token)).expect(200)).body).toMatchObject({ maxDevices: 2, devicesInUse: 2 });
    await http().delete(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).expect(200);
    await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Third', branchId: pos.branchId }).expect(201);
  });

  it('pairs another device with a one-time code; the code works once', async () => {
    const pos = await setUp();
    const created = (await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Tablet', branchId: pos.branchId, onThisDevice: false }).expect(201)).body;
    expect(created.deviceKey).toBeNull();
    expect(created.pairing.code).toMatch(/^[A-Z0-9]{8}$/);
    const paired = (await http().post('/v1/pos/devices/pair').set(auth(pos.cashier)).send({ code: created.pairing.code.toLowerCase() }).expect(200)).body;
    await place(on(pos.cashier, paired.deviceKey), { type: 'PICKUP', items: [pos.line] }).expect(201);
    expect((await http().post('/v1/pos/devices/pair').set(auth(pos.cashier)).send({ code: created.pairing.code }).expect(400)).body.error.code).toBe('POS_PAIRING_INVALID');
  });
});

describe('permissions and roles', () => {
  it('8. refuses actions the account lacks the permission for', async () => {
    const pos = await setUp();
    await http().post('/v1/kitchen-accounts').set(auth(pos.token)).send({ fullName: 'Waiter', email: 'waiter@koshary.test', password: 'staff-password', role: 'WAITER' }).expect(201);
    const waiter = await login('waiter@koshary.test');
    await place(on(waiter, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(403);
    const order = (await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(201)).body;
    const paid = (await http().post(`/v1/pos/orders/${order.id}/payments`).set(on(pos.cashier, pos.device)).set('Idempotency-Key', 'pay-permission-0008').send({ method: 'CARD', amountPiastres: 5000 }).expect(201)).body;
    // Refunds and device management are not a cashier's by default.
    await http().post(`/v1/pos/payments/${paid.payments[0].id}/refunds`).set(on(pos.cashier, pos.device)).send({ amountPiastres: 1000, reason: 'Cold' }).expect(403);
    await http().post('/v1/pos/devices').set(auth(pos.cashier)).send({ name: 'Mine', branchId: pos.branchId }).expect(403);
  });

  it('9 and 10. only platform administrators change entitlements; they see and stop devices', async () => {
    const pos = await setUp();
    await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.token)).send({ access: 'ENABLED', allowedModes: ['BILHANAH'], maxDevices: 50 }).expect(403);
    await http().put('/v1/admin/pos/settings').set(auth(pos.token)).send({ enabled: true, plans: ['MENU', 'ORDERS', 'ADVANCED'] }).expect(403);
    const row = (await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.admin)).send({ access: 'ENABLED', allowedModes: ['BILHANAH'], maxDevices: 5 }).expect(200)).body;
    expect(row).toMatchObject({ maxDevices: 5, devicesInUse: 1 });
    const devices = (await http().get(`/v1/admin/pos/restaurants/${pos.id}/devices`).set(auth(pos.admin)).expect(200)).body;
    expect(devices).toEqual([expect.objectContaining({ id: pos.deviceId, status: 'ACTIVE' })]);
    await http().patch(`/v1/admin/pos/devices/${pos.deviceId}/status`).set(auth(pos.admin)).send({ status: 'DISABLED', reason: 'Lost tablet' }).expect(200);
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(403);
    const history = (await http().get('/v1/admin/pos/audit').set(auth(pos.admin)).expect(200)).body as { action: string }[];
    expect(history.map((entry) => entry.action)).toEqual(expect.arrayContaining(['pos.devices.limit_changed', 'pos.device.admin_disabled']));
  });

  it('11. a deactivated staff account loses the POS at once', async () => {
    const pos = await setUp();
    await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(201);
    await http().patch(`/v1/kitchen-accounts/${pos.cashierId}`).set(auth(pos.token)).send({ active: false }).expect(200);
    const refused = await place(on(pos.cashier, pos.device), { type: 'PICKUP', items: [pos.line] });
    expect([401, 403]).toContain(refused.status);
  });
});

describe('PIN sign-in', () => {
  it('12. signs in with a PIN on the device, and locks after repeated wrong PINs', async () => {
    const pos = await setUp();
    await http().put(`/v1/kitchen-accounts/${pos.cashierId}/pin`).set(auth(pos.token)).send({ pin: '4826' }).expect(200);
    const info = (await http().get('/v1/pos/device').set('X-Pos-Device', pos.device).expect(200)).body;
    expect(info.staff).toEqual([expect.objectContaining({ id: pos.cashierId, fullName: 'Cashier One', locked: false })]);
    await http().get('/v1/pos/device').expect(403);

    const pin = (value: string) => http().post('/v1/pos/device/pin').set('Origin', DASHBOARD_ORIGIN).set('X-Pos-Device', pos.device).send({ userId: pos.cashierId, pin: value });
    const signedIn = await pin('4826').expect(200);
    expect(signedIn.body.user).toMatchObject({ id: pos.cashierId, role: 'CASHIER' });
    await place(on(signedIn.body.accessToken, pos.device), { type: 'PICKUP', items: [pos.line] }).expect(201);

    for (let attempt = 1; attempt < 5; attempt += 1) expect((await pin('0000').expect(401)).body.error.code).toBe('POS_PIN_INVALID');
    expect((await pin('0000').expect(423)).body.error.code).toBe('POS_PIN_LOCKED');
    // Locked: even the right PIN waits.
    await pin('4826').expect(423);
    expect((await http().get('/v1/pos/device').set('X-Pos-Device', pos.device).expect(200)).body.staff[0].locked).toBe(true);
    // A new PIN from the owner lifts the lock.
    await http().put(`/v1/kitchen-accounts/${pos.cashierId}/pin`).set(auth(pos.token)).send({ pin: '7391' }).expect(200);
    await pin('7391').expect(200);

    // Revoked device: no PIN sign-in.
    await http().delete(`/v1/pos/devices/${pos.deviceId}`).set(auth(pos.token)).expect(200);
    await pin('7391').expect(403);
    const actions = (await t.prisma.auditLog.findMany({ where: { restaurantId: pos.id, action: { startsWith: 'pos.' } }, select: { action: true } })).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['pos.login', 'pos.pin.failed', 'pos.pin.locked', 'pos.order.created']));
    // The PIN itself is never logged.
    const logged = JSON.stringify(await t.prisma.auditLog.findMany({ where: { restaurantId: pos.id } }));
    expect(logged).not.toContain('4826');
    expect(logged).not.toContain('7391');
  });
});
