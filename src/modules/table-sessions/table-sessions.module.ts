import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { tableGuestTokensProvider } from './guest-token.js';
import { PublicTableSessionsController, TableSessionsController } from './table-sessions.controller.js';
import { TableSessionsService } from './table-sessions.service.js';

@Module({
  imports: [AuthModule, OrdersModule, RealtimeModule, SubscriptionsModule],
  controllers: [PublicTableSessionsController, TableSessionsController],
  providers: [TableSessionsService, tableGuestTokensProvider],
})
export class TableSessionsModule {}
