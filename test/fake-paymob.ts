import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { paymobSignedString } from '../src/infrastructure/paymob/paymob.service.js';

/** Matches PAYMOB_API_URL and PAYMOB_HMAC_SECRET in vitest.config.e2e.ts. */
const PORT = 59123;
const HMAC_SECRET = 'e2e-paymob-hmac-secret';

export type IntentionRequest = { authorization: string | undefined; body: Record<string, any> };

/** Paymob's Intention API, as far as the API uses it. */
export type FakePaymob = {
  intentions: IntentionRequest[];
  /** Answer the next intentions with HTTP 500. */
  failing: boolean;
  close: () => Promise<void>;
};

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => resolve(data));
  });

export async function startFakePaymob(): Promise<FakePaymob> {
  const fake: FakePaymob = { intentions: [], failing: false, close: async () => undefined };
  const server = createServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)) || '{}') as Record<string, any>;
    if (request.method !== 'POST' || request.url !== '/v1/intention/') {
      response.writeHead(404).end();
      return;
    }
    fake.intentions.push({ authorization: request.headers.authorization, body });
    if (fake.failing) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"detail":"boom"}');
      return;
    }
    const n = fake.intentions.length;
    response
      .writeHead(201, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ id: `pi_test_${n}`, client_secret: `egy_csk_test_${n}`, intention_order_id: 900_000 + n, status: 'intended' }));
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

let transactionId = 500_000;

/** A "transaction processed" callback for a checkout, signed like Paymob signs it. */
export function paymobCallback(
  reference: string,
  amountCents: number,
  overrides: { success?: boolean; pending?: boolean; is_refunded?: boolean; currency?: string; id?: number } = {},
) {
  const { success = true, pending = false, is_refunded = false, currency = 'EGP', id = ++transactionId } = overrides;
  const obj = {
    id,
    pending,
    amount_cents: amountCents,
    success,
    is_auth: false,
    is_capture: false,
    is_standalone_payment: true,
    is_voided: false,
    is_refunded,
    is_3d_secure: true,
    integration_id: 111,
    has_parent_transaction: false,
    order: { id: 900_001, merchant_order_id: reference },
    created_at: '2026-10-23T12:00:00.000000',
    currency,
    error_occured: false,
    owner: 302852,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
  };
  const hmac = createHmac('sha512', HMAC_SECRET).update(paymobSignedString(obj)).digest('hex');
  return { body: { type: 'TRANSACTION', obj }, hmac };
}
