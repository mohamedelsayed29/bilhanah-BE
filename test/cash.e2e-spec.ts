import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

async function staff(by: string, role: string, email: string, extra: Record<string, unknown> = {}) {
  const created = await http().post('/v1/kitchen-accounts').set(auth(by)).send({ fullName: `${role} ${email}`, email, password: 'staff-password', role, ...extra }).expect(201);
  const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200);
  return { id: created.body.id as string, token: login.body.accessToken as string };
}

/** A 35 EGP order (3500 piastres), accepted so it can be paid. */
async function order(r: Awaited<ReturnType<typeof restaurant>>, quantity = 1): Promise<string> {
  const placed = await http()
    .post(`/v1/public/restaurants/${r.subdomain}/orders`)
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: r.item.id, variantId: r.item.variant, quantity }] })
    .expect(201);
  const { id } = (await http().get('/v1/orders?view=active').set(auth(r.token)).expect(200)).body.items.find((row: { number: number }) => row.number === placed.body.order.number);
  await http().patch(`/v1/orders/${id}/status`).set(auth(r.token)).send({ status: 'ACCEPTED' }).expect(200);
  return id;
}

const pay = (token: string, id: string, method = 'CASH', paid = true) => http().patch(`/v1/orders/${id}/payment`).set(auth(token)).send({ paid, method });
const drawer = async (token: string) => (await http().get('/v1/cash/me').set(auth(token)).expect(200)).body;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('cashier shifts', () => {
  it('reconciles a shift: cash only, refunds and cash out reduce, cash in adds, closing records the discrepancy', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test', { permissions: ['payments.refund'] });

    const opened = await http().post('/v1/cash/shifts').set(auth(cashier.token)).send({ openingPiastres: 50_000 }).expect(201);
    expect(opened.body).toMatchObject({ status: 'OPEN', currency: 'EGP', openingPiastres: 50_000, cashier: { id: cashier.id } });
    // One active shift per cashier.
    expect((await http().post('/v1/cash/shifts').set(auth(cashier.token)).send({ openingPiastres: 0 }).expect(409)).body.error.code).toBe('CASH_SHIFT_ALREADY_OPEN');

    const cash1 = await order(r);
    const cash2 = await order(r, 2);
    const card = await order(r);
    await pay(cashier.token, cash1).expect(200);
    await pay(cashier.token, cash2).expect(200);
    const paidByCard = await pay(cashier.token, card, 'CARD').expect(200);
    expect(paidByCard.body.paymentMethod).toBe('CARD');
    // Reversing a cash bill takes the cash out of the drawer.
    await pay(cashier.token, cash1, 'CASH', false).expect(200);

    const shiftId = opened.body.id as string;
    await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(cashier.token)).send({ kind: 'CASH_IN', amountPiastres: 10_000, reason: 'Change float' }).expect(201);
    await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(cashier.token)).send({ kind: 'CASH_OUT', amountPiastres: 2_000, reason: 'Paid the bread supplier' }).expect(201);
    // Adjustments need cash.adjust.
    await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(cashier.token)).send({ kind: 'ADJUSTMENT', amountPiastres: 100, reason: 'Found coins' }).expect(403);

    const { shift } = await drawer(cashier.token);
    expect(shift.summary).toMatchObject({
      openingPiastres: 50_000, cashSalesPiastres: 3_500 + 7_000, cashSalesCount: 2, cashRefundsPiastres: 3_500,
      cashInPiastres: 10_000, cashOutPiastres: 2_000, expectedPiastres: 50_000 + 10_500 - 3_500 + 10_000 - 2_000,
    });

    // A short count needs a note (default rule) and then waits for a manager.
    await http().post(`/v1/cash/shifts/${shiftId}/closing`).set(auth(cashier.token)).expect(200);
    await pay(cashier.token, await order(r)).expect(200); // not in the drawer while counting
    expect((await http().post(`/v1/cash/shifts/${shiftId}/close`).set(auth(cashier.token)).send({ countedPiastres: 64_500 }).expect(400)).body.error.code).toBe('CASH_NOTE_REQUIRED');
    const closed = await http().post(`/v1/cash/shifts/${shiftId}/close`).set(auth(cashier.token)).send({ countedPiastres: 64_500, note: 'Short 5 EGP' }).expect(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', expectedPiastres: 65_000, countedPiastres: 64_500, discrepancyPiastres: -500, reviewStatus: 'PENDING' });

    // Closed: no more movements, and the cashier cannot review their own.
    expect((await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(cashier.token)).send({ kind: 'CASH_IN', amountPiastres: 500, reason: 'Late' }).expect(409)).body.error.code).toBe('CASH_SHIFT_CLOSED');
    expect((await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(r.token)).send({ kind: 'CASH_IN', amountPiastres: 500, reason: 'Late' }).expect(409)).body.error.code).toBe('CASH_SHIFT_CLOSED');
    await http().post(`/v1/cash/shifts/${shiftId}/review`).set(auth(cashier.token)).send({ approve: true }).expect(403);

    const reviewed = await http().post(`/v1/cash/shifts/${shiftId}/review`).set(auth(r.token)).send({ approve: true, note: 'OK' }).expect(200);
    expect(reviewed.body.reviewStatus).toBe('APPROVED');
    await http().post(`/v1/cash/shifts/${shiftId}/review`).set(auth(r.token)).send({ approve: true }).expect(409);

    // The authorized correction: a missed cash out recorded after closing.
    const corrected = await http().post(`/v1/cash/shifts/${shiftId}/corrections`).set(auth(r.token)).send({ reason: 'Missed the ice delivery receipt', adjustmentPiastres: -500 }).expect(201);
    expect(corrected.body).toMatchObject({ expectedPiastres: 64_500, discrepancyPiastres: 0, reviewStatus: 'NOT_REQUIRED' });
    expect(corrected.body.history.map((event: { action: string }) => event.action)).toEqual([
      'cash.shift_opened', 'cash.movement', 'cash.movement', 'cash.closing_started', 'cash.shift_closed', 'cash.shift_reviewed', 'cash.correction',
    ]);

    // The cashier sees their own history; the report counts the shift.
    const mine = await http().get('/v1/cash/shifts').set(auth(cashier.token)).expect(200);
    expect(mine.body.total).toBe(1);
    // The restaurant's day (Africa/Cairo), not UTC's: they differ for two hours after midnight.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const report = await http().get(`/v1/cash/report?from=${today}&to=${today}`).set(auth(r.token)).expect(200);
    expect(report.body.totals).toMatchObject({ shifts: 1, closedShifts: 1, discrepancyShifts: 0, completionRate: 1 });
    expect(report.body.byCashier[0]).toMatchObject({ id: cashier.id, cashSalesPiastres: 10_500 });
  });

  it('counts a cash payment once, however many times it is sent at once', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await http().post('/v1/cash/shifts').set(auth(cashier.token)).send({ openingPiastres: 0 }).expect(201);
    const id = await order(r);
    const responses = await Promise.all(Array.from({ length: 6 }, () => pay(cashier.token, id)));
    for (const response of responses) expect(response.status).toBe(200);
    const { shift } = await drawer(cashier.token);
    expect(shift.summary).toMatchObject({ cashSalesCount: 1, cashSalesPiastres: 3_500, expectedPiastres: 3_500 });
  });

  it('holds adjustments for approval, blocks closing until reviewed, and needs someone else to approve', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test', { permissions: ['cash.adjust'] });
    const shiftId = (await http().post('/v1/cash/shifts').set(auth(cashier.token)).send({ openingPiastres: 10_000 }).expect(201)).body.id;
    const detail = await http().post(`/v1/cash/shifts/${shiftId}/transactions`).set(auth(cashier.token)).send({ kind: 'ADJUSTMENT', amountPiastres: -300, reason: 'Torn note' }).expect(201);
    expect(detail.body.summary).toMatchObject({ expectedPiastres: 10_000, pendingAdjustmentsCount: 1 });
    expect((await http().post(`/v1/cash/shifts/${shiftId}/close`).set(auth(cashier.token)).send({ countedPiastres: 9_700 }).expect(409)).body.error.code).toBe('CASH_ADJUSTMENTS_PENDING');

    const pending = await http().get('/v1/cash/adjustments/pending').set(auth(r.token)).expect(200);
    expect(pending.body).toHaveLength(1);
    const approved = await http().post(`/v1/cash/adjustments/${pending.body[0].id}/review`).set(auth(r.token)).send({ approve: true }).expect(200);
    expect(approved.body.summary.expectedPiastres).toBe(9_700);
    const closed = await http().post(`/v1/cash/shifts/${shiftId}/close`).set(auth(cashier.token)).send({ countedPiastres: 9_700 }).expect(200);
    expect(closed.body).toMatchObject({ discrepancyPiastres: 0, reviewStatus: 'NOT_REQUIRED' });
  });

  it('keeps one shift per register unless shared registers are allowed, and requires a register when the branch has them', async () => {
    const r = await restaurant();
    const a = await staff(r.token, 'CASHIER', 'a@koshary.test');
    const b = await staff(r.token, 'CASHIER', 'b@koshary.test');
    const branchId = (await http().get('/v1/branches').set(auth(r.token)).expect(200)).body.branches[0].id;
    const register = (await http().post('/v1/cash/registers').set(auth(r.token)).send({ branchId, name: 'Front desk' }).expect(201)).body;
    await http().post('/v1/cash/registers').set(auth(a.token)).send({ branchId, name: 'Other' }).expect(403);

    expect((await http().post('/v1/cash/shifts').set(auth(a.token)).send({ openingPiastres: 0 }).expect(400)).body.error.code).toBe('CASH_REGISTER_REQUIRED');
    await http().post('/v1/cash/shifts').set(auth(a.token)).send({ openingPiastres: 0, registerId: register.id }).expect(201);
    expect((await http().post('/v1/cash/shifts').set(auth(b.token)).send({ openingPiastres: 0, registerId: register.id }).expect(409)).body.error.code).toBe('CASH_REGISTER_BUSY');

    await http().put('/v1/cash/settings').set(auth(r.token))
      .send({ allowSharedRegister: true, requireShiftForCash: true, adjustmentsNeedApproval: true, discrepancyTolerancePiastres: 0, closingNote: 'ALWAYS' }).expect(200);
    await http().post('/v1/cash/shifts').set(auth(b.token)).send({ openingPiastres: 0, registerId: register.id }).expect(201);

    // With two open shifts, the owner (no shift) cannot take cash when a shift is required.
    const id = await order(r);
    expect((await pay(r.token, id).expect(409)).body.error.code).toBe('CASH_SHIFT_REQUIRED');
    await pay(r.token, id, 'CARD').expect(200);
  });

  it('isolates shifts by restaurant and by branch', async () => {
    const r = await restaurant();
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    const shiftId = (await http().post('/v1/cash/shifts').set(auth(cashier.token)).send({ openingPiastres: 100 }).expect(201)).body.id;
    const other = await restaurant('owner@felfela.test', 'felfela');
    await http().get(`/v1/cash/shifts/${shiftId}`).set(auth(other.token)).expect(404);
    await http().post(`/v1/cash/shifts/${shiftId}/close`).set(auth(other.token)).send({ countedPiastres: 100 }).expect(404);
    expect((await http().get('/v1/cash/shifts').set(auth(other.token)).expect(200)).body.total).toBe(0);
    // Another cashier of the same restaurant does not see it either.
    const second = await staff(r.token, 'CASHIER', 'second@koshary.test');
    await http().get(`/v1/cash/shifts/${shiftId}`).set(auth(second.token)).expect(404);
    // Waiters have no cash access.
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await http().get('/v1/cash/shifts').set(auth(waiter.token)).expect(403);
  });
});
