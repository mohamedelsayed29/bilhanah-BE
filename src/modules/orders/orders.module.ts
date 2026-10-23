import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { TrackingTokens } from './tracking-token.js';

@Module({
  imports: [AuthModule, MediaModule, SubscriptionsModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [
    OrdersService,
    RealtimeService,
    {
      provide: TrackingTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new TrackingTokens(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true })),
    },
  ],
})
export class OrdersModule {}
