import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { StorageService } from '../src/infrastructure/storage/storage.service.js';
import { ShopMaintenanceService } from '../src/worker/shop-maintenance.service.js';
import { createTestApp, signInAdmin, signUpOwner, type TestApp } from './test-app.js';
import { type FakePaymob, paymobCallback, startFakePaymob } from './fake-paymob.js';

const HOUR_MS = 60 * 60 * 1000;

let t: TestApp;
let paymob: FakePaymob;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const line = (overrides: Record<string, unknown> = {}) => ({
  shape: 'arch',
  nfc: false,
  design: 'forest',
  customColors: null,
  purpose: 'menu',
  brand: 'Koshary Abou Tarek',
  caption: 'المنيو في إيدك',
  url: 'https://koshary.bilhanah.com/?src=qr',
  logoId: null,
  numbered: true,
  startNumber: 1,
  quantity: 4,
  notes: '',
  ...overrides,
});

const customer = { name: 'Mona Adel', phone: '010 9876 5432', email: 'mona@cafe.test', city: 'Alexandria', address: '12 Fouad St, Raml Station', notes: 'Call after 5pm' };

function order(body: Record<string, unknown>, key: string = randomUUID()) {
  return http()
    .post('/v1/public/shop/orders')
    .set('Idempotency-Key', key)
    .send({ lines: [line()], customer, paymentMethod: 'CASH_ON_DELIVERY', expectedTotalPiastres: 4 * 35000, language: 'ar', ...body });
}

const logoPng = () => sharp({ create: { width: 400, height: 200, channels: 4, background: '#075e54' } }).png().toBuffer();
const setShop = (admin: string, settings: object) => http().put('/v1/admin/settings/shop').set(auth(admin)).send(settings);

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

describe('the shop checkout', () => {
  it('offers cash, and online payment once a delivery fee is set', async () => {
    expect((await http().get('/v1/public/shop').expect(200)).body).toEqual({
      prices: { unitPiastres: 35000, nfcPiastres: 10000 },
      stickerPrices: { unitPiastres: 15000, nfcPiastres: 10000 },
      deliveryFeePiastres: null,
      paymentMethods: ['CASH_ON_DELIVERY'],
    });
    const { token: admin } = await signInAdmin(t);
    expect((await setShop(admin, { deliveryFeePiastres: 7500, cashOnDelivery: true, onlinePayment: true }).expect(200)).body).toEqual({
      deliveryFeePiastres: 7500,
      cashOnDelivery: true,
      onlinePayment: true,
    });
    expect((await http().get('/v1/public/shop').expect(200)).body).toMatchObject({ deliveryFeePiastres: 7500, paymentMethods: ['CASH_ON_DELIVERY', 'PAYMOB'] });
    await setShop(admin, { deliveryFeePiastres: 7500, cashOnDelivery: false, onlinePayment: false }).expect(400);
    // Online only needs a fixed fee, or nobody could pay.
    await setShop(admin, { deliveryFeePiastres: null, cashOnDelivery: false, onlinePayment: true }).expect(400);
    await setShop(admin, { deliveryFeePiastres: 7500, cashOnDelivery: false, onlinePayment: true }).expect(200);
    expect((await http().get('/v1/public/shop').expect(200)).body.paymentMethods).toEqual(['PAYMOB']);
    expect(await t.prisma.auditLog.count({ where: { action: 'settings.shop' } })).toBe(2);
  });

  it('takes logos as images only', async () => {
    const uploaded = await http().post('/v1/public/shop/logos').attach('file', await logoPng(), 'logo.png').expect(201);
    expect(uploaded.body.logoId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await t.prisma.standLogo.findUniqueOrThrow({ where: { id: uploaded.body.logoId } });
    const png = await t.app.get(StorageService).get(`${stored.storageKey}/logo.png`);
    expect((await sharp(png!).metadata()).format).toBe('png');

    const notImage = await http().post('/v1/public/shop/logos').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg').expect(400);
    expect(notImage.body.error.code).toBe('LOGO_INVALID');
    await http().post('/v1/public/shop/logos').expect(400);
    await http().post('/v1/public/shop/logos').attach('file', Buffer.alloc(3 * 1024 * 1024 + 1, 1), 'big.png').expect(413);
  });

  it('places a cash order priced by the server, once per checkout', async () => {
    const { token: admin } = await signInAdmin(t);
    const logo = (await http().post('/v1/public/shop/logos').attach('file', await logoPng(), 'logo.png').expect(201)).body.logoId as string;
    const lines = [line({ logoId: logo }), line({ shape: 'tilt', nfc: true, design: 'mono', customColors: { background: '#fff', ink: '#172b25' }, quantity: 2, numbered: false })];
    const key = randomUUID();

    // The customer saw an old total: told the new one, nothing saved.
    const stale = await order({ lines, expectedTotalPiastres: 5 }, key).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { totalPiastres: 4 * 35000 + 2 * 45000, deliveryFeePiastres: null } });

    const placed = await order({ lines, expectedTotalPiastres: 230000 }, key).expect(201);
    expect(placed.body.checkoutUrl).toBeNull();
    expect(placed.body.order).toMatchObject({
      reference: expect.stringMatching(/^S-\d{4,}$/),
      status: 'NEW',
      paymentMethod: 'CASH_ON_DELIVERY',
      paymentStatus: 'UNPAID',
      subtotalPiastres: 230000,
      deliveryFeePiastres: null,
      totalPiastres: 230000,
      customerName: 'Mona Adel',
      city: 'Alexandria',
    });
    expect(placed.body.order.lines).toMatchObject([
      { shape: 'arch', hasLogo: true, quantity: 4, unitPricePiastres: 35000, lineTotalPiastres: 140000 },
      { shape: 'tilt', nfc: true, customColors: { background: '#FFFFFF', ink: '#172B25' }, quantity: 2, unitPricePiastres: 45000, lineTotalPiastres: 90000 },
    ]);
    // The customer's phone and address are not on the public order.
    expect(placed.body.order).not.toHaveProperty('phone');
    expect(placed.body.order).not.toHaveProperty('address');

    expect(t.mailer.lastTo('mona@cafe.test')?.subject).toBe(`طلبك ${placed.body.order.reference} وصلنا`);
    expect(t.mailer.lastTo('mona@cafe.test')?.text).toContain(`https://bilhanah.test/shop/orders/${placed.body.trackingToken}`);
    expect(t.mailer.lastTo('admin@bilhanah.test')?.subject).toBe(`طلب حوامل جديد ${placed.body.order.reference}`);

    // A retried submission returns the same order without new emails.
    const sentBefore = t.mailer.sent.length;
    const again = await order({ lines, expectedTotalPiastres: 230000 }, key).expect(201);
    expect(again.body.order.reference).toBe(placed.body.order.reference);
    expect(t.mailer.sent.length).toBe(sentBefore);
    expect(await t.prisma.standOrder.count()).toBe(1);

    const tracked = await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200);
    expect(tracked.body).toEqual(placed.body.order);
    await http().get('/v1/public/shop/orders/not-a-token').expect(404);
    expect((await http().get('/v1/admin/overview').set(auth(admin)).expect(200)).body.newStandOrders).toBe(1);
  });

  it('sells stickers at their own price, only in sticker shapes', async () => {
    const sticker = line({ product: 'sticker', shape: 'circle', nfc: true, quantity: 10 });
    const placed = await order({ lines: [line(), sticker], expectedTotalPiastres: 4 * 35000 + 10 * 25000 }).expect(201);
    expect(placed.body.order.lines).toMatchObject([
      { product: 'stand', shape: 'arch', unitPricePiastres: 35000 },
      { product: 'sticker', shape: 'circle', nfc: true, quantity: 10, unitPricePiastres: 25000, lineTotalPiastres: 250000 },
    ]);
    await order({ lines: [line({ product: 'sticker', shape: 'arch' })], expectedTotalPiastres: 4 * 15000 }).expect(400);
    await order({ lines: [line({ shape: 'square' })] }).expect(400);
  });

  it('refuses what it cannot make or deliver', async () => {
    const unknownLogo = await order({ lines: [line(), line({ logoId: randomUUID() })], expectedTotalPiastres: 280000 }).expect(404);
    expect(unknownLogo.body.error).toMatchObject({ code: 'LOGO_NOT_FOUND', details: { line: 1 } });
    await order({ lines: [line({ logoId: 'not-a-uuid' })] }).expect(404);

    const reviews = await order({ lines: [line({ purpose: 'reviews', url: 'https://example.com/review' })] }).expect(400);
    expect(reviews.body.error.code).toBe('VALIDATION_FAILED');
    await order({ lines: [line({ purpose: 'reviews', url: 'https://g.page/r/abc123/review' })] }).expect(201);
    await order({ lines: [line({ url: 'javascript:alert(1)' })] }).expect(400);
    await order({ lines: [line({ quantity: 501 })] }).expect(400);
    await order({ lines: [] }).expect(400);
    await order({ customer: { ...customer, phone: 'call me' } }).expect(400);
    await http().post('/v1/public/shop/orders').send({ lines: [line()], customer, paymentMethod: 'CASH_ON_DELIVERY', expectedTotalPiastres: 140000 }).expect(400);

    // Online payment is not offered while the delivery fee is confirmed by phone.
    const online = await order({ paymentMethod: 'PAYMOB' }).expect(400);
    expect(online.body.error).toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE', details: { methods: ['CASH_ON_DELIVERY'] } });
  });
});

describe('online stand orders', () => {
  async function onlineShop() {
    const { token: admin } = await signInAdmin(t);
    await setShop(admin, { deliveryFeePiastres: 7500, cashOnDelivery: true, onlinePayment: true }).expect(200);
    return admin;
  }

  it('sends the customer to Paymob and starts the order when Paymob confirms', async () => {
    await onlineShop();
    const placed = await order({ paymentMethod: 'PAYMOB', expectedTotalPiastres: 140000 + 7500 }).expect(201);
    expect(placed.body.order).toMatchObject({ status: 'AWAITING_PAYMENT', deliveryFeePiastres: 7500, totalPiastres: 147500 });
    expect(placed.body.checkoutUrl).toBe('https://checkout.paymob.test/?publicKey=egy_pk_test_e2e_public&clientSecret=egy_csk_test_1');
    expect(paymob.intentions[0]!.body).toMatchObject({
      amount: 147500,
      billing_data: { first_name: 'Mona', last_name: 'Adel', phone_number: '01098765432', city: 'Alexandria' },
      redirection_url: `https://bilhanah.test/shop/orders/${placed.body.trackingToken}`,
    });
    // Nobody is told about an unpaid order.
    expect(t.mailer.sent).toHaveLength(0);

    const paid = paymobCallback(paymob.intentions[0]!.body.special_reference, 147500);
    await http().post(`/v1/webhooks/paymob?hmac=${paid.hmac}`).send(paid.body).expect(200);
    const tracked = await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200);
    expect(tracked.body).toMatchObject({ status: 'NEW', paymentStatus: 'PAID' });
    expect(t.mailer.lastTo('mona@cafe.test')?.text).toContain('وصلنا الدفع أونلاين.');
    expect(t.mailer.lastTo('admin@bilhanah.test')?.text).toContain('مدفوع أونلاين.');

    const again = await http().post(`/v1/public/shop/orders/${placed.body.trackingToken}/pay`).expect(409);
    expect(again.body.error.code).toBe('NOT_AWAITING_PAYMENT');
  });

  it('opens a new checkout for an unpaid order, and saves nothing when Paymob is down', async () => {
    await onlineShop();
    const placed = await order({ paymentMethod: 'PAYMOB', expectedTotalPiastres: 147500 }).expect(201);
    const retry = await http().post(`/v1/public/shop/orders/${placed.body.trackingToken}/pay`).expect(200);
    expect(retry.body.checkoutUrl).toContain('clientSecret=egy_csk_test_2');
    expect(paymob.intentions[1]!.body.special_reference).not.toBe(paymob.intentions[0]!.body.special_reference);

    paymob.failing = true;
    const down = await order({ paymentMethod: 'PAYMOB', expectedTotalPiastres: 147500 }).expect(409);
    expect(down.body.error).toMatchObject({ code: 'ONLINE_PAYMENT_UNAVAILABLE', details: { reason: 'PROVIDER_ERROR' } });
    expect(await t.prisma.standOrder.count()).toBe(1);
  });

  it('cancels orders unpaid for two days, and revives one paid late', async () => {
    await onlineShop();
    const placed = await order({ paymentMethod: 'PAYMOB', expectedTotalPiastres: 147500 }).expect(201);
    const reference = paymob.intentions[0]!.body.special_reference as string;
    const logo = (await http().post('/v1/public/shop/logos').attach('file', await logoPng(), 'logo.png').expect(201)).body.logoId as string;
    await t.prisma.standLogo.update({ where: { id: logo }, data: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } });
    await t.prisma.standOrder.updateMany({ data: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } });

    const result = await new ShopMaintenanceService(t.prisma, t.app.get(StorageService)).run();
    expect(result).toEqual({ abandonedCheckouts: 0, unpaidStandOrders: 1, unusedLogos: 1 });
    expect((await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200)).body.status).toBe('CANCELLED');
    expect(await t.prisma.standLogo.count()).toBe(0);

    const late = paymobCallback(reference, 147500);
    await http().post(`/v1/webhooks/paymob?hmac=${late.hmac}`).send(late.body).expect(200);
    expect((await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200)).body).toMatchObject({ status: 'NEW', paymentStatus: 'PAID' });
    const events = await t.prisma.standOrderEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => event.status)).toEqual(['AWAITING_PAYMENT', 'CANCELLED', 'NEW']);
  });
});

describe('the fulfilment queue', () => {
  it('moves orders along, tells the customer, and keeps the history', async () => {
    const { token: admin } = await signInAdmin(t);
    const logo = (await http().post('/v1/public/shop/logos').attach('file', await logoPng(), 'logo.png').expect(201)).body.logoId as string;
    const placed = await order({ lines: [line({ logoId: logo })] }).expect(201);
    await order({ customer: { ...customer, name: 'Hany', phone: '01111111111', email: '' } }).expect(201);

    const open = await http().get('/v1/admin/stand-orders?status=open').set(auth(admin)).expect(200);
    expect(open.body.total).toBe(2);
    const byReference = await http().get(`/v1/admin/stand-orders?query=${placed.body.order.reference}`).set(auth(admin)).expect(200);
    expect(byReference.body.items.map((item: { customerName: string }) => item.customerName)).toEqual(['Mona Adel']);
    expect((await http().get('/v1/admin/stand-orders?query=0111 111').set(auth(admin)).expect(200)).body.items[0].customerName).toBe('Hany');
    const detail = byReference.body.items[0] as { id: string; lines: { id: string }[] };
    expect(byReference.body.items[0]).toMatchObject({ phone: '01098765432', address: '12 Fouad St, Raml Station', customerNotes: 'Call after 5pm', statusHistory: [{ status: 'NEW', by: null }] });

    const logoFile = await http().get(`/v1/admin/stand-orders/${detail.id}/lines/${detail.lines[0]!.id}/logo`).set(auth(admin)).expect(200);
    expect(logoFile.headers['content-type']).toBe('image/png');

    const move = (status: string, note?: string) => http().patch(`/v1/admin/stand-orders/${detail.id}/status`).set(auth(admin)).send({ status, note });
    const skipped = await move('SHIPPED').expect(409);
    expect(skipped.body.error).toMatchObject({ code: 'INVALID_STATUS_CHANGE', details: { from: 'NEW', allowed: ['CONFIRMED', 'CANCELLED'] } });
    await move('CONFIRMED', 'Called; design approved').expect(200);
    expect(t.mailer.lastTo('mona@cafe.test')?.subject).toBe(`أكدنا طلبك · ${placed.body.order.reference}`);
    await move('IN_PRODUCTION').expect(200);
    await move('SHIPPED').expect(200);
    const delivered = await move('DELIVERED').expect(200);
    expect(delivered.body.statusHistory).toMatchObject([
      { status: 'NEW' },
      { status: 'CONFIRMED', by: 'Platform Admin', note: 'Called; design approved' },
      { status: 'IN_PRODUCTION' },
      { status: 'SHIPPED' },
      { status: 'DELIVERED' },
    ]);

    const cash = await http().patch(`/v1/admin/stand-orders/${detail.id}`).set(auth(admin)).send({ paymentStatus: 'PAID', adminNote: 'Collected by Bosta' }).expect(200);
    expect(cash.body).toMatchObject({ paymentStatus: 'PAID', adminNote: 'Collected by Bosta', paidAt: expect.any(String) });
    expect((await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200)).body).not.toHaveProperty('adminNote');
  });

  it('needs a reason to cancel, and is for administrators only', async () => {
    const { token: admin } = await signInAdmin(t);
    const placed = await order({}).expect(201);
    const id = (await t.prisma.standOrder.findFirstOrThrow()).id;
    await http().patch(`/v1/admin/stand-orders/${id}/status`).set(auth(admin)).send({ status: 'CANCELLED' }).expect(400);
    await http().patch(`/v1/admin/stand-orders/${id}/status`).set(auth(admin)).send({ status: 'CANCELLED', note: 'Customer changed their mind' }).expect(200);
    expect(t.mailer.lastTo('mona@cafe.test')?.text).toContain('Customer changed their mind');
    expect((await http().get(`/v1/public/shop/orders/${placed.body.trackingToken}`).expect(200)).body.status).toBe('CANCELLED');

    const owner = await signUpOwner(t, 'owner@koshary.test');
    await http().get('/v1/admin/stand-orders').set(auth(owner)).expect(403);
    await http().get('/v1/admin/stand-orders').expect(401);
    await http().get(`/v1/admin/stand-orders/${randomUUID()}`).set(auth(admin)).expect(404);
  });
});
