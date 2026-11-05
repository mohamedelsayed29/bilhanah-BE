import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CashModule } from '../cash/cash.module.js';
import { KitchenDisplayModule } from '../kitchen-display/kitchen-display.module.js';
import { MediaModule } from '../media/media.module.js';
import { MenusModule } from '../menus/menus.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { OrdersController, PublicOrdersController, TableGroupsController } from './orders.controller.js';
import { TableGroupsService } from './table-groups.service.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, MediaModule, MenusModule, SubscriptionsModule, RealtimeModule, RecommendationsModule, KitchenDisplayModule, CashModule],
  controllers: [OrdersController, PublicOrdersController, TableGroupsController],
  providers: [OrdersService, OrderAlertsService, TableGroupsService],
  exports: [OrdersService],
})
export class OrdersModule {}
