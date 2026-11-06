import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MediaService, mediaNotFound } from '../media/media.service.js';
import { photosPublic, type ReviewRules } from './reviews-rules.js';

/**
 * Review photos go through the media pipeline (kind REVIEW, re-encoded, metadata stripped) and are
 * stored under private/ until their review is published; they go private again when it is hidden,
 * when the diner removes them, or while publishing is NEVER.
 */
@Injectable()
export class ReviewPhotos {
  private readonly logger = new Logger(ReviewPhotos.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  /** Moves the review's photos to where its status says they belong. Never fails the request. */
  async sync(reviewId: string, rules: Pick<ReviewRules, 'publishMode'>): Promise<void> {
    try {
      const review = await this.prisma.review.findUnique({ where: { id: reviewId }, select: { status: true, photos: { select: { mediaId: true } } } });
      if (!review?.photos.length) return;
      await this.media.setReviewPhotosPublic(review.photos.map((photo) => photo.mediaId), photosPublic(review.status, rules));
    } catch (error) {
      this.logger.warn({ err: error, reviewId }, 'Could not move review photos');
    }
  }

  /** Every published review's photos of the restaurant, after publishing was switched to or from NEVER. */
  async syncRestaurant(restaurantId: string, rules: Pick<ReviewRules, 'publishMode'>): Promise<void> {
    const reviews = await this.prisma.review.findMany({ where: { restaurantId, status: 'PUBLISHED', photos: { some: {} } }, select: { id: true } });
    for (const review of reviews) await this.sync(review.id, rules);
  }

  async makePrivate(mediaIds: string[]): Promise<void> {
    try {
      await this.media.setReviewPhotosPublic(mediaIds, false);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not make review photos private');
    }
  }

  /** The largest rendition of a review photo of the restaurant (WebP). */
  async read(restaurantId: string, mediaId: string): Promise<Buffer> {
    const photo = await this.prisma.media.findFirst({ where: { id: mediaId, restaurantId, kind: 'REVIEW' } });
    const image = photo ? await this.media.readImage(photo) : null;
    if (!image) throw mediaNotFound();
    return image;
  }
}
