import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, MediaModule, SubscriptionsModule, RealtimeModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService, OrderAlertsService],
})
export class OrdersModule {}
