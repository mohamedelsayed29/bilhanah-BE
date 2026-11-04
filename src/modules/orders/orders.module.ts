import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { KitchenDisplayModule } from '../kitchen-display/kitchen-display.module.js';
import { MediaModule } from '../media/media.module.js';
import { MenusModule } from '../menus/menus.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, MediaModule, MenusModule, SubscriptionsModule, RealtimeModule, RecommendationsModule, KitchenDisplayModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService, OrderAlertsService],
})
export class OrdersModule {}
