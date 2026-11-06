import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { TrackingTokens } from '../src/modules/orders/tracking-token.js';
import { auth, fixtures as inventoryFixtures } from './inventory-fixtures.js';
import type { TestApp } from './test-app.js';

// Shared set-up for the reviews end-to-end tests: the inventory fixtures' two-branch restaurant
// (Downtown, the main branch, and Nasr City; koshary in two sizes and a lemonade) with completed
// orders to review through their tracking links.

export { auth };

export type Chain = Awaited<ReturnType<ReturnType<typeof inventoryFixtures>['chain']>>;

export function fixtures(app: () => TestApp) {
  const base = inventoryFixtures(app);
  const { http, setStatus } = base;

  const settings = (token: string, body: Record<string, unknown>) => http().put('/v1/reviews/settings').set(auth(token)).send(body);

  /** The chain with reviews switched on (and any other settings given). */
  async function reviewing(extra: Record<string, unknown> = {}, email?: string, subdomain?: string) {
    const r = await base.chain(email, subdomain);
    await settings(r.token, { enabled: true, ...extra }).expect(200);
    return r;
  }

  /** Places an order through the public API: its id, tracking token and line ids. */
  async function order(r: Chain, items?: { menuItemId: string; variantId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
    const lines = items ?? [{ menuItemId: r.koshary.id, variantId: r.koshary.large, quantity: 2 }, { menuItemId: r.lemonade.id, variantId: r.lemonade.variant, quantity: 1 }];
    const placed = await http().post(`/v1/public/restaurants/${r.subdomain}/orders`).set('Idempotency-Key', randomUUID())
      .send({ type: 'PICKUP', customerName: 'Mona Ahmed', customerPhone: '01098765432', items: lines, ...extra }).expect(201);
    const orderId = app().app.get(TrackingTokens).verify(placed.body.trackingToken)!;
    const itemIds = (await app().prisma.orderItem.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' } })).map((item) => item.id);
    return { orderId, token: placed.body.trackingToken as string, itemIds };
  }

  /** Moves an order along to `status` (READY or COMPLETED, or a closing one). */
  async function advance(token: string, orderId: string, status: 'READY' | 'COMPLETED' | 'REJECTED' | 'CANCELLED') {
    if (status === 'REJECTED') return setStatus(token, orderId, 'REJECTED').expect(200);
    await setStatus(token, orderId, 'ACCEPTED').expect(200);
    if (status === 'CANCELLED') return setStatus(token, orderId, 'CANCELLED').expect(200);
    await setStatus(token, orderId, 'READY').expect(200);
    if (status === 'COMPLETED') await setStatus(token, orderId, 'COMPLETED').expect(200);
  }

  /** A completed order (at the main branch unless another branch slug is given). */
  async function completed(r: Chain, extra: Record<string, unknown> = {}) {
    const placed = await order(r, undefined, extra);
    await advance(r.token, placed.orderId, 'COMPLETED');
    return placed;
  }

  const state = (trackingToken: string) => http().get(`/v1/public/orders/${trackingToken}/review`);
  const submit = (trackingToken: string, body: Record<string, unknown>) => http().put(`/v1/public/orders/${trackingToken}/review`).send(body);

  /** A completed order reviewed with `body`; returns the review's id too. */
  async function reviewed(r: Chain, body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const placed = await completed(r, extra);
    const response = await submit(placed.token, body).expect(200);
    const review = await app().prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } });
    return { ...placed, reviewId: review.id, response: response.body };
  }

  /** A JPEG with camera metadata, large enough for the media pipeline. */
  const photo = (width = 640, height = 480) =>
    sharp({ create: { width, height, channels: 3, background: '#c0392b' } }).jpeg().withExif({ IFD0: { Make: 'TestCam', Artist: 'Mona' } }).toBuffer();

  /** Uploads a review photo for the order and checks the status (201 by default). */
  async function upload(trackingToken: string, status = 201) {
    const response = await http().post(`/v1/public/orders/${trackingToken}/review/photos`).attach('file', await photo(), { filename: 'dish.jpg', contentType: 'image/jpeg' });
    expect(response.status).toBe(status);
    return response;
  }

  return { ...base, settings, reviewing, order, advance, completed, state, submit, reviewed, photo, upload };
}
