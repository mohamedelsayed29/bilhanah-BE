import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TrackingTokens, trackingTokensProvider } from '../orders/tracking-token.js';
import { TABLE_SESSION_TOKENS, tableSessionTokensProvider } from '../service-requests/session-token.js';
import { RealtimeService } from './realtime.service.js';

/** One Socket.IO server per process, shared by the modules that emit events. */
@Module({
  imports: [AuthModule],
  providers: [RealtimeService, trackingTokensProvider, tableSessionTokensProvider],
  exports: [RealtimeService, TrackingTokens, TABLE_SESSION_TOKENS],
})
export class RealtimeModule {}
