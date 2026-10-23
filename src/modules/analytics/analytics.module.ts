import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PlatformStatsController, RestaurantStatsController, VisitsController } from './analytics.controller.js';
import { StatsService } from './stats.service.js';
import { VisitsService } from './visits.service.js';

@Module({
  imports: [AuthModule, SubscriptionsModule],
  controllers: [VisitsController, RestaurantStatsController, PlatformStatsController],
  providers: [VisitsService, StatsService],
  exports: [VisitsService],
})
export class AnalyticsModule {}
