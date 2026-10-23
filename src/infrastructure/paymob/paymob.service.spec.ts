import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { paymobSignedString, PaymobService } from './paymob.service.js';

/** The sample transaction from Paymob's "HMAC Transaction Callback" page. */
const sample = {
  amount_cents: 100000,
  created_at: '2024-06-13T11:33:44.592345',
  currency: 'EGP',
  error_occured: false,
  has_parent_transaction: false,
  id: 192036465,
  integration_id: 4097558,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 217503754, merchant_order_id: 'sub-0b6f2c1e-7d1a-4a57-9a8e-3f1c2d4e5a6b-a1b2' },
  owner: 302852,
  pending: false,
  source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
  success: true,
};

const SECRET = 'test-hmac-secret-0123456789';

function service(values: Partial<Env> = {}): PaymobService {
  const all: Partial<Env> = {
    PAYMOB_SECRET_KEY: 'egy_sk_test_0123456789',
    PAYMOB_PUBLIC_KEY: 'egy_pk_test_0123456789',
    PAYMOB_HMAC_SECRET: SECRET,
    PAYMOB_INTEGRATION_IDS: [123, 456],
    API_PUBLIC_URL: 'https://api.bilhanah.test',
    PAYMOB_API_URL: 'https://accept.paymob.com',
    PAYMOB_CHECKOUT_URL: 'https://eg.checkout.paymob.com/',
    ...values,
  };
  return new PaymobService({ get: (key: keyof Env) => all[key] } as unknown as ConfigService<Env, true>);
}

const sign = (transaction: object) => createHmac('sha512', SECRET).update(paymobSignedString(transaction as Record<string, unknown>)).digest('hex');

describe('Paymob callbacks', () => {
  it('signs the same string as Paymob’s documented example', () => {
    expect(paymobSignedString(sample)).toBe(
      '1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse' + '217503754302852false2346MasterCardcardtrue',
    );
  });

  it('accepts a correctly signed transaction and reads what we need', () => {
    expect(service().readTransactionCallback({ type: 'TRANSACTION', obj: sample }, sign(sample))).toEqual({
      id: '192036465',
      paymobOrderId: '217503754',
      reference: 'sub-0b6f2c1e-7d1a-4a57-9a8e-3f1c2d4e5a6b-a1b2',
      amountPiastres: 100000,
      currency: 'EGP',
      success: true,
      pending: false,
      refunded: false,
      voided: false,
    });
  });

  it('refuses tampered, unsigned or foreign callbacks', () => {
    const paymob = service();
    const hmac = sign(sample);
    expect(paymob.readTransactionCallback({ type: 'TRANSACTION', obj: { ...sample, amount_cents: 100 } }, hmac)).toBeNull();
    expect(paymob.readTransactionCallback({ type: 'TRANSACTION', obj: { ...sample, success: false } }, hmac)).toBeNull();
    expect(paymob.readTransactionCallback({ type: 'TRANSACTION', obj: sample }, undefined)).toBeNull();
    expect(paymob.readTransactionCallback({ type: 'TRANSACTION', obj: sample }, 'abc')).toBeNull();
    expect(paymob.readTransactionCallback({ type: 'TOKEN', obj: sample }, hmac)).toBeNull();
    expect(paymob.readTransactionCallback(null, hmac)).toBeNull();
    // Signed with another account's secret.
    const foreign = createHmac('sha512', 'another-secret-0123456789').update(paymobSignedString(sample)).digest('hex');
    expect(paymob.readTransactionCallback({ type: 'TRANSACTION', obj: sample }, foreign)).toBeNull();
    // Not configured: nothing is trusted.
    expect(service({ PAYMOB_HMAC_SECRET: undefined }).readTransactionCallback({ type: 'TRANSACTION', obj: sample }, hmac)).toBeNull();
  });
});
