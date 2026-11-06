import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { ReviewNotifier } from './review-notifier.service.js';
import { ReviewPhotos } from './review-photos.service.js';
import { ReviewsAccess } from './reviews-access.service.js';
import { PublicReviewsController, ReviewsController } from './reviews.controller.js';
import { ReviewsDinerService } from './reviews-diner.service.js';
import { ReviewsPublicService } from './reviews-public.service.js';
import { ReviewsReportsService } from './reviews-reports.service.js';
import { ReviewsService } from './reviews.service.js';

/** Feedback and reviews (docs/REVIEWS.md). The public menu reads dish ratings through ReviewsPublicService. */
@Module({
  imports: [AuthModule, AuditModule, SubscriptionsModule, MediaModule, RealtimeModule],
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsAccess, ReviewPhotos, ReviewNotifier, ReviewsPublicService, ReviewsDinerService, ReviewsService, ReviewsReportsService],
  exports: [ReviewsPublicService],
})
export class ReviewsModule {}
