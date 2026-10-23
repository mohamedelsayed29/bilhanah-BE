import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ShopModule } from '../shop/shop.module.js';
import { PaymobWebhookController } from './paymob-webhook.controller.js';

@Module({
  imports: [BillingModule, ShopModule],
  controllers: [PaymobWebhookController],
})
export class PaymentsModule {}
