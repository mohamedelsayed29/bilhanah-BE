import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import request from 'supertest';
import type { MailerService } from '../src/infrastructure/email/mailer.service.js';
import { ExpiryRemindersService } from '../src/modules/billing/expiry-reminders.service.js';
import { createTestApp, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ownerWithRestaurant(email: string, subdomain: string) {
  const token = await signUpOwner(t, email);
  const response = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  return { token, id: response.body.id as string };
}

async function enableInstapay(adminToken: string) {
  await http().put('/v1/admin/settings/payment').set(auth(adminToken)).send({ instapayAddress: 'bilhanah@instapay' }).expect(200);
}

const receipt = () => sharp({ create: { width: 800, height: 1400, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();

function submit(token: string, body: Record<string, unknown> = {}) {
  return http()
    .post('/v1/billing/payments')
    .set(auth(token))
    .send({ planCode: 'MENU', months: 3, method: 'INSTAPAY', reference: 'IPN-778812', ...body });
}

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('owner billing', () => {
  it('offers only the payment methods an administrator has set up', async () => {
    const { token } = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    const before = await http().get('/v1/billing').set(auth(token)).expect(200);
    expect(before.body).toMatchObject({ availableMethods: [], months: [1, 3, 6, 12], pendingPayment: null, access: { status: 'TRIAL' } });
    expect(before.body.plans.map((plan: { code: string }) => plan.code)).toEqual(['MENU', 'ORDERS', 'ADVANCED']);
    const unavailable = await submit(token).expect(400);
    expect(unavailable.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');

    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const after = await http().get('/v1/billing').set(auth(token)).expect(200);
    expect(after.body).toMatchObject({ availableMethods: ['INSTAPAY'], instructions: { instapayAddress: 'bilhanah@instapay' } });
  });

  it('records a transfer with a private receipt and computes the amount itself', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token } = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    const proof = await http().post('/v1/media?kind=PAYMENT_PROOF').set(auth(token)).attach('file', await receipt(), 'receipt.jpg').expect(201);
    expect(proof.body).toMatchObject({ sources: [], url: '' });
    const stored = await t.prisma.media.findUniqueOrThrow({ where: { id: proof.body.id } });
    expect(stored.storageKey).toMatch(/^private\//);
    await http().get(`/media/${stored.storageKey}/${stored.variantWidths[0]}.webp`).expect(404);

    const created = await submit(token, { proofId: proof.body.id, payerName: 'Tarek Youssef', amountPiastres: 1 }).expect(400);
    expect(created.body.error.code).toBe('VALIDATION_FAILED'); // amounts are never accepted from clients

    const payment = await submit(token, { proofId: proof.body.id, payerName: 'Tarek Youssef' }).expect(201);
    expect(payment.body).toMatchObject({ planCode: 'MENU', months: 3, amountPiastres: 60000, status: 'PENDING', hasProof: true, period: null });

    expect(t.mailer.lastTo('owner@koshary.test')?.subject).toBe('وصلتنا بيانات الدفع');
    expect(t.mailer.lastTo('admin@bilhanah.test')?.subject).toBe('دفعة جديدة للمراجعة: Koshary Abou Tarek');

    const image = await http().get(`/v1/billing/payments/${payment.body.id}/proof`).set(auth(token)).expect(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['cache-control']).toBe('private, no-store');
    const adminImage = await http().get(`/v1/admin/payments/${payment.body.id}/proof`).set(auth(admin)).expect(200);
    expect(adminImage.body.length).toBeGreaterThan(0);

    const { token: other } = await ownerWithRestaurant('other@koshary.test', 'other');
    await http().get(`/v1/billing/payments/${payment.body.id}/proof`).set(auth(other)).expect(404);
    const foreignProof = await submit(other, { proofId: proof.body.id }).expect(404);
    expect(foreignProof.body.error.code).toBe('MEDIA_NOT_FOUND');
  });

  it('keeps one payment waiting for review at a time, which the owner can withdraw', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token } = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    const first = await submit(token).expect(201);
    const second = await submit(token, { months: 12 }).expect(409);
    expect(second.body.error.code).toBe('PAYMENT_ALREADY_PENDING');

    await http().delete(`/v1/billing/payments/${first.body.id}`).set(auth(token)).expect(204);
    const again = await http().delete(`/v1/billing/payments/${first.body.id}`).set(auth(token)).expect(409);
    expect(again.body.error.code).toBe('PAYMENT_NOT_PENDING');
    await submit(token, { months: 12 }).expect(201);

    const summary = await http().get('/v1/billing').set(auth(token)).expect(200);
    expect(summary.body.pendingPayment).toMatchObject({ months: 12, amountPiastres: 240000 });
    expect(summary.body.payments.map((p: { status: string }) => p.status)).toEqual(['PENDING', 'CANCELLED']);
  });
});

describe('payment review', () => {
  it('approves a transfer made during the trial, starting the paid period when the trial ends', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token, id } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const trial = await t.prisma.entitlement.findFirstOrThrow({ where: { restaurantId: id } });
    const payment = await submit(token, { planCode: 'ORDERS', months: 1 }).expect(201);

    const queue = await http().get('/v1/admin/payments?status=PENDING').set(auth(admin)).expect(200);
    expect(queue.body).toMatchObject({ total: 1, items: [{ id: payment.body.id, restaurant: { subdomain: 'koshary' } }] });

    const approved = await http().post(`/v1/admin/payments/${payment.body.id}/approve`).set(auth(admin)).expect(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.period.startsAt).toBe(trial.endsAt.toISOString());
    const expectedEnd = new Date(trial.endsAt);
    expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
    expect(approved.body.period.endsAt).toBe(expectedEnd.toISOString());
    expect(t.mailer.lastTo('owner@koshary.test')?.subject).toBe('اشتراكك اتفعّل');

    const twice = await http().post(`/v1/admin/payments/${payment.body.id}/approve`).set(auth(admin)).expect(409);
    expect(twice.body.error.code).toBe('PAYMENT_NOT_PENDING');
    // Still on the trial until it ends.
    expect((await http().get('/v1/billing').set(auth(token)).expect(200)).body.access.status).toBe('TRIAL');

    const audit = await http().get('/v1/admin/audit').set(auth(admin)).expect(200);
    expect(audit.body.items[0]).toMatchObject({ action: 'payment.approve', targetId: payment.body.id });
  });

  it('activates the plan immediately for a restaurant whose access has ended', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token, id } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await t.prisma.entitlement.updateMany({
      where: { restaurantId: id },
      data: { startsAt: new Date(Date.now() - 40 * DAY_MS), endsAt: new Date(Date.now() - 10 * DAY_MS) },
    });
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('TEMPORARILY_UNAVAILABLE');

    const payment = await submit(token, { planCode: 'MENU', months: 1 }).expect(201);
    await http().post(`/v1/admin/payments/${payment.body.id}/approve`).set(auth(admin)).expect(200);

    const access = (await http().get('/v1/billing').set(auth(token)).expect(200)).body.access;
    expect(access).toMatchObject({ status: 'PAID', planCode: 'MENU' });
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('AVAILABLE');
  });

  it('rejects a transfer with a reason the owner sees, and accepts a new one', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const payment = await submit(token).expect(201);

    await http().post(`/v1/admin/payments/${payment.body.id}/reject`).set(auth(admin)).send({ reason: '' }).expect(400);
    const rejected = await http()
      .post(`/v1/admin/payments/${payment.body.id}/reject`)
      .set(auth(admin))
      .send({ reason: 'No transfer with this reference arrived.' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'No transfer with this reference arrived.' });
    expect(t.mailer.lastTo('owner@koshary.test')?.text).toContain('No transfer with this reference arrived.');

    await submit(token, { reference: 'IPN-778813' }).expect(201);
  });

  it('keeps the price a payment was submitted at', async () => {
    const { token: admin } = await signInAdmin(t);
    await enableInstapay(admin);
    const { token } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const payment = await submit(token, { months: 1 }).expect(201);

    await http().put('/v1/admin/plans/MENU').set(auth(admin)).send({ priceMonthlyPiastres: 30000 }).expect(200);
    const approved = await http().post(`/v1/admin/payments/${payment.body.id}/approve`).set(auth(admin)).expect(200);
    expect(approved.body.amountPiastres).toBe(20000);
  });
});

describe('expiry reminders', () => {
  const reminders = () =>
    new ExpiryRemindersService(t.prisma, t.mailer as unknown as MailerService, t.app.get(ConfigService));

  it('sends each reminder once, and none after a renewal', async () => {
    const { id } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const trial = await t.prisma.entitlement.findFirstOrThrow({ where: { restaurantId: id } });
    await t.prisma.entitlement.update({ where: { id: trial.id }, data: { endsAt: new Date(Date.now() + 2.5 * DAY_MS) } });
    t.mailer.sent.length = 0;

    expect(await reminders().sendDue()).toBe(1);
    expect(t.mailer.lastTo('owner@koshary.test')?.subject).toBe('التجربة المجانية هيخلص خلال 3 أيام');
    expect(await reminders().sendDue()).toBe(0);

    // A day before the end: the 1-day reminder.
    expect(await reminders().sendDue(new Date(Date.now() + 2 * DAY_MS))).toBe(1);

    // Renewed: a paid period follows, so no "ended" email.
    await t.prisma.entitlement.create({
      data: { restaurantId: id, kind: 'PAID', planCode: 'MENU', startsAt: trial.endsAt, endsAt: new Date(Date.now() + 40 * DAY_MS) },
    });
    expect(await reminders().sendDue(new Date(Date.now() + 3 * DAY_MS))).toBe(0);
  });

  it('tells the owner when access has ended', async () => {
    const { id } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await t.prisma.entitlement.updateMany({
      where: { restaurantId: id },
      data: { startsAt: new Date(Date.now() - 30 * DAY_MS), endsAt: new Date(Date.now() - DAY_MS / 2) },
    });
    t.mailer.sent.length = 0;

    expect(await reminders().sendDue()).toBe(1);
    expect(t.mailer.lastTo('owner@koshary.test')?.subject).toBe('التجربة المجانية انتهى');
  });
});
