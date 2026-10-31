import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { KitchenAccountsController, KitchenController } from './kitchen.controller.js';
import { KitchenService } from './kitchen.service.js';

@Module({
  imports: [AuthModule, SubscriptionsModule],
  controllers: [KitchenAccountsController, KitchenController],
  providers: [KitchenService],
})
export class KitchenModule {}
