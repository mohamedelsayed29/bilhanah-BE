// A stand-in for Paymob on this computer, for trying online payments without
// a Paymob account. It answers the Intention API, shows a checkout page with
// "Pay" and "Decline", then sends the API a correctly signed callback and the
// customer back, the way Paymob does. Never use it in production.
//
//   npm run paymob:sandbox   (npm run dev starts it when .env points Paymob at it)
//
// .env for the sandbox:
//   API_PUBLIC_URL=http://127.0.0.1:3000
//   PAYMOB_API_URL=http://127.0.0.1:4010
//   PAYMOB_CHECKOUT_URL=http://127.0.0.1:4010/checkout
//   PAYMOB_SECRET_KEY=sandbox-secret-key
//   PAYMOB_PUBLIC_KEY=sandbox-public-key
//   PAYMOB_HMAC_SECRET=sandbox-hmac-secret
//   PAYMOB_INTEGRATION_IDS=1
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../.env'));
} catch {
  // Variables may come from the environment instead.
}

const PORT = Number(process.env.PAYMOB_SANDBOX_PORT ?? 4010);
const SECRET_KEY = process.env.PAYMOB_SECRET_KEY;
const HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;
if (!SECRET_KEY || !HMAC_SECRET) {
  console.error('Set PAYMOB_SECRET_KEY and PAYMOB_HMAC_SECRET in .env (see the top of this file).');
  process.exit(1);
}

/** The fields Paymob signs, in its order (as in src/infrastructure/paymob/paymob.service.ts). */
const HMAC_FIELDS = ['amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success'];
const signed = (transaction) =>
  HMAC_FIELDS.map((path) => {
    const value = path.split('.').reduce((node, key) => node?.[key], transaction);
    return value === undefined || value === null ? '' : String(value);
  }).join('');

/** client_secret → the intention the API created. */
const intentions = new Map();
let nextId = 1;

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const readBody = (request) =>
  new Promise((done) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => done(data));
  });

function page(intention, secret) {
  const amount = (intention.amount / 100).toLocaleString('en-EG', { maximumFractionDigits: 2 });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paymob sandbox</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;padding:28px;border-radius:16px;max-width:380px;width:calc(100% - 32px);box-shadow:0 8px 30px #0001}
h1{font-size:18px;margin:0 0 4px}p{color:#555;margin:6px 0}.amount{font-size:30px;font-weight:700;color:#111;margin:18px 0}button{width:100%;padding:14px;border:0;border-radius:10px;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}
.pay{background:#0a7d4f;color:#fff}.decline{background:#eee;color:#900}.note{font-size:12px;color:#888;margin-top:18px}</style></head>
<body><main><h1>Paymob sandbox</h1><p>${escape(intention.items?.[0]?.name ?? 'Payment')}</p><div class="amount">${amount} EGP</div>
<p>${escape(intention.billing_data?.first_name ?? '')} ${escape(intention.billing_data?.last_name ?? '')} · ${escape(intention.billing_data?.phone_number ?? '')}</p>
<form method="post" action="/checkout/${secret}/pay"><button class="pay" name="result" value="success">Pay (test card ending 2346)</button><button class="decline" name="result" value="decline">Decline</button></form>
<p class="note">Local test checkout. No money moves. Reference ${escape(intention.special_reference)}</p></main></body></html>`;
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === 'POST' && url.pathname === '/v1/intention/') {
      if (request.headers.authorization !== `Token ${SECRET_KEY}`) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"detail":"Invalid token"}');
        return;
      }
      const body = JSON.parse(await readBody(request));
      const secret = `sandbox_csk_${randomBytes(12).toString('hex')}`;
      const orderId = 700_000 + nextId++;
      intentions.set(secret, { ...body, orderId });
      console.log(`[paymob-sandbox] intention ${body.special_reference} for ${body.amount / 100} EGP`);
      response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `pi_sandbox_${orderId}`, client_secret: secret, intention_order_id: orderId, status: 'intended' }));
      return;
    }

    if (request.method === 'GET' && url.pathname.replace(/\/$/, '') === '/checkout') {
      const secret = url.searchParams.get('clientSecret') ?? '';
      const intention = intentions.get(secret);
      response.writeHead(intention ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }).end(intention ? page(intention, secret) : 'Unknown checkout (the sandbox forgets checkouts when it restarts).');
      return;
    }

    const pay = /^\/checkout\/([\w-]+)\/pay$/.exec(url.pathname);
    if (request.method === 'POST' && pay) {
      const intention = intentions.get(pay[1]);
      if (!intention) {
        response.writeHead(404).end('Unknown checkout');
        return;
      }
      const success = new URLSearchParams(await readBody(request)).get('result') === 'success';
      const transaction = {
        id: 800_000 + nextId++,
        pending: false,
        amount_cents: intention.amount,
        success,
        is_auth: false,
        is_capture: false,
        is_standalone_payment: true,
        is_voided: false,
        is_refunded: false,
        is_3d_secure: true,
        integration_id: intention.payment_methods?.[0] ?? 1,
        has_parent_transaction: false,
        order: { id: intention.orderId, merchant_order_id: intention.special_reference },
        created_at: new Date().toISOString().replace('Z', ''),
        currency: intention.currency,
        error_occured: false,
        owner: 1,
        source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
      };
      const hmac = createHmac('sha512', HMAC_SECRET).update(signed(transaction)).digest('hex');
      const callback = await fetch(`${intention.notification_url}?hmac=${hmac}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'TRANSACTION', obj: transaction }),
      }).catch((error) => ({ status: `failed: ${error.message}` }));
      console.log(`[paymob-sandbox] ${success ? 'paid' : 'declined'} ${intention.special_reference}; callback answered ${callback.status}`);
      // Paymob sends the customer back with the result in the query string.
      const back = new URL(intention.redirection_url);
      back.searchParams.set('success', String(success));
      back.searchParams.set('id', String(transaction.id));
      response.writeHead(303, { Location: back.toString() }).end();
      return;
    }

    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(error));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[paymob-sandbox] listening on http://127.0.0.1:${PORT}`));
