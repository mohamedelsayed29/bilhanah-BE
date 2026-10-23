import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';

export type PaymobBilling = { firstName: string; lastName: string; email: string; phone: string; city?: string; street?: string };

export type PaymobCheckoutInput = {
  /** Our reference, unique per checkout; Paymob returns it as order.merchant_order_id. */
  reference: string;
  amountPiastres: number;
  /** One line describing the purchase, shown on Paymob's page. */
  description: string;
  billing: PaymobBilling;
  /** Where Paymob sends the customer after paying (Paymob adds its own query parameters). */
  redirectionUrl: string;
};

export type PaymobCheckout = { checkoutUrl: string; paymobOrderId: string | null };

/** The fields of a "transaction processed" callback that we act on. */
export type PaymobTransaction = {
  id: string;
  paymobOrderId: string;
  reference: string | null;
  amountPiastres: number;
  currency: string;
  success: boolean;
  pending: boolean;
  refunded: boolean;
  voided: boolean;
};

export class PaymobError extends Error {}

/**
 * Keys signed in a "transaction processed" callback, in Paymob's order
 * (developers.paymob.com → Webhook callbacks and HMAC → HMAC Transaction Callback).
 */
const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

/** The string Paymob signs: the values of HMAC_FIELDS, concatenated without separators. */
export function paymobSignedString(transaction: Record<string, unknown>): string {
  return HMAC_FIELDS.map((path) => {
    const value = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), transaction);
    return value === undefined || value === null ? '' : String(value);
  }).join('');
}

/**
 * Online payments through Paymob's Intention API and hosted Unified Checkout.
 * Paymob confirms payments by calling POST /v1/webhooks/paymob, signed with
 * the account's HMAC secret.
 */
@Injectable()
export class PaymobService {
  private readonly logger = new Logger(PaymobService.name);
  private readonly settings: {
    secretKey: string;
    publicKey: string;
    hmacSecret: string;
    integrationIds: number[];
    apiUrl: string;
    checkoutUrl: string;
    notificationUrl: string;
  } | null;

  constructor(config: ConfigService<Env, true>) {
    const secretKey = config.get('PAYMOB_SECRET_KEY', { infer: true });
    const publicKey = config.get('PAYMOB_PUBLIC_KEY', { infer: true });
    const hmacSecret = config.get('PAYMOB_HMAC_SECRET', { infer: true });
    const integrationIds = config.get('PAYMOB_INTEGRATION_IDS', { infer: true });
    const apiPublicUrl = config.get('API_PUBLIC_URL', { infer: true });
    this.settings =
      secretKey && publicKey && hmacSecret && integrationIds && apiPublicUrl
        ? {
            secretKey,
            publicKey,
            hmacSecret,
            integrationIds,
            apiUrl: config.get('PAYMOB_API_URL', { infer: true }).replace(/\/+$/, ''),
            checkoutUrl: config.get('PAYMOB_CHECKOUT_URL', { infer: true }),
            notificationUrl: `${apiPublicUrl.replace(/\/+$/, '')}/v1/webhooks/paymob`,
          }
        : null;
  }

  get configured(): boolean {
    return this.settings !== null;
  }

  /** Creates a payment intention and returns Paymob's hosted checkout for it. Throws PaymobError. */
  async createCheckout(input: PaymobCheckoutInput): Promise<PaymobCheckout> {
    const settings = this.settings;
    if (!settings) throw new PaymobError('Paymob is not configured.');
    const body = {
      amount: input.amountPiastres,
      currency: 'EGP',
      payment_methods: settings.integrationIds,
      // A single line, so the items always add up to the amount.
      items: [{ name: input.description.slice(0, 50), amount: input.amountPiastres, description: input.description.slice(0, 255), quantity: 1 }],
      billing_data: {
        first_name: input.billing.firstName || 'NA',
        last_name: input.billing.lastName || 'NA',
        email: input.billing.email || 'NA',
        phone_number: input.billing.phone,
        city: input.billing.city || 'NA',
        street: input.billing.street || 'NA',
        country: 'EG',
        apartment: 'NA',
        floor: 'NA',
        building: 'NA',
        state: 'NA',
      },
      special_reference: input.reference,
      notification_url: settings.notificationUrl,
      redirection_url: input.redirectionUrl,
    };

    let response: Response;
    try {
      response = await fetch(`${settings.apiUrl}/v1/intention/`, {
        method: 'POST',
        headers: { Authorization: `Token ${settings.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PaymobError(`Paymob could not be reached: ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      // Paymob's error bodies hold no secrets; keep a short sample for support.
      this.logger.warn({ status: response.status, body: text.slice(0, 500) }, 'Paymob refused a payment intention');
      throw new PaymobError(`Paymob answered ${response.status}.`);
    }
    let intention: { client_secret?: unknown; intention_order_id?: unknown };
    try {
      intention = JSON.parse(text) as typeof intention;
    } catch {
      throw new PaymobError('Paymob answered with something other than JSON.');
    }
    if (typeof intention.client_secret !== 'string' || !intention.client_secret) throw new PaymobError('Paymob did not return a client secret.');

    const checkout = new URL(settings.checkoutUrl);
    checkout.searchParams.set('publicKey', settings.publicKey);
    checkout.searchParams.set('clientSecret', intention.client_secret);
    return {
      checkoutUrl: checkout.toString(),
      paymobOrderId: intention.intention_order_id === undefined || intention.intention_order_id === null ? null : String(intention.intention_order_id),
    };
  }

  /**
   * Checks a "transaction processed" callback against its hmac query
   * parameter and extracts what we need. Null when the signature is wrong or
   * the body is not a transaction.
   */
  readTransactionCallback(body: unknown, hmac: unknown): PaymobTransaction | null {
    if (!this.settings || typeof hmac !== 'string' || !/^[0-9a-f]{128}$/i.test(hmac)) return null;
    const transaction = (body as { obj?: unknown } | null)?.obj;
    if ((body as { type?: unknown } | null)?.type !== 'TRANSACTION' || !transaction || typeof transaction !== 'object') return null;
    const expected = createHmac('sha512', this.settings.hmacSecret).update(paymobSignedString(transaction as Record<string, unknown>)).digest();
    if (!timingSafeEqual(expected, Buffer.from(hmac, 'hex'))) return null;

    const value = transaction as Record<string, unknown> & { order?: Record<string, unknown> };
    return {
      id: String(value.id),
      paymobOrderId: String(value.order?.id ?? ''),
      reference: typeof value.order?.merchant_order_id === 'string' ? value.order.merchant_order_id : null,
      amountPiastres: Number(value.amount_cents),
      currency: String(value.currency ?? ''),
      success: value.success === true,
      pending: value.pending === true,
      refunded: value.is_refunded === true,
      voided: value.is_voided === true,
    };
  }
}
