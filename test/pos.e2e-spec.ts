import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const SETTINGS = {
  taxRateBps: 1400, taxInclusive: false, serviceChargeBps: 1200, serviceChargeDineInOnly: true, paymentMethods: ['CASH', 'CARD'],
  cashierMaxDiscountPercent: 10, requireOpenShift: true, receiptHeader: 'Welcome', receiptFooter: 'Thank you', receiptShowLogo: true,
};

async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  const created = await http().post('/v1/restaurants').set(auth(token))
    .send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  return { token, id: created.body.id as string };
}

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('POS activation', () => {
  it('stays disabled until the platform offers it; then the owner activates, sets it up, and it is active', async () => {
    const { token } = await restaurant();
    expect((await http().get('/v1/pos').set(auth(token)).expect(200)).body).toMatchObject({ status: 'DISABLED', disabledReason: 'PLATFORM' });
    expect((await http().post('/v1/pos/activate').set(auth(token)).send({ mode: 'BILHANAH' }).expect(409)).body.error.code).toBe('POS_UNAVAILABLE');

    const admin = (await signInAdmin(t)).token;
    await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['ORDERS', 'ADVANCED'] }).expect(200);
    expect((await http().get('/v1/pos').set(auth(token)).expect(200)).body.status).toBe('NOT_ACTIVATED');
    // Settings come after choosing the mode.
    await http().put('/v1/pos/settings').set(auth(token)).send(SETTINGS).expect(409);
    expect((await http().post('/v1/pos/activate').set(auth(token)).send({ mode: 'BILHANAH' }).expect(201)).body).toMatchObject({ status: 'PENDING_SETUP', mode: 'BILHANAH' });
    const active = (await http().put('/v1/pos/settings').set(auth(token)).send(SETTINGS).expect(200)).body;
    expect(active).toMatchObject({ status: 'ACTIVE', settings: { taxRateBps: 1400, paymentMethods: ['CASH', 'CARD'] } });
    expect(active.setupCompletedAt).not.toBeNull();
    // Invalid settings are refused.
    await http().put('/v1/pos/settings').set(auth(token)).send({ ...SETTINGS, taxRateBps: 9000 }).expect(400);
    const actions = (await t.prisma.auditLog.findMany({ where: { action: { startsWith: 'pos.' } } })).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['pos.platform.updated', 'pos.activated', 'pos.settings.updated']));
  });

  it('follows the plans the platform offers it with, and the administrator per restaurant', async () => {
    const { token, id } = await restaurant();
    const admin = (await signInAdmin(t)).token;
    // The trial is on the ADVANCED plan; offering the POS on MENU only leaves it out.
    await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['MENU'] }).expect(200);
    expect((await http().get('/v1/pos').set(auth(token)).expect(200)).body).toMatchObject({ status: 'DISABLED', disabledReason: 'PLAN' });
    await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['ADVANCED'] }).expect(200);

    // External integration only: Bilhanah POS cannot be chosen.
    await http().patch(`/v1/admin/pos/restaurants/${id}`).set(auth(admin)).send({ access: 'ENABLED', allowedModes: ['EXTERNAL'] }).expect(200);
    expect((await http().post('/v1/pos/activate').set(auth(token)).send({ mode: 'BILHANAH' }).expect(409)).body.error.code).toBe('POS_MODE_NOT_ALLOWED');
    await http().post('/v1/pos/activate').set(auth(token)).send({ mode: 'EXTERNAL' }).expect(201);

    const suspended = (await http().patch(`/v1/admin/pos/restaurants/${id}`).set(auth(admin)).send({ access: 'SUSPENDED', reason: 'Unpaid invoice', allowedModes: ['EXTERNAL'] }).expect(200)).body;
    expect(suspended).toMatchObject({ status: 'SUSPENDED', accessReason: 'Unpaid invoice' });
    expect((await http().get('/v1/pos').set(auth(token)).expect(200)).body).toMatchObject({ status: 'SUSPENDED', accessReason: 'Unpaid invoice' });
    await http().put('/v1/pos/settings').set(auth(token)).send(SETTINGS).expect(409);

    const list = (await http().get('/v1/admin/pos/restaurants?status=SUSPENDED').set(auth(admin)).expect(200)).body;
    expect(list.items.map((row: { id: string }) => row.id)).toEqual([id]);
    // Only administrators reach the admin routes.
    await http().get('/v1/admin/pos/settings').set(auth(token)).expect(403);
  });

  it('lets only pos.settings set up the POS; a cashier sees its status', async () => {
    const { token } = await restaurant();
    const admin = (await signInAdmin(t)).token;
    await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['ORDERS', 'ADVANCED'] }).expect(200);
    await http().post('/v1/kitchen-accounts').set(auth(token)).send({ fullName: 'Cashier One', email: 'cashier@koshary.test', password: 'staff-password', role: 'CASHIER' }).expect(201);
    const cashier = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'cashier@koshary.test', password: 'staff-password' }).expect(200)).body.accessToken as string;
    expect((await http().get('/v1/pos').set(auth(cashier)).expect(200)).body.status).toBe('NOT_ACTIVATED');
    await http().post('/v1/pos/activate').set(auth(cashier)).send({ mode: 'BILHANAH' }).expect(403);
  });
});

async function activePos(settings: Partial<typeof SETTINGS> = {}) {
    const r = await restaurant();
    const admin = (await signInAdmin(t)).token;
    await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['ORDERS', 'ADVANCED'] }).expect(200);
    await http().post('/v1/pos/activate').set(auth(r.token)).send({ mode: 'BILHANAH' }).expect(201);
    await http().put('/v1/pos/settings').set(auth(r.token)).send({ ...SETTINGS, ...settings }).expect(200);
    const category = await http().post('/v1/menu/categories').set(auth(r.token)).send({ nameAr: 'رئيسي' }).expect(201);
    const koshary = (await http().post('/v1/menu/items').set(auth(r.token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 5000 }] }).expect(201)).body;
    const table = (await http().post('/v1/tables').set(auth(r.token)).send({ label: 'T1' }).expect(201)).body;
    await http().post('/v1/kitchen-accounts').set(auth(r.token)).send({ fullName: 'Cashier One', email: 'cashier@koshary.test', password: 'staff-password', role: 'CASHIER' }).expect(201);
    const cashier = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'cashier@koshary.test', password: 'staff-password' }).expect(200)).body.accessToken as string;
    return { ...r, admin, cashier, table, line: { menuItemId: koshary.id as string, variantId: koshary.variants[0].id as string, quantity: 2 } };
}
const order = (token: string, body: Record<string, unknown>, key = `pos-${Math.random().toString(36).slice(2, 12)}`) =>
  http().post('/v1/pos/orders').set(auth(token)).set('Idempotency-Key', key).send(body);
const pay = (token: string, orderId: string, body: Record<string, unknown>, key = `pay-${Math.random().toString(36).slice(2, 12)}`) =>
  http().post(`/v1/pos/orders/${orderId}/payments`).set(auth(token)).set('Idempotency-Key', key).send(body);

describe('POS orders', () => {
  it('takes a dine-in order on a table with the server’s bill, straight to the kitchen', async () => {
    const pos = await activePos();
    // 100.00 subtotal, 12 % service = 12.00, 14 % tax on 112.00 added = 15.68 → 127.68.
    const quote = (await http().post('/v1/pos/orders/quote').set(auth(pos.cashier)).send({ type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }).expect(200)).body;
    expect(quote).toEqual({ subtotalPiastres: 10000, discountPiastres: 0, serviceChargePiastres: 1200, taxPiastres: 1568, totalPiastres: 12768, taxInclusive: false });
    const key = 'pos-dine-in-0001';
    const placed = (await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }, key).expect(201)).body;
    expect(placed).toMatchObject({ status: 'ACCEPTED', channel: 'POS', createdByName: 'Cashier One', tableLabel: 'T1', totalPiastres: 12768, taxPiastres: 1568, serviceChargePiastres: 1200 });
    expect(placed.items[0]).toMatchObject({ prepStatus: 'ACCEPTED', unitPricePiastres: 5000 });
    // A retry returns the same order.
    expect((await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }, key).expect(201)).body.id).toBe(placed.id);
    expect(await t.prisma.order.count({ where: { restaurantId: pos.id } })).toBe(1);
    // The table is occupied, and its bill is the POS total.
    const floor = (await http().get('/v1/orders/floor').set(auth(pos.token)).expect(200)).body;
    expect(floor.find((row: { id: string }) => row.id === pos.table.id)).toMatchObject({ status: 'OCCUPIED', unpaidPiastres: 12768 });
  });

  it('takes takeaway orders, refuses client prices, and caps cashier discounts', async () => {
    const pos = await activePos();
    const takeaway = (await order(pos.cashier, { type: 'PICKUP', items: [pos.line], customerName: 'Mona' }).expect(201)).body;
    // Service charge is dine-in only; tax still applies.
    expect(takeaway).toMatchObject({ type: 'PICKUP', tableLabel: null, serviceChargePiastres: 0, taxPiastres: 1400, totalPiastres: 11400 });
    await order(pos.cashier, { type: 'PICKUP', items: [{ ...pos.line, unitPricePiastres: 1 }] }).expect(400);
    await order(pos.cashier, { type: 'DINE_IN', items: [pos.line] }).expect(400);
    // 10 % is the cashier limit; 20 % needs pos.discount (the owner has it).
    const small = (await order(pos.cashier, { type: 'PICKUP', items: [pos.line], discount: { kind: 'PERCENT', value: 10, reason: 'Regular' } }).expect(201)).body;
    expect(small).toMatchObject({ discountPiastres: 1000, discountReason: 'Regular', totalPiastres: 10260 });
    expect((await order(pos.cashier, { type: 'PICKUP', items: [pos.line], discount: { kind: 'PERCENT', value: 20, reason: 'Friend' } }).expect(403)).body.error.code).toBe('POS_DISCOUNT_NOT_ALLOWED');
    await order(pos.token, { type: 'PICKUP', items: [pos.line], discount: { kind: 'AMOUNT', value: 2000, reason: 'Complaint' } }).expect(201);
  });

  it('charges the POS total to the cash drawer, and refuses while the POS is not running Bilhanah POS', async () => {
    const pos = await activePos({ taxInclusive: true });
    await http().post('/v1/cash/shifts').set(auth(pos.cashier)).send({ openingPiastres: 0 }).expect(201);
    const placed = (await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }).expect(201)).body;
    // Tax included: shown, not added. 100.00 + 12.00 service.
    expect(placed).toMatchObject({ totalPiastres: 11200, taxPiastres: 1375 });
    await http().patch(`/v1/orders/${placed.id}/payment`).set(auth(pos.cashier)).send({ paid: true, method: 'CASH' }).expect(200);
    const drawer = (await http().get('/v1/cash/me').set(auth(pos.cashier)).expect(200)).body;
    expect(JSON.stringify(drawer)).toContain('11200');

    await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.admin)).send({ access: 'SUSPENDED', allowedModes: ['BILHANAH', 'EXTERNAL'] }).expect(200);
    expect((await order(pos.cashier, { type: 'PICKUP', items: [pos.line] }).expect(409)).body.error).toMatchObject({ code: 'POS_UNAVAILABLE', details: { status: 'SUSPENDED' } });
    // Another restaurant's table is not found.
    const other = await restaurant('owner@other.test', 'other');
    const foreign = (await http().post('/v1/tables').set(auth(other.token)).send({ label: 'X' }).expect(201)).body;
    await http().patch(`/v1/admin/pos/restaurants/${pos.id}`).set(auth(pos.admin)).send({ access: 'ENABLED', allowedModes: ['BILHANAH', 'EXTERNAL'] }).expect(200);
    await order(pos.cashier, { type: 'DINE_IN', tableId: foreign.id, items: [pos.line] }).expect(404);
  });
});

describe('POS payments, receipts and devices', () => {
  it('splits a bill across methods, gives change, settles once covered, and refuses overpaying', async () => {
    const pos = await activePos({ taxRateBps: 0, serviceChargeBps: 0 });
    await http().post('/v1/cash/shifts').set(auth(pos.cashier)).send({ openingPiastres: 0 }).expect(201);
    const placed = (await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }).expect(201)).body;
    // 100.00 due: 40 by card (declined first), 60 cash from a 100 note.
    const declined = (await pay(pos.cashier, placed.id, { method: 'CARD', amountPiastres: 4000, failed: true, failureReason: 'Declined' }).expect(201)).body;
    expect(declined).toMatchObject({ paidPiastres: 0, duePiastres: 10000, settled: false });
    const key = 'pay-card-00001';
    await pay(pos.cashier, placed.id, { method: 'CARD', amountPiastres: 4000, reference: 'AUTH123' }, key).expect(201);
    expect((await pay(pos.cashier, placed.id, { method: 'CARD', amountPiastres: 4000, reference: 'AUTH123' }, key).expect(201)).body.paidPiastres).toBe(4000);
    expect((await pay(pos.cashier, placed.id, { method: 'CASH', amountPiastres: 7000 }).expect(409)).body.error).toMatchObject({ code: 'POS_PAYMENT_INVALID', details: { duePiastres: 6000 } });
    await pay(pos.cashier, placed.id, { method: 'CARD', amountPiastres: 100, reference: '4111111111111111' }).expect(400);
    await pay(pos.cashier, placed.id, { method: 'WALLET', amountPiastres: 100 }).expect(409);
    const settled = (await pay(pos.cashier, placed.id, { method: 'CASH', amountPiastres: 6000, tenderedPiastres: 10000 }).expect(201)).body;
    expect(settled).toMatchObject({ paidPiastres: 10000, duePiastres: 0, settled: true });
    expect(settled.payments.at(-1)).toMatchObject({ method: 'CASH', changePiastres: 4000 });
    // The table is freed and the bill paid; only the cash part reached the drawer.
    expect((await http().get(`/v1/orders/${placed.id}`).set(auth(pos.token)).expect(200)).body).toMatchObject({ paymentMethod: 'CASH' });
    const shift = await t.prisma.cashShift.findFirstOrThrow({ where: { restaurantId: pos.id }, include: { transactions: true } });
    expect(shift.transactions.filter((row) => row.kind === 'SALE').map((row) => row.amountPiastres)).toEqual([6000]);

    // A cashier may not refund; the owner refunds part of the card payment with a reason.
    const card = settled.payments.find((row: { method: string; status: string }) => row.method === 'CARD' && row.status === 'SUCCEEDED');
    await http().post(`/v1/pos/payments/${card.id}/refunds`).set(auth(pos.cashier)).send({ amountPiastres: 1000, reason: 'Cold food' }).expect(403);
    const refunded = (await http().post(`/v1/pos/payments/${card.id}/refunds`).set(auth(pos.token)).send({ amountPiastres: 1000, reason: 'Cold food' }).expect(201)).body;
    expect(refunded).toMatchObject({ paidPiastres: 9000, duePiastres: 1000, settled: false });
    expect(refunded.payments.find((row: { id: string }) => row.id === card.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunds: [{ amountPiastres: 1000, reason: 'Cold food' }] });
    await http().post(`/v1/pos/payments/${card.id}/refunds`).set(auth(pos.token)).send({ amountPiastres: 5000, reason: 'Too much' }).expect(409);
    expect(await t.prisma.auditLog.count({ where: { action: 'pos.payment.refunded' } })).toBe(1);
  });

  it('needs an open shift for cash, and marking paid from the board records a payment too', async () => {
    const pos = await activePos({ taxRateBps: 0, serviceChargeBps: 0 });
    const placed = (await order(pos.cashier, { type: 'PICKUP', items: [pos.line] }).expect(201)).body;
    expect((await pay(pos.cashier, placed.id, { method: 'CASH', amountPiastres: 10000 }).expect(409)).body.error.code).toBe('CASH_SHIFT_REQUIRED');
    await http().patch(`/v1/orders/${placed.id}/payment`).set(auth(pos.cashier)).send({ paid: true, method: 'CARD' }).expect(200);
    const payments = (await http().get(`/v1/pos/orders/${placed.id}/payments`).set(auth(pos.cashier)).expect(200)).body;
    expect(payments).toMatchObject({ settled: true, paidPiastres: 10000, payments: [{ method: 'CARD', amountPiastres: 10000 }] });
    // Unpaid again refunds it.
    await http().patch(`/v1/orders/${placed.id}/payment`).set(auth(pos.token)).send({ paid: false }).expect(200);
    expect((await http().get(`/v1/pos/orders/${placed.id}/payments`).set(auth(pos.cashier)).expect(200)).body).toMatchObject({ settled: false, paidPiastres: 0, payments: [{ status: 'REFUNDED' }] });
  });

  it('prints receipts from the server, and registers, uses and revokes devices', async () => {
    const pos = await activePos();
    const branchId = (await t.prisma.branch.findFirstOrThrow({ where: { restaurantId: pos.id } })).id;
    await http().post('/v1/pos/devices').set(auth(pos.cashier)).send({ name: 'Front counter', branchId }).expect(403);
    const registered = (await http().post('/v1/pos/devices').set(auth(pos.token)).send({ name: 'Front counter', branchId }).expect(201)).body;
    expect(registered.deviceKey).toMatch(/^posd_/);
    expect(JSON.stringify(await t.prisma.posDevice.findFirstOrThrow())).not.toContain(registered.deviceKey);
    const placed = (await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }).set('X-Pos-Device', registered.deviceKey).expect(201)).body;
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).posDeviceId).toBe(registered.device.id);
    const devices = (await http().get('/v1/pos/devices').set(auth(pos.token)).expect(200)).body;
    expect(devices[0]).toMatchObject({ name: 'Front counter', status: 'ACTIVE', lastUserName: 'Cashier One' });

    const receipt = (await http().get(`/v1/pos/orders/${placed.id}/receipt`).set(auth(pos.cashier)).expect(200)).body;
    expect(receipt).toMatchObject({ header: 'Welcome', footer: 'Thank you', order: { number: placed.number, tableLabel: 'T1', cashierName: 'Cashier One', totalPiastres: 12768, taxPiastres: 1568 }, duePiastres: 12768 });

    await http().patch(`/v1/pos/devices/${registered.device.id}`).set(auth(pos.token)).send({ name: 'Bar' }).expect(200);
    expect((await http().delete(`/v1/pos/devices/${registered.device.id}`).set(auth(pos.token)).expect(200)).body.status).toBe('REVOKED');
    expect((await order(pos.cashier, { type: 'PICKUP', items: [pos.line] }).set('X-Pos-Device', registered.deviceKey).expect(403)).body.error.code).toBe('POS_DEVICE_REVOKED');
    // Another restaurant cannot see or revoke it.
    const other = await restaurant('owner@other.test', 'other');
    await http().delete(`/v1/pos/devices/${registered.device.id}`).set(auth(other.token)).expect(409);
  });
});

describe('POS reports and admin monitoring', () => {
  it('separates gross, net, tax, service, collected and outstanding, by channel, method and cashier', async () => {
    const pos = await activePos();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    // Dine-in 127.68 (12.00 service, 15.68 tax), paid 27.68 cash + 100 card.
    await http().post('/v1/cash/shifts').set(auth(pos.cashier)).send({ openingPiastres: 0 }).expect(201);
    const dineIn = (await order(pos.cashier, { type: 'DINE_IN', tableId: pos.table.id, items: [pos.line] }).expect(201)).body;
    await pay(pos.cashier, dineIn.id, { method: 'CARD', amountPiastres: 10000 }).expect(201);
    await pay(pos.cashier, dineIn.id, { method: 'CASH', amountPiastres: 2768 }).expect(201);
    // Takeaway 114.00 by the owner, unpaid.
    await order(pos.token, { type: 'PICKUP', items: [pos.line] }).expect(201);
    const report = (await http().get(`/v1/pos/reports?from=${day}&to=${day}`).set(auth(pos.token)).expect(200)).body;
    expect(report).toMatchObject({
      orders: 2, grossPiastres: 20000, discountPiastres: 0, netPiastres: 20000, serviceChargePiastres: 1200, taxPiastres: 1568 + 1400,
      billedPiastres: 12768 + 11400, collectedPiastres: 12768, outstandingPiastres: 11400, averageOrderPiastres: 10000,
      byChannel: [{ channel: 'POS', orders: 2, netPiastres: 20000 }],
    });
    expect(report.byMethod).toEqual(expect.arrayContaining([{ method: 'CARD', payments: 1, collectedPiastres: 10000 }, { method: 'CASH', payments: 1, collectedPiastres: 2768 }]));
    expect(report.byCashier.map((row: { name: string; orders: number }) => [row.name, row.orders])).toEqual(expect.arrayContaining([['Cashier One', 1], ['Test Owner', 1]]));
    expect(report.shifts[0]).toMatchObject({ cashierName: 'Cashier One', status: 'OPEN' });
    // A cashier without analytics or settings cannot read it.
    await http().get(`/v1/pos/reports?from=${day}&to=${day}`).set(auth(pos.cashier)).expect(403);

    const health = (await http().get('/v1/admin/pos/health').set(auth(pos.admin)).expect(200)).body;
    expect(health.restaurants.ACTIVE).toBe(1);
    const audit = (await http().get('/v1/admin/pos/audit').set(auth(pos.admin)).expect(200)).body;
    expect(audit.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(['pos.activated', 'pos.settings.updated', 'pos.platform.updated']));
    await http().get('/v1/admin/pos/health').set(auth(pos.token)).expect(403);
  });
});
