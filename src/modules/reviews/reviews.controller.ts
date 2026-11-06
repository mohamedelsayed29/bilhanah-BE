import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type DinerReviewResult,
  dinerReviewSchema,
  type DinerReviewState,
  type FeedbackResult,
  feedbackSchema,
  hideReviewSchema,
  MEDIA_MAX_BYTES,
  type OwnerReview,
  type OwnerReviewListItem,
  type Paginated,
  type PublicReviewsPage,
  publicReviewsQuerySchema,
  type ReviewAssignee,
  reviewAssigneesQuerySchema,
  type ReviewDishReport,
  reviewFollowUpSchema,
  type ReviewPhotoUpload,
  reviewReplySchema,
  reviewsExportQuerySchema,
  type ReviewSettings,
  reviewSettingsSchema,
  reviewsQuerySchema,
  type ReviewStats,
  reviewStatsQuerySchema,
} from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { mediaNotFound } from '../media/media.service.js';
import { ReviewsDinerService } from './reviews-diner.service.js';
import { ReviewsPublicService } from './reviews-public.service.js';
import { ReviewsReportsService } from './reviews-reports.service.js';
import { ReviewsService } from './reviews.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'reviews-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** Review photos are private until published: streamed, never cached. */
function sendPhoto(response: Response, image: Buffer): StreamableFile {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Disposition', 'inline; filename="review-photo.webp"');
  // Shown from other origins (the restaurant's subdomain, the dashboard); access is already
  // limited by the order's tracking token or the staff session.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return new StreamableFile(image, { type: 'image/webp' });
}

/**
 * The restaurant's reviews (docs/REVIEWS.md). reviews.view reads the inbox, stats and export;
 * reviews.respond replies and follows up (and sees contact phones); reviews.moderate publishes and
 * hides; reviews.settings changes the settings. The plan must include reviews (409
 * REVIEWS_UNAVAILABLE otherwise); the services check branch scope.
 */
@Controller('reviews')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('reviews.view', 'reviews.settings')
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly reports: ReviewsReportsService,
  ) {}

  @Get()
  @RequirePermission('reviews.view')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(reviewsQuerySchema)) query: z.output<typeof reviewsQuerySchema>): Promise<Paginated<OwnerReviewListItem>> {
    return this.reviews.list(auth.userId, query);
  }

  // Fixed paths before :id.

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(@CurrentAuth() auth: AuthContext): Promise<ReviewSettings> {
    return this.reviews.getSettings(auth.userId);
  }

  @Put('settings')
  @RequirePermission('reviews.settings')
  @RateLimit(WRITE_LIMIT)
  updateSettings(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(reviewSettingsSchema)) body: z.output<typeof reviewSettingsSchema>): Promise<ReviewSettings> {
    return this.reviews.updateSettings(auth.userId, body, request.ip);
  }

  @Get('stats')
  @RequirePermission('reviews.view')
  @Header('Cache-Control', 'no-store')
  stats(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(reviewStatsQuerySchema)) query: z.output<typeof reviewStatsQuerySchema>): Promise<ReviewStats> {
    return this.reports.stats(auth.userId, query);
  }

  @Get('dishes')
  @RequirePermission('reviews.view')
  @Header('Cache-Control', 'no-store')
  dishes(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(reviewStatsQuerySchema)) query: z.output<typeof reviewStatsQuerySchema>): Promise<ReviewDishReport> {
    return this.reports.dishes(auth.userId, query);
  }

  /** CSV of the inbox filters (contact phones only for callers holding reviews.respond). */
  @Get('export')
  @RequirePermission('reviews.view')
  @RateLimit({ name: 'reviews-export:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  async export(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(reviewsExportQuerySchema)) query: z.output<typeof reviewsExportQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { filename, csv } = await this.reports.export(auth.userId, query);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return csv;
  }

  @Get('assignees')
  @RequirePermission('reviews.respond')
  @Header('Cache-Control', 'no-store')
  assignees(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(reviewAssigneesQuerySchema)) query: z.output<typeof reviewAssigneesQuerySchema>): Promise<ReviewAssignee[]> {
    return this.reviews.assignees(auth.userId, query.branchId);
  }

  @Get(':id')
  @RequirePermission('reviews.view')
  @Header('Cache-Control', 'no-store')
  get(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<OwnerReview> {
    return this.reviews.get(auth.userId, id);
  }

  @Get(':id/photos/:mediaId')
  @RequirePermission('reviews.view')
  async photo(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('mediaId', idParam) mediaId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return sendPhoto(response, await this.reviews.photo(auth.userId, id, mediaId));
  }

  @Put(':id/reply')
  @RequirePermission('reviews.respond')
  @RateLimit(WRITE_LIMIT)
  reply(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewReplySchema)) body: z.output<typeof reviewReplySchema>): Promise<OwnerReview> {
    return this.reviews.reply(auth.userId, id, body.text);
  }

  @Delete(':id/reply')
  @RequirePermission('reviews.respond')
  @RateLimit(WRITE_LIMIT)
  removeReply(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<OwnerReview> {
    return this.reviews.removeReply(auth.userId, id);
  }

  @Post(':id/publish')
  @RequirePermission('reviews.moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  publish(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<OwnerReview> {
    return this.reviews.publish(auth.userId, id, request.ip);
  }

  @Post(':id/hide')
  @RequirePermission('reviews.moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  hide(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(hideReviewSchema)) body: z.output<typeof hideReviewSchema>): Promise<OwnerReview> {
    return this.reviews.hide(auth.userId, id, body, request.ip);
  }

  @Patch(':id/follow-up')
  @RequirePermission('reviews.respond')
  @RateLimit(WRITE_LIMIT)
  followUp(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewFollowUpSchema)) body: z.output<typeof reviewFollowUpSchema>): Promise<OwnerReview> {
    return this.reviews.followUp(auth.userId, id, body);
  }
}

/**
 * Diners: the review of an order (proven by its tracking token), its photos, the restaurant's
 * public reviews, and unverified feedback. No account; contact phones never come back.
 */
@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicReviewsController {
  constructor(
    private readonly diners: ReviewsDinerService,
    private readonly publicReviews: ReviewsPublicService,
  ) {}

  @Get('orders/:token/review')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'review-state:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  state(@Param('token') token: string): Promise<DinerReviewState> {
    return this.diners.state(token);
  }

  @Put('orders/:token/review')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'review-submit:ip', limit: 60, windowSeconds: 10 * 60, by: 'ip' })
  submit(@Param('token') token: string, @Body(new ZodValidationPipe(dinerReviewSchema)) body: z.output<typeof dinerReviewSchema>): Promise<DinerReviewResult> {
    return this.diners.submit(token, body);
  }

  /** multipart/form-data with one `file` field (JPEG, PNG or WebP, up to 5 MB). Larger files get 413. */
  @Post('orders/:token/review/photos')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'review-photo:ip', limit: 30, windowSeconds: 60 * 60, by: 'ip' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 0 } }))
  uploadPhoto(@Param('token') token: string, @UploadedFile() file: { buffer: Buffer } | undefined): Promise<ReviewPhotoUpload> {
    return this.diners.uploadPhoto(token, file?.buffer);
  }

  @Get('orders/:token/review/photos/:mediaId')
  @RateLimit({ name: 'review-photo-read:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  async photo(@Param('token') token: string, @Param('mediaId') mediaId: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    if (!z.uuid().safeParse(mediaId).success) throw mediaNotFound();
    return sendPhoto(response, await this.diners.photo(token, mediaId));
  }

  @Get('restaurants/:subdomain/reviews')
  @Header('Cache-Control', 'public, max-age=60')
  @RateLimit({ name: 'public-reviews:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  reviews(@Param('subdomain') subdomain: string, @Query(new ZodValidationPipe(publicReviewsQuerySchema)) query: z.output<typeof publicReviewsQuerySchema>): Promise<PublicReviewsPage> {
    return this.publicReviews.page(subdomain, query);
  }

  /** Unverified feedback (when the restaurant allows it): REVIEW_LIMITS.feedbackPerDay per IP, per restaurant, per day. */
  @Post('restaurants/:subdomain/feedback')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'review-feedback:ip', limit: 30, windowSeconds: 10 * 60, by: 'ip' })
  feedback(@Param('subdomain') subdomain: string, @Req() request: Request, @Body(new ZodValidationPipe(feedbackSchema)) body: z.output<typeof feedbackSchema>): Promise<FeedbackResult> {
    return this.diners.feedback(subdomain, body, request.ip ?? 'unknown');
  }
}
