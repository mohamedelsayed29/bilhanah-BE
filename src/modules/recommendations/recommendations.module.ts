import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PublicRecommendationEventsController, RecommendationsController } from './recommendations.controller.js';
import { RecommendationsService } from './recommendations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [RecommendationsController, PublicRecommendationEventsController],
  providers: [RecommendationsService],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}
