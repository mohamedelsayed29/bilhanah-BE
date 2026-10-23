import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { PushService } from './push.service.js';

function service(keys: Partial<Env>): PushService {
  const values: Partial<Env> = { VAPID_SUBJECT: 'mailto:ops@bilhanah.test', ...keys };
  return new PushService({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>);
}

function keyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

/** Decrypts an aes128gcm Web Push body as a browser would (RFC 8291 and RFC 8188), independently of the web-push library. */
function decrypt(body: Buffer, browser: ReturnType<typeof keyPair>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const serverKey = body.subarray(21, 21 + idLength);
  const cipherText = body.subarray(21 + idLength);
  const sharedSecret = browser.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipherText.subarray(-16));
  const padded = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
  // The last record ends with a 0x02 delimiter, then zero padding.
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
}

describe('PushService', () => {
  it('is off without keys', async () => {
    const push = service({});
    expect(push.publicKey).toBeNull();
    const browser = keyPair();
    const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: browser.publicKey, auth: randomBytes(16).toString('base64url') };
    await expect(push.send(target, '{}', { topic: 't', ttlSeconds: 60 })).rejects.toThrow('not configured');
  });

  it('encrypts for the browser and signs with our VAPID key', () => {
    const vapid = keyPair();
    const push = service({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
    expect(push.publicKey).toBe(vapid.publicKey);

    const browser = keyPair();
    const authSecret = randomBytes(16);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    const payload = JSON.stringify({ title: 'Koshary Abou Tarek', body: 'طلبك رقم ١٢ جاهز' });
    const request = push.requestDetails(
      { endpoint, p256dh: browser.publicKey, auth: authSecret.toString('base64url') },
      payload,
      { topic: 'a1b2c3', ttlSeconds: 3600 },
    );

    expect(request.method).toBe('POST');
    expect(request.endpoint).toBe(endpoint);
    expect(request.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: 3600, Urgency: 'high', Topic: 'a1b2c3' });
    expect(decrypt(request.body as Buffer, browser, authSecret)).toBe(payload);

    // Authorization: vapid t=<ES256 JWT>, k=<our public key>
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(String(request.headers['Authorization']));
    expect(match?.[2]).toBe(vapid.publicKey);
    const [header, claims, signature] = match![1]!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const { aud, sub, exp } = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { aud: string; sub: string; exp: number };
    expect(aud).toBe('https://fcm.googleapis.com');
    expect(sub).toBe('mailto:ops@bilhanah.test');
    expect(exp * 1000).toBeGreaterThan(Date.now());
    expect(exp * 1000).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    const point = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
  });
});
