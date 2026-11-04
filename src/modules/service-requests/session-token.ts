import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { TrackingTokens } from '../orders/tracking-token.js';

/**
 * Table session tokens: what a diner's phone holds while seated, to send service requests and
 * follow them. Same signed scheme as order tracking links, under a key of their own.
 */
export const TABLE_SESSION_TOKENS = Symbol('TABLE_SESSION_TOKENS');

export const tableSessionTokensProvider: FactoryProvider<TrackingTokens> = {
  provide: TABLE_SESSION_TOKENS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new TrackingTokens(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true }), 'table-session:v1'),
};
