import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';

/**
 * Member cards: "<member id>.<card version>.<signature>". Derived rather than stored (a retried
 * checkout gets the same card back) and bound to the member's card version, so issuing a new card
 * makes every older one stop working. The member is checked against the restaurant on every use.
 */
export class LoyaltyPasses {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = Buffer.from(hkdfSync('sha256', keyMaterial, 'bilhanah', 'loyalty-pass:v1', 32));
  }

  issue(memberId: string, version: number): string {
    return `${Buffer.from(memberId.replaceAll('-', ''), 'hex').toString('base64url')}.${version}.${this.sign(memberId, version)}`;
  }

  /** The member and card version, or null for anything this server did not issue. */
  verify(pass: string): { memberId: string; version: number } | null {
    const [encodedId, rawVersion, signature] = pass.split('.');
    if (!encodedId || !rawVersion || !signature || !/^\d{1,9}$/.test(rawVersion)) return null;
    const hex = Buffer.from(encodedId, 'base64url').toString('hex');
    if (hex.length !== 32) return null;
    const memberId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const version = Number(rawVersion);
    const expected = Buffer.from(this.sign(memberId, version));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? { memberId, version } : null;
  }

  private sign(memberId: string, version: number): string {
    return createHmac('sha256', this.key).update(`${memberId}:${version}`).digest().subarray(0, 18).toString('base64url');
  }
}

export const loyaltyPassesProvider: FactoryProvider<LoyaltyPasses> = {
  provide: LoyaltyPasses,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new LoyaltyPasses(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true })),
};
