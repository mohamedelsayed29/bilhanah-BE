import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signInAdmin, signUpOwner, type TestApp } from './test-app.js';
import { type FakePaymob, paymobCallback, startFakePaymob } from './fake-paymob.js';

let t: TestApp;
let paymob: FakePaymob;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function owner(email = 'owner@koshary.test') {
  const token = await signUpOwner(t, email);
  const restaurant = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' })
    .expect(201);
  return { token, restaurantId: restaurant.body.id as string };
}

const startOnline = (token: string, body: object = { planCode: 'ORDERS', months: 3 }) => http().post('/v1/billing/online').set(auth(token)).send(body);
const callback = (body: object, hmac: string) => http().post(`/v1/webhooks/paymob?hmac=${hmac}`).send(body);
/** The reference the API sent Paymob for the latest checkout. */
const lastReference = () => paymob.intentions.at(-1)!.body.special_reference as string;

beforeAll(async () => {
  paymob = await startFakePaymob();
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
  await paymob.close();
});

beforeEach(async () => {
  await t.reset();
  paymob.intentions.length = 0;
  paymob.failing = false;
});

describe('paying for a plan online', () => {
  it('opens a Paymob checkout for the plan and waits for Paymob', async () => {
    const { token, restaurantId } = await owner();
    expect((await http().get('/v1/billing').set(auth(token)).expect(200)).body.onlinePayment).toBe(true);

    const started = await startOnline(token).expect(201);
    const { paymentId, checkoutUrl } = started.body as { paymentId: string; checkoutUrl: string };
    expect(checkoutUrl).toBe('https://checkout.paymob.test/?publicKey=egy_pk_test_e2e_public&clientSecret=egy_csk_test_1');

    const sent = paymob.intentions[0]!;
    expect(sent.authorization).toBe('Token egy_sk_test_e2e_secret');
    expect(sent.body).toMatchObject({
      amount: 3 * 35000,
      currency: 'EGP',
      payment_methods: [111, 222],
      items: [{ amount: 3 * 35000, quantity: 1 }],
      billing_data: { phone_number: '01012345678', email: 'owner@koshary.test', country: 'EG' },
      notification_url: 'https://api.bilhanah.test/v1/webhooks/paymob',
      redirection_url: `${DASHBOARD_ORIGIN}/subscription?payment=${paymentId}`,
    });
    expect(sent.body.special_reference).toMatch(new RegExp(`^sub-${paymentId}-[0-9a-f]{6}$`));

    const payment = await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment).toMatchObject({ restaurantId, method: 'PAYMOB', status: 'AWAITING_PAYMENT', amountPiastres: 105000, paymobOrderId: '900001' });
    // Not something an administrator reviews.
    const { token: admin } = await signInAdmin(t);
    expect((await http().get('/v1/admin/overview').set(auth(admin)).expect(200)).body.pendingPayments).toBe(0);
  });

  it('creates the paid period when Paymob confirms, once', async () => {
    const { token, restaurantId } = await owner();
    const { paymentId } = (await startOnline(token).expect(201)).body as { paymentId: string };
    const paid = paymobCallback(lastReference(), 105000);

    await callback(paid.body, paid.hmac).expect(200, { received: true });
    const payment = await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment).toMatchObject({ status: 'APPROVED', reviewedById: null, paymobTransactionId: String(paid.body.obj.id) });
    const periods = await t.prisma.entitlement.findMany({ where: { restaurantId, kind: 'PAID' } });
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ planCode: 'ORDERS', id: payment.entitlementId });
    expect(t.mailer.lastTo('owner@koshary.test')?.subject).toBe('وصلنا الدفع واشتراكك اتفعّل');

    // Paymob retries callbacks: nothing happens twice.
    await callback(paid.body, paid.hmac).expect(200);
    expect(await t.prisma.entitlement.count({ where: { restaurantId, kind: 'PAID' } })).toBe(1);

    const summary = (await http().get('/v1/billing').set(auth(token)).expect(200)).body;
    expect(summary.payments[0]).toMatchObject({ id: paymentId, method: 'PAYMOB', status: 'APPROVED', period: { endsAt: expect.any(String) } });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.paymob' } });
    expect(audit).toMatchObject({ actorId: null, targetId: paymentId });
  });

  it('trusts only callbacks signed with our HMAC secret, for the right amount', async () => {
    const { token, restaurantId } = await owner();
    const { paymentId } = (await startOnline(token).expect(201)).body as { paymentId: string };
    const paid = paymobCallback(lastReference(), 105000);

    await callback(paid.body, '0'.repeat(128)).expect(401);
    await http().post('/v1/webhooks/paymob').send(paid.body).expect(401);
    // Tampering with a signed field breaks the signature.
    await callback({ ...paid.body, obj: { ...paid.body.obj, amount_cents: 100 } }, paid.hmac).expect(401);
    expect(await t.prisma.entitlement.count({ where: { restaurantId, kind: 'PAID' } })).toBe(0);

    // Correctly signed, but for less than the plan costs: recorded, not credited.
    const short = paymobCallback(lastReference(), 100);
    await callback(short.body, short.hmac).expect(200);
    expect((await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('AWAITING_PAYMENT');
    expect(await t.prisma.auditLog.count({ where: { action: 'payment.paymob.mismatch', targetId: paymentId } })).toBe(1);

    // A transaction from another integration on the account is acknowledged and ignored.
    const foreign = paymobCallback('order-from-another-shop', 105000);
    await callback(foreign.body, foreign.hmac).expect(200);
  });

  it('marks declined payments, and counts a late payment for an abandoned checkout', async () => {
    const { token, restaurantId } = await owner();
    const first = (await startOnline(token).expect(201)).body as { paymentId: string };
    const firstReference = lastReference();
    const declined = paymobCallback(firstReference, 105000, { success: false });
    await callback(declined.body, declined.hmac).expect(200);
    expect(await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: first.paymentId } })).toMatchObject({ status: 'FAILED' });

    // A pending transaction changes nothing yet.
    const second = (await startOnline(token, { planCode: 'ADVANCED', months: 1 }).expect(201)).body as { paymentId: string };
    const secondReference = lastReference();
    const pending = paymobCallback(secondReference, 50000, { pending: true });
    await callback(pending.body, pending.hmac).expect(200);
    expect((await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: second.paymentId } })).status).toBe('AWAITING_PAYMENT');

    // Starting again abandons the unfinished checkout...
    await startOnline(token, { planCode: 'MENU', months: 1 }).expect(201);
    expect((await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: second.paymentId } })).status).toBe('CANCELLED');
    // ...but if the customer paid it after all, the money counts.
    const late = paymobCallback(secondReference, 50000);
    await callback(late.body, late.hmac).expect(200);
    expect((await t.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: second.paymentId } })).status).toBe('APPROVED');
    expect(await t.prisma.entitlement.count({ where: { restaurantId, kind: 'PAID', planCode: 'ADVANCED' } })).toBe(1);
  });

  it('explains when Paymob cannot open a checkout, and keeps transfers separate', async () => {
    const { token } = await owner();
    paymob.failing = true;
    const failed = await startOnline(token).expect(409);
    expect(failed.body.error).toMatchObject({ code: 'ONLINE_PAYMENT_UNAVAILABLE', details: { reason: 'PROVIDER_ERROR' } });
    expect(await t.prisma.subscriptionPayment.findFirstOrThrow()).toMatchObject({ status: 'FAILED', method: 'PAYMOB' });

    // PAYMOB is not a transfer method owners can claim to have used.
    await http().post('/v1/billing/payments').set(auth(token)).send({ planCode: 'MENU', months: 1, method: 'PAYMOB', reference: 'TX123456' }).expect(400);
    await startOnline(token, { planCode: 'GOLD', months: 1 }).expect(400);
    await startOnline(token, { planCode: 'MENU', months: 2 }).expect(400);
  });
});
