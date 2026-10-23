import type { AddressInfo } from 'node:net';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { PushService, type PushOptions, type PushOutcome, type PushTarget } from '../src/infrastructure/push/push.service.js';
import { PUSH_JOBS, type PushJobs } from '../src/infrastructure/queues/queues.module.js';
import { MediaService } from '../src/modules/media/media.service.js';
import { TrackingTokens } from '../src/modules/orders/tracking-token.js';
import { MaintenanceService } from '../src/worker/maintenance.service.js';
import { PushProcessor } from '../src/worker/push.processor.js';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

const HOUR_MS = 60 * 60 * 1000;

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Shop = { token: string; restaurantId: string; dish: { id: string; variant: string } };

/** An owner on the trial (the Full Experience plan) with ordering on and one dish. */
async function shop(email = 'owner@koshary.test', subdomain = 'koshary'): Promise<Shop> {
  const token = await signUpOwner(t, email);
  const restaurant = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const dish = await http()
    .post('/v1/menu/items')
    .set(auth(token))
    .send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 3500 }] })
    .expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  return { token, restaurantId: restaurant.body.id, dish: { id: dish.body.id, variant: dish.body.variants[0].id } };
}

async function order(s: Shop, type: 'PICKUP' | 'DINE_IN' = 'PICKUP', subdomain = 'koshary') {
  const response = await http()
    .post(`/v1/public/restaurants/${subdomain}/orders`)
    .set('Idempotency-Key', randomUUID())
    .send({ type, customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: s.dish.id, variantId: s.dish.variant, quantity: 1 }] })
    .expect(201);
  const orderId = (await t.prisma.order.findFirstOrThrow({ orderBy: { placedAt: 'desc' }, select: { id: true } })).id;
  return { trackingToken: response.body.trackingToken as string, id: orderId };
}

/** What a browser's PushSubscription.toJSON() looks like, with real P-256 keys. */
function browserSubscription(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

const subscribe = (trackingToken: string, body: object) => http().post(`/v1/public/orders/${trackingToken}/push`).send(body);
const setStatus = (token: string, id: string, status: string, reason?: string) =>
  http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status, reason }).expect(200);
const usePlan = (restaurantId: string, planCode: 'MENU' | 'ORDERS' | 'ADVANCED') =>
  t.prisma.entitlement.updateMany({ where: { restaurantId }, data: { planCode } });

function connectOwner(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/owner`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
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

describe('alerts on the tracking page', () => {
  it('rings on the Full Experience plan only, and offers the push key', async () => {
    const s = await shop();
    const { trackingToken } = await order(s);
    const publicKey = t.app.get(ConfigService).get('VAPID_PUBLIC_KEY');

    const full = await http().get(`/v1/public/orders/${trackingToken}/alerts`).expect(200);
    expect(full.body).toEqual({ readyAlerts: true, push: { publicKey } });
    expect(full.headers['cache-control']).toBe('no-store');

    await usePlan(s.restaurantId, 'ORDERS');
    expect((await http().get(`/v1/public/orders/${trackingToken}/alerts`).expect(200)).body).toEqual({ readyAlerts: false, push: null });

    const unknown = await http().get(`/v1/public/orders/${trackingToken.slice(0, -2)}xx/alerts`).expect(404);
    expect(unknown.body.error.code).toBe('ORDER_NOT_FOUND');
    await http().get('/v1/public/orders/not-a-token/alerts').expect(404);
  });

  it('still rings without push when the server has no push keys', async () => {
    const s = await shop();
    const { trackingToken } = await order(s);
    const push = t.app.get(PushService);
    const spy = vi.spyOn(push, 'publicKey', 'get').mockReturnValue(null);
    try {
      expect((await http().get(`/v1/public/orders/${trackingToken}/alerts`).expect(200)).body).toEqual({ readyAlerts: true, push: null });
      const refused = await subscribe(trackingToken, browserSubscription()).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'PUSH_UNAVAILABLE', details: { reason: 'NOT_CONFIGURED' } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('push subscriptions', () => {
  it('saves a browser, shows the bell on the board live, and forgets it', async () => {
    const s = await shop();
    const placed = await order(s);
    const before = (await http().get(`/v1/orders/${placed.id}`).set(auth(s.token)).expect(200)).body;
    expect(before.notifiesDiner).toBe(false);

    const owner = await connectOwner(s.token);
    try {
      const update = new Promise<{ order: { notifiesDiner: boolean; updatedAt: string } }>((resolve) => owner.once('order.updated', resolve));
      const browser = browserSubscription();
      await subscribe(placed.trackingToken, { ...browser, language: 'en' }).expect(204);
      const event = await update;
      expect(event.order.notifiesDiner).toBe(true);
      expect(event.order.updatedAt > before.updatedAt).toBe(true);

      // The same browser again (new keys after a reinstall) replaces its row.
      const renewed = { ...browserSubscription(browser.endpoint), language: 'ar' };
      await subscribe(placed.trackingToken, renewed).expect(204);
      const rows = await t.prisma.pushSubscription.findMany({ where: { orderId: placed.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ endpoint: browser.endpoint, p256dh: renewed.keys.p256dh, auth: renewed.keys.auth, language: 'ar' });

      await http().delete(`/v1/public/orders/${placed.trackingToken}/push`).send({ endpoint: browser.endpoint }).expect(204);
      await http().delete(`/v1/public/orders/${placed.trackingToken}/push`).send({ endpoint: browser.endpoint }).expect(204);
      expect(await t.prisma.pushSubscription.count()).toBe(0);
      expect((await http().get(`/v1/orders/${placed.id}`).set(auth(s.token)).expect(200)).body.notifiesDiner).toBe(false);
    } finally {
      owner.close();
    }
  });

  it('only accepts real browser push services, with well-formed keys', async () => {
    const s = await shop();
    const { trackingToken } = await order(s);
    const refused = [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://evil.example.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example.com/abc',
      'https://notify.windows.com/abc',
      'https://127.0.0.1/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    ];
    for (const endpoint of refused) {
      const response = await subscribe(trackingToken, browserSubscription(endpoint)).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
    const good = browserSubscription();
    await subscribe(trackingToken, { ...good, keys: { ...good.keys, p256dh: 'short' } }).expect(400);
    await subscribe(trackingToken, { ...good, keys: { ...good.keys, auth: 'has spaces and !!' } }).expect(400);
    await subscribe(trackingToken, { ...good, language: 'fr' }).expect(400);

    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QFz1abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      await subscribe(trackingToken, browserSubscription(endpoint)).expect(204);
    }
    expect(await t.prisma.pushSubscription.count()).toBe(3);
  });

  it('needs the Full Experience plan and an order still being made', async () => {
    const s = await shop();
    const placed = await order(s);

    await usePlan(s.restaurantId, 'ORDERS');
    const plan = await subscribe(placed.trackingToken, browserSubscription()).expect(409);
    expect(plan.body.error).toMatchObject({ code: 'PUSH_UNAVAILABLE', details: { reason: 'PLAN' } });

    await usePlan(s.restaurantId, 'ADVANCED');
    await setStatus(s.token, placed.id, 'ACCEPTED');
    await subscribe(placed.trackingToken, browserSubscription()).expect(204);
    await setStatus(s.token, placed.id, 'PREPARING');
    await setStatus(s.token, placed.id, 'READY');
    const late = await subscribe(placed.trackingToken, browserSubscription()).expect(409);
    expect(late.body.error).toMatchObject({ code: 'PUSH_UNAVAILABLE', details: { reason: 'ORDER_FINISHED' } });

    await subscribe('not-a-token', browserSubscription()).expect(404);
  });

  it('keeps the five newest browsers per order', async () => {
    const s = await shop();
    const { trackingToken, id } = await order(s);
    const endpoints: string[] = [];
    for (let i = 0; i < 6; i++) {
      const browser = browserSubscription();
      endpoints.push(browser.endpoint);
      await subscribe(trackingToken, browser).expect(204);
    }
    const kept = await t.prisma.pushSubscription.findMany({ where: { orderId: id }, select: { endpoint: true } });
    expect(kept.map(({ endpoint }) => endpoint).sort()).toEqual(endpoints.slice(1).sort());
  });

  it('allows DELETE from restaurant sites (CORS)', async () => {
    const preflight = await http()
      .options('/v1/public/orders/abc/push')
      .set('Origin', 'https://koshary.bilhanah.test')
      .set('Access-Control-Request-Method', 'DELETE')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toContain('DELETE');
  });
});

describe('sending', () => {
  it('queues one push per browser when the order is ready, rejected or cancelled', async () => {
    const s = await shop();
    const jobs = t.app.get<PushJobs>(PUSH_JOBS);
    const queued = async () =>
      (await jobs.getJobs(['waiting', 'delayed', 'active'])).map((job) => ({ id: job.id, ...job.data })).sort((a, b) => a.id!.localeCompare(b.id!));

    const first = await order(s);
    await subscribe(first.trackingToken, browserSubscription()).expect(204);
    await subscribe(first.trackingToken, browserSubscription()).expect(204);
    const subscriptions = await t.prisma.pushSubscription.findMany({ where: { orderId: first.id }, orderBy: { id: 'asc' } });

    await setStatus(s.token, first.id, 'ACCEPTED');
    await setStatus(s.token, first.id, 'PREPARING');
    expect(await queued()).toEqual([]);
    await setStatus(s.token, first.id, 'READY');
    expect(await queued()).toEqual(subscriptions.map(({ id }) => ({ id: `${id}_READY`, subscriptionId: id, status: 'READY' })));

    // Nobody listening: nothing to queue.
    const quiet = await order(s);
    await setStatus(s.token, quiet.id, 'REJECTED', 'Out of rice');
    expect(await queued()).toHaveLength(2);

    const cancelled = await order(s);
    await subscribe(cancelled.trackingToken, browserSubscription()).expect(204);
    await setStatus(s.token, cancelled.id, 'ACCEPTED');
    await setStatus(s.token, cancelled.id, 'CANCELLED', 'Kitchen closed early');
    expect((await queued()).filter((job) => job.status === 'CANCELLED')).toHaveLength(1);
  });

  it('writes the update in the diner’s language, links the order, and drops dead browsers', async () => {
    const s = await shop();
    const placed = await order(s);
    await subscribe(placed.trackingToken, { ...browserSubscription(), language: 'ar' }).expect(204);
    await subscribe(placed.trackingToken, { ...browserSubscription(), language: 'en' }).expect(204);
    const arabic = await t.prisma.pushSubscription.findFirstOrThrow({ where: { orderId: placed.id, language: 'ar' } });
    const english = await t.prisma.pushSubscription.findFirstOrThrow({ where: { orderId: placed.id, language: 'en' } });

    const sent: { target: PushTarget; payload: Record<string, unknown>; options: PushOptions }[] = [];
    let outcome: PushOutcome | Error = 'delivered';
    const fakePush = {
      send: async (target: PushTarget, payload: string, options: PushOptions) => {
        sent.push({ target, payload: JSON.parse(payload) as Record<string, unknown>, options });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as unknown as PushService;
    const processor = new PushProcessor(t.prisma, fakePush, t.app.get(MediaService), t.app.get(TrackingTokens), t.app.get(ConfigService));
    const orderNumber = (await t.prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).number;

    expect(await processor.process({ data: { subscriptionId: arabic.id, status: 'READY' } })).toBe('delivered');
    expect(sent[0]!.target).toMatchObject({ endpoint: arabic.endpoint, p256dh: arabic.p256dh, auth: arabic.auth });
    expect(sent[0]!.payload).toEqual({
      title: 'Koshary Abou Tarek',
      body: `طلبك رقم ${orderNumber.toLocaleString('ar-EG')} جاهز، اتفضل استلمه. بالهنا!`,
      url: `https://koshary.bilhanah.test/order/${placed.trackingToken}`,
      tag: `order-${placed.id}`,
      status: 'READY',
      icon: null,
    });
    expect(sent[0]!.options).toEqual({ topic: placed.id.replaceAll('-', ''), ttlSeconds: 3600 });

    await processor.process({ data: { subscriptionId: english.id, status: 'READY' } });
    expect(sent[1]!.payload.body).toBe(`Order #${orderNumber} is ready for pickup. Enjoy!`);

    // A failure worth retrying reaches BullMQ; a refused message is dropped but the browser kept.
    outcome = new Error('push service unavailable');
    await expect(processor.process({ data: { subscriptionId: english.id, status: 'READY' } })).rejects.toThrow('push service unavailable');
    outcome = 'rejected';
    expect(await processor.process({ data: { subscriptionId: english.id, status: 'READY' } })).toBe('rejected');
    expect(await t.prisma.pushSubscription.count()).toBe(2);

    outcome = 'gone';
    expect(await processor.process({ data: { subscriptionId: english.id, status: 'READY' } })).toBe('gone');
    expect(await t.prisma.pushSubscription.findUnique({ where: { id: english.id } })).toBeNull();
    expect(await processor.process({ data: { subscriptionId: english.id, status: 'READY' } })).toBe('skipped');
  });

  it('forgets browsers an hour after the order is finished, and after two days at most', async () => {
    const s = await shop();
    const now = new Date();
    const done = await order(s);
    const waiting = await order(s);
    const stale = await order(s);
    for (const { trackingToken } of [done, waiting, stale]) await subscribe(trackingToken, browserSubscription()).expect(204);
    for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await setStatus(s.token, done.id, status);
    await t.prisma.order.update({ where: { id: done.id }, data: { updatedAt: new Date(now.getTime() - 2 * HOUR_MS) } });
    await t.prisma.pushSubscription.updateMany({ where: { orderId: stale.id }, data: { createdAt: new Date(now.getTime() - 49 * HOUR_MS) } });

    const result = await new MaintenanceService(t.prisma).purgeExpired(now);
    expect(result.pushSubscriptions).toBe(2);
    expect((await t.prisma.pushSubscription.findMany({ select: { orderId: true } })).map(({ orderId }) => orderId)).toEqual([waiting.id]);
  });
});

describe('Home Screen install', () => {
  it('describes each restaurant as an app that opens its menu, or the order being tracked', async () => {
    const s = await shop();
    const { trackingToken } = await order(s);
    const response = await http()
      .get('/v1/public/restaurants/KOSHARY/manifest.webmanifest')
      .set('Origin', 'https://koshary.bilhanah.test')
      .expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const manifest = JSON.parse(response.text);
    const host = response.request.url.replace(/\/v1\/.*$/, '');
    expect(manifest).toEqual({
      id: 'https://koshary.bilhanah.test/',
      name: 'Koshary Abou Tarek',
      short_name: 'Koshary Abou Tarek',
      description: 'منيو Koshary Abou Tarek على بالهنا',
      lang: 'ar',
      dir: 'rtl',
      start_url: 'https://koshary.bilhanah.test/',
      scope: 'https://koshary.bilhanah.test/',
      display: 'standalone',
      background_color: '#fff8ef',
      theme_color: '#075e54',
      icons: [
        { src: `${host}/v1/public/restaurants/koshary/icon-192.png?v=mark`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${host}/v1/public/restaurants/koshary/icon-512.png?v=mark`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${host}/v1/public/restaurants/koshary/icon-512.png?v=mark`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });

    const tracking = await http().get(`/v1/public/restaurants/koshary/manifest.webmanifest?start=/order/${trackingToken}`).expect(200);
    expect(JSON.parse(tracking.text).start_url).toBe(`https://koshary.bilhanah.test/order/${trackingToken}`);
    for (const start of ['https://evil.example.com/', '/order/not-a-token', '//evil.example.com', '/admin']) {
      const other = await http().get('/v1/public/restaurants/koshary/manifest.webmanifest').query({ start }).expect(200);
      expect(JSON.parse(other.text).start_url).toBe('https://koshary.bilhanah.test/');
    }
    await http().get('/v1/public/restaurants/nobody/manifest.webmanifest').expect(404);
  });

  it('draws square icons from the logo, or the Bilhanah mark', async () => {
    const s = await shop();
    for (const size of [180, 192, 512]) {
      const icon = await http().get(`/v1/public/restaurants/koshary/icon-${size}.png`).expect(200);
      expect(icon.headers['content-type']).toBe('image/png');
      expect(icon.headers['cache-control']).toBe('public, max-age=86400');
      expect(icon.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(await sharp(icon.body as Buffer).metadata()).toMatchObject({ width: size, height: size, format: 'png' });
    }
    const wrong = await http().get('/v1/public/restaurants/koshary/icon-100.png').expect(404);
    expect(wrong.body.error.code).toBe('NOT_FOUND');
    await http().get('/v1/public/restaurants/nobody/icon-192.png').expect(404);

    // A wide red logo: centred on white, inside the maskable safe zone.
    const logoFile = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const logo = await http().post('/v1/media?kind=LOGO').set(auth(s.token)).attach('file', logoFile, 'logo.jpg').expect(201);
    await http().patch('/v1/restaurants/mine').set(auth(s.token)).send({ logoId: logo.body.id, brandColor: '#0F5C4C' }).expect(200);
    const manifest = JSON.parse((await http().get('/v1/public/restaurants/koshary/manifest.webmanifest').expect(200)).text);
    expect(manifest.theme_color).toBe('#0f5c4c');
    expect(manifest.icons[0].src).toMatch(new RegExp(`icon-192\\.png\\?v=${logo.body.id.slice(0, 8)}$`));

    const icon = await http().get('/v1/public/restaurants/koshary/icon-512.png').expect(200);
    const { data, info } = await sharp(icon.body as Buffer).raw().toBuffer({ resolveWithObject: true });
    // The logo went through JPEG and WebP, so colours are close rather than exact.
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 8);
    expect(near(pixel(256, 256), [255, 0, 0])).toBe(true);
    expect(near(pixel(10, 10), [255, 255, 255])).toBe(true);
    expect(near(pixel(256, 100), [255, 255, 255])).toBe(true); // above the wide logo
  });
});
