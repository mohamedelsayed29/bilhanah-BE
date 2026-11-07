import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { LoyaltyCore } from './loyalty-core.service.js';
import { LoyaltyController, PublicLoyaltyController } from './loyalty.controller.js';
import { loyaltyPassesProvider } from './loyalty-pass.js';
import { LoyaltyService } from './loyalty.service.js';

/** Loyalty program (docs/LOYALTY.md). Orders use LoyaltyCore at checkout and on every status or payment change. */
@Module({
  imports: [AuthModule, AuditModule, SubscriptionsModule],
  controllers: [LoyaltyController, PublicLoyaltyController],
  providers: [loyaltyPassesProvider, LoyaltyCore, LoyaltyService],
  exports: [LoyaltyCore],
})
export class LoyaltyModule {}
