import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';

/**
 * Order tracking links: "<order id>.<signature>". Derived rather than stored,
 * so a retried checkout gets the same link back, and links cannot be forged
 * or guessed from an order id.
 */
export class TrackingTokens {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = Buffer.from(hkdfSync('sha256', keyMaterial, 'bilhanah', 'order-tracking:v1', 32));
  }

  issue(orderId: string): string {
    return `${Buffer.from(orderId.replaceAll('-', ''), 'hex').toString('base64url')}.${this.sign(orderId)}`;
  }

  /** The order id, or null for anything not issued by this server. */
  verify(token: string): string | null {
    const [encodedId, signature] = token.split('.');
    if (!encodedId || !signature) return null;
    const hex = Buffer.from(encodedId, 'base64url').toString('hex');
    if (hex.length !== 32) return null;
    const orderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const expected = Buffer.from(this.sign(orderId));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? orderId : null;
  }

  private sign(orderId: string): string {
    // 144 bits of HMAC-SHA256.
    return createHmac('sha256', this.key).update(orderId).digest().subarray(0, 18).toString('base64url');
  }
}

/** The API (tracking pages) and the worker (links in notifications) sign with the same key. */
export const trackingTokensProvider: FactoryProvider<TrackingTokens> = {
  provide: TrackingTokens,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new TrackingTokens(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true })),
};
