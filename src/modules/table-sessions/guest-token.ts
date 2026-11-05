import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { TrackingTokens } from '../orders/tracking-token.js';

/** Guest tokens: one phone's place in a shared table session (signed guest id, a key of its own). */
export const TABLE_GUEST_TOKENS = Symbol('TABLE_GUEST_TOKENS');

export const tableGuestTokensProvider: FactoryProvider<TrackingTokens> = {
  provide: TABLE_GUEST_TOKENS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new TrackingTokens(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true }), 'table-guest:v1'),
};
