import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { PosSyncService } from '../src/modules/pos-sync/pos-sync.service.js';
import { createTestApp, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let server: Server;
let endpoint: string;
/** What the fake POS answers next (status, body, headers), and what it received. */
let replies: { status: number; body?: unknown; headers?: Record<string, string> }[] = [];
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  t = await createTestApp();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      const reply = replies.shift() ?? { status: 200, body: {} };
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bilhanah`;
});
afterAll(async () => { server.close(); await t.app.close(); });
let admin: string | null = null;
beforeEach(async () => { await t.reset(); replies = []; received.length = 0; admin = null; });

const CONFIG = () => ({ endpointUrl: endpoint, pushChannels: ['MENU', 'POS'], pushCancellations: true, acceptStatusUpdates: true, acceptPayments: true });
const SETTINGS = { taxRateBps: 0, taxInclusive: true, serviceChargeBps: 0, serviceChargeDineInOnly: true, paymentMethods: ['CASH', 'CARD'], cashierMaxDiscountPercent: 0, requireOpenShift: false, receiptHeader: null, receiptFooter: null, receiptShowLogo: true };

async function setup(subdomain = 'koshary', mode = 'BOTH') {
  const token = await signUpOwner(t, `owner@${subdomain}.test`);
  const created = await http().post('/v1/restaurants').set(auth(token)).send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  admin ??= (await signInAdmin(t)).token;
  await http().put('/v1/admin/pos/settings').set(auth(admin)).send({ enabled: true, plans: ['ORDERS', 'ADVANCED'] }).expect(200);
  await http().post('/v1/pos/activate').set(auth(token)).send({ mode }).expect(201);
  await http().put('/v1/pos/settings').set(auth(token)).send(SETTINGS).expect(200);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const item = (await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ pricePiastres: 5000 }] }).expect(201)).body;
  return { token, id: created.body.id as string, admin, line: { menuItemId: item.id as string, variantId: item.variants[0].id as string, quantity: 2 } };
}
const posOrder = (token: string, line: unknown) => http().post('/v1/pos/orders').set(auth(token)).set('Idempotency-Key', `o-${Math.random().toString(36).slice(2, 12)}`).send({ type: 'PICKUP', items: [line] });
let tick = 0;
/** Each run is two hours later than the last, past any backoff. */
const run = () => t.app.get(PosSyncService).runDue(new Date(Date.now() + (tick += 1) * 2 * 60 * 60 * 1000));
const signed = (secret: string, body: unknown, timestamp = String(Date.now())) => {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'Content-Type': 'application/json', 'X-Bilhanah-Timestamp': timestamp, 'X-Bilhanah-Signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}` } };
};

describe('external POS integrations', () => {
  it('connects with secrets shown once, tests the connection, and refuses unsupported operations honestly', async () => {
    const r = await setup();
    const providers = (await http().get('/v1/pos/providers').set(auth(r.token)).expect(200)).body;
    expect(providers.map((p: { key: string }) => p.key)).toEqual(['WEBHOOK']);
    await http().post('/v1/pos/integrations').set(auth(r.token)).send({ provider: 'FOODICS', name: 'X', branchId: null, config: CONFIG() }).expect(400);
    const { integration, secrets } = (await http().post('/v1/pos/integrations').set(auth(r.token)).send({ provider: 'WEBHOOK', name: 'Our POS', branchId: null, config: CONFIG() }).expect(201)).body;
    expect(secrets.outboundSecret).toEqual(expect.any(String));
    // Never stored or returned in clear.
    const row = await t.prisma.posIntegration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(row.credentialsSealed).not.toContain(secrets.outboundSecret);
    expect(JSON.stringify((await http().get('/v1/pos/integrations').set(auth(r.token)).expect(200)).body)).not.toContain(secrets.inboundSecret);

    replies.push({ status: 200 });
    expect((await http().post(`/v1/pos/integrations/${integration.id}/test`).set(auth(r.token)).expect(200)).body).toMatchObject({ lastTestOk: true });
    const ping = received.at(-1)!;
    const expected = createHmac('sha256', secrets.outboundSecret).update(`${ping.headers['x-bilhanah-timestamp']}.${ping.body}`).digest('hex');
    expect(ping.headers['x-bilhanah-signature']).toBe(`sha256=${expected}`);
    replies.push({ status: 503 });
    expect((await http().post(`/v1/pos/integrations/${integration.id}/test`).set(auth(r.token)).expect(200)).body).toMatchObject({ lastTestOk: false, lastError: 'The POS answered 503.' });
    expect((await http().post(`/v1/pos/integrations/${integration.id}/sync-menu`).set(auth(r.token)).expect(409)).body.error).toMatchObject({ code: 'POS_CAPABILITY_UNSUPPORTED', details: { capability: 'syncMenu' } });
  });

  it('sends orders once the provider confirms, retries outages and rate limits, and keeps failures for a manual retry', async () => {
    const r = await setup();
    const { integration } = (await http().post('/v1/pos/integrations').set(auth(r.token)).send({ provider: 'WEBHOOK', name: 'Our POS', branchId: null, config: CONFIG() }).expect(201)).body;
    const placed = (await posOrder(r.token, r.line).expect(201)).body;
    // Down, then rate-limited, then accepted with its id.
    replies.push({ status: 500 }, { status: 429, headers: { 'Retry-After': '1' } }, { status: 200, body: { externalId: 'EXT-42' } });
    await run();
    let job = await t.prisma.posSyncJob.findFirstOrThrow({ where: { integrationId: integration.id } });
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500 });
    await run();
    job = await t.prisma.posSyncJob.findFirstOrThrow({ where: { id: job.id } });
    expect(job).toMatchObject({ status: 'PENDING', attempts: 2, lastStatusCode: 429 });
    await run();
    job = await t.prisma.posSyncJob.findFirstOrThrow({ where: { id: job.id } });
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    const sent = JSON.parse(received.at(-1)!.body);
    expect(sent).toMatchObject({ event: 'order.created', data: { orderId: placed.id, totalPiastres: 10000, items: [{ quantity: 2, unitPricePiastres: 5000 }] } });
    // The same delivery id every attempt: the POS can drop duplicates.
    expect(new Set(received.map((entry) => entry.headers['x-bilhanah-delivery'])).size).toBe(1);
    expect(await t.prisma.posMapping.findFirst({ where: { integrationId: integration.id, entity: 'ORDER' } })).toMatchObject({ localId: placed.id, externalId: 'EXT-42' });

    // A refusal (400) is not retried; it waits for a person.
    const second = (await posOrder(r.token, r.line).expect(201)).body;
    replies.push({ status: 400 });
    await run();
    const dead = await t.prisma.posSyncJob.findFirstOrThrow({ where: { entityId: second.id } });
    expect(dead).toMatchObject({ status: 'DEAD', lastStatusCode: 400 });
    expect((await http().get(`/v1/pos/integrations/${integration.id}/jobs?status=DEAD`).set(auth(r.token)).expect(200)).body).toHaveLength(1);
    await http().post(`/v1/pos/integrations/${integration.id}/jobs/${dead.id}/retry`).set(auth(r.token)).expect(204);
    replies.push({ status: 201 });
    await run();
    expect((await t.prisma.posSyncJob.findFirstOrThrow({ where: { id: dead.id } })).status).toBe('SUCCEEDED');

    // Paused: nothing is sent and nothing is lost; disconnected: history stays.
    await http().post(`/v1/pos/integrations/${integration.id}/pause`).set(auth(r.token)).expect(200);
    await posOrder(r.token, r.line).expect(201);
    const before = received.length;
    await run();
    expect(received.length).toBe(before);
    expect(await t.prisma.posSyncJob.count({ where: { integrationId: integration.id, status: 'PENDING' } })).toBe(1);
    await http().post(`/v1/pos/integrations/${integration.id}/disconnect`).set(auth(r.token)).expect(200);
    expect(await t.prisma.posSyncJob.count({ where: { integrationId: integration.id } })).toBe(3);
  });

  it('accepts signed webhooks once: status updates and payments, never echoed back; rejects forgeries', async () => {
    const r = await setup();
    const { integration, secrets } = (await http().post('/v1/pos/integrations').set(auth(r.token)).send({ provider: 'WEBHOOK', name: 'Our POS', branchId: null, config: CONFIG() }).expect(201)).body;
    const placed = (await posOrder(r.token, r.line).expect(201)).body;
    replies.push({ status: 200, body: { externalId: 'EXT-7' } });
    await run();
    const url = `/v1/public/pos/webhooks/${integration.id}`;
    const send = (body: unknown, secret = secrets.inboundSecret, timestamp?: string) => {
      const { raw, headers } = signed(secret, body, timestamp);
      return http().post(url).set(headers).send(raw);
    };
    await send({ id: 'evt-0', type: 'order.status', data: { externalOrderId: 'EXT-7', status: 'READY' } }, 'wrong-secret').expect(401);
    await send({ id: 'evt-0', type: 'order.status', data: { externalOrderId: 'EXT-7', status: 'READY' } }, secrets.inboundSecret, String(Date.now() - 60 * 60 * 1000)).expect(401);
    expect(await t.prisma.auditLog.count({ where: { action: 'pos.webhook.rejected' } })).toBe(2);

    expect((await send({ id: 'evt-1', type: 'order.status', data: { externalOrderId: 'EXT-7', status: 'READY' } }).expect(200)).body).toEqual({ outcome: 'PROCESSED' });
    expect((await send({ id: 'evt-1', type: 'order.status', data: { externalOrderId: 'EXT-7', status: 'READY' } }).expect(200)).body).toMatchObject({ duplicate: true });
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).status).toBe('READY');
    expect((await send({ id: 'evt-2', type: 'order.paid', data: { orderId: placed.id, amountPiastres: 10000, method: 'CARD', reference: 'T-99' } }).expect(200)).body).toEqual({ outcome: 'PROCESSED' });
    const order = await t.prisma.order.findUniqueOrThrow({ where: { id: placed.id }, include: { payments: true } });
    expect(order.paidAt).not.toBeNull();
    expect(order.payments[0]).toMatchObject({ method: 'CARD', reference: 'T-99', integrationId: integration.id });
    // An external cancel moves the order but is not sent back to the POS.
    const another = (await posOrder(r.token, r.line).expect(201)).body;
    replies.push({ status: 200, body: { externalId: 'EXT-8' } });
    await run();
    await send({ id: 'evt-3', type: 'order.status', data: { externalOrderId: 'EXT-8', status: 'CANCELLED' } }).expect(200);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: another.id } })).status).toBe('CANCELLED');
    expect(await t.prisma.posSyncJob.count({ where: { kind: 'order.cancel' } })).toBe(0);
    // Overpaying fails the event, logged.
    expect((await send({ id: 'evt-4', type: 'order.paid', data: { orderId: placed.id, amountPiastres: 500, method: 'CASH' } }).expect(200)).body.outcome).toBe('FAILED');
    const logs = (await http().get(`/v1/pos/integrations/${integration.id}/logs`).set(auth(r.token)).expect(200)).body;
    expect(logs.map((log: { outcome: string }) => log.outcome).sort()).toEqual(['FAILED', 'PROCESSED', 'PROCESSED', 'PROCESSED']);
  });

  it('keeps integrations, orders and mappings apart between restaurants', async () => {
    const a = await setup('resta');
    const b = await setup('restb');
    const { integration, secrets } = (await http().post('/v1/pos/integrations').set(auth(a.token)).send({ provider: 'WEBHOOK', name: 'A POS', branchId: null, config: CONFIG() }).expect(201)).body;
    await http().get(`/v1/pos/integrations/${integration.id}/jobs`).set(auth(b.token)).expect(404);
    await http().put(`/v1/pos/integrations/${integration.id}/mappings`).set(auth(a.token)).send({ entity: 'MENU_ITEM', localId: b.line.menuItemId, externalId: 'X1' }).expect(400);
    expect((await http().put(`/v1/pos/integrations/${integration.id}/mappings`).set(auth(a.token)).send({ entity: 'MENU_ITEM', localId: a.line.menuItemId, externalId: 'X1' }).expect(200)).body).toMatchObject({ externalId: 'X1' });
    // B's order is not reachable through A's webhook.
    const orderB = (await posOrder(b.token, b.line).expect(201)).body;
    const { raw, headers } = signed(secrets.inboundSecret, { id: 'evt-x', type: 'order.status', data: { orderId: orderB.id, status: 'READY' } });
    expect((await http().post(`/v1/public/pos/webhooks/${integration.id}`).set(headers).send(raw).expect(200)).body.outcome).toBe('FAILED');
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: orderB.id } })).status).toBe('ACCEPTED');
    // Bilhanah-only POS cannot manage integrations.
    const c = await setup('restc', 'BILHANAH');
    expect((await http().get('/v1/pos/integrations').set(auth(c.token)).expect(409)).body.error.code).toBe('POS_MODE_NOT_ALLOWED');
  });
});
