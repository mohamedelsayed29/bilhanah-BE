import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { AuthModule } from '../auth/auth.module.js';
import { TrackingTokens } from '../orders/tracking-token.js';
import { RealtimeService } from './realtime.service.js';

/** One Socket.IO server per process, shared by the modules that emit events. */
@Module({
  imports: [AuthModule],
  providers: [
    RealtimeService,
    {
      provide: TrackingTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new TrackingTokens(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true })),
    },
  ],
  exports: [RealtimeService, TrackingTokens],
})
export class RealtimeModule {}
