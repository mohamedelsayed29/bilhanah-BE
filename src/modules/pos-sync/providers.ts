import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PosProviderCapability, PosProviderInfo, PosWebhookConfig } from '@bilhanah/contracts';

/** Secrets of an integration, sealed at rest. */
export type PosCredentials = { outboundSecret: string; inboundSecret: string };
export type ProviderContext = { config: PosWebhookConfig; credentials: PosCredentials; deliveryId: string };

/** A provider call that failed: retried when `retryable`, after `retryAfterMs` when the provider says so. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly statusCode: number | null = null, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

/** The adapter does not do this: callers report it instead of pretending it worked. */
export class UnsupportedCapability extends Error {
  constructor(readonly capability: PosProviderCapability) {
    super(`Not supported: ${capability}`);
  }
}

/** An event received from the provider, after its signature was checked. */
export type InboundEvent =
  | { id: string; type: 'order.status'; orderId?: string; externalOrderId?: string; status: string }
  | { id: string; type: 'order.paid'; orderId?: string; externalOrderId?: string; amountPiastres: number; method: string; reference?: string }
  | { id: string; type: 'unknown'; raw: string };

/**
 * A POS provider (docs/POS.md, task 6). Every capability is a method; one the provider lacks throws
 * UnsupportedCapability. Only providers whose API is documented and reachable are added.
 */
export interface PosProviderAdapter {
  readonly info: PosProviderInfo;
  testConnection(context: ProviderContext): Promise<void>;
  fetchMenu(context: ProviderContext): Promise<never>;
  syncMenu(context: ProviderContext): Promise<never>;
  createOrder(context: ProviderContext, order: unknown): Promise<{ externalId: string | null }>;
  cancelOrder(context: ProviderContext, order: unknown): Promise<void>;
  fetchOrderStatus(context: ProviderContext, externalId: string): Promise<never>;
  /** Checks the request came from the provider; false rejects it. */
  verifyWebhook(context: ProviderContext, rawBody: Buffer, headers: Record<string, string | undefined>, now: Date): boolean;
  parseWebhook(body: unknown): InboundEvent;
}

const sign = (secret: string, timestamp: string, body: string | Buffer) =>
  createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');

/** How far a signed timestamp may be from now (replays are refused, besides the event id). */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Generic webhooks: for any POS that can receive an HTTPS request and send signed ones back.
 * Bilhanah POSTs orders (and cancellations) to the endpoint, signed with the outbound secret
 * (X-Bilhanah-Signature: sha256=HMAC(secret, "<timestamp>.<body>")); the POS answers 2xx, with
 * `{ "externalId": "…" }` to link its id. The POS sends status updates and payments, signed the
 * same way with the inbound secret. Menus stay in Bilhanah: there is no menu API to pull from.
 */
export class WebhookProvider implements PosProviderAdapter {
  readonly info: PosProviderInfo = {
    key: 'WEBHOOK',
    name: ['Webhook (أي سيستم بيدعم webhooks)', 'Webhook (any POS with webhooks)'],
    description: [
      'بالهنا بتبعت الطلبات لسيستمك، وسيستمك يبعت حالة الطلب والدفع. المنيو بيفضل في بالهنا.',
      'Bilhanah sends orders to your POS; your POS sends order statuses and payments back. The menu stays in Bilhanah.',
    ],
    capabilities: ['testConnection', 'createOrder', 'cancelOrder', 'handleWebhook', 'syncPaymentStatus'],
    sourceOfTruth: { menu: 'BILHANAH', orders: 'BILHANAH', orderStatus: 'EXTERNAL', payments: 'EXTERNAL' },
  };

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async testConnection(context: ProviderContext): Promise<void> {
    await this.send(context, 'ping', { message: 'Bilhanah connection test' });
  }

  fetchMenu(): Promise<never> { return Promise.reject(new UnsupportedCapability('fetchMenu')); }
  syncMenu(): Promise<never> { return Promise.reject(new UnsupportedCapability('syncMenu')); }
  fetchOrderStatus(): Promise<never> { return Promise.reject(new UnsupportedCapability('fetchOrderStatus')); }

  async createOrder(context: ProviderContext, order: unknown): Promise<{ externalId: string | null }> {
    const body = await this.send(context, 'order.created', order);
    const externalId = typeof (body as { externalId?: unknown } | null)?.externalId === 'string' ? (body as { externalId: string }).externalId.slice(0, 120) : null;
    return { externalId };
  }

  async cancelOrder(context: ProviderContext, order: unknown): Promise<void> {
    await this.send(context, 'order.cancelled', order);
  }

  verifyWebhook(context: ProviderContext, rawBody: Buffer, headers: Record<string, string | undefined>, now: Date): boolean {
    const timestamp = headers['x-bilhanah-timestamp'];
    const signature = headers['x-bilhanah-signature']?.replace(/^sha256=/, '');
    if (!timestamp || !signature || !/^\d{10,13}$/.test(timestamp)) return false;
    const millis = timestamp.length === 13 ? Number(timestamp) : Number(timestamp) * 1000;
    if (Math.abs(now.getTime() - millis) > WEBHOOK_TOLERANCE_MS) return false;
    const expected = Buffer.from(sign(context.credentials.inboundSecret, timestamp, rawBody), 'hex');
    const given = Buffer.from(signature, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  parseWebhook(body: unknown): InboundEvent {
    const event = (body ?? {}) as Record<string, unknown>;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const id = typeof event.id === 'string' ? event.id.slice(0, 120) : '';
    const orderRef = { ...(typeof data.orderId === 'string' && { orderId: data.orderId }), ...(typeof data.externalOrderId === 'string' && { externalOrderId: data.externalOrderId.slice(0, 120) }) };
    if (event.type === 'order.status' && typeof data.status === 'string') return { id, type: 'order.status', ...orderRef, status: data.status };
    if (event.type === 'order.paid' && typeof data.amountPiastres === 'number' && typeof data.method === 'string') {
      return { id, type: 'order.paid', ...orderRef, amountPiastres: data.amountPiastres, method: data.method, ...(typeof data.reference === 'string' && { reference: data.reference.slice(0, 100) }) };
    }
    return { id, type: 'unknown', raw: String(event.type ?? '') };
  }

  private async send(context: ProviderContext, event: string, data: unknown): Promise<unknown> {
    const timestamp = String(Date.now());
    const body = JSON.stringify({ id: context.deliveryId, event, occurredAt: new Date().toISOString(), data });
    let response: Response;
    try {
      response = await this.fetcher(context.config.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'User-Agent': 'Bilhanah-POS-Sync/1', 'X-Bilhanah-Event': event, 'X-Bilhanah-Delivery': context.deliveryId,
          'X-Bilhanah-Timestamp': timestamp, 'X-Bilhanah-Signature': `sha256=${sign(context.credentials.outboundSecret, timestamp, body)}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(`Could not reach the POS: ${(error as Error).message}`.slice(0, 300), true);
    }
    if (response.ok) return response.json().catch(() => null);
    const retryAfter = Number(response.headers.get('retry-after'));
    if (response.status === 429) throw new ProviderError('The POS asked to slow down (429).', true, 429, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    const retryable = response.status === 408 || response.status >= 500;
    throw new ProviderError(`The POS answered ${response.status}.`, retryable, response.status);
  }
}

/** The providers Bilhanah has adapters for. */
export const PROVIDERS = new Map<string, PosProviderAdapter>([['WEBHOOK', new WebhookProvider()]]);
