import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BRANCH_ERROR_CODES,
  COMMON_ERROR_CODES,
  type DinerReviewResult,
  type dinerReviewSchema,
  type DinerReviewState,
  DISH_THUMBS,
  type FeedbackResult,
  type feedbackSchema,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  RESTAURANT_ERROR_CODES,
  REVIEW_ERROR_CODES as CODES,
  REVIEW_LIMITS,
  type ReviewForm,
  type ReviewPhotoUpload,
  type ReviewStatus,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import { MediaService, mediaNotFound } from '../media/media.service.js';
import { TrackingTokens } from '../orders/tracking-token.js';
import { ReviewNotifier } from './review-notifier.service.js';
import { dinerReviewInclude, toDinerReview } from './review-views.js';
import { fail, ReviewsAccess } from './reviews-access.service.js';
import { ReviewsPublicService } from './reviews-public.service.js';
import { ReviewPhotos } from './review-photos.service.js';
import { commentRequired, isLowRating, outcomeFor, publishDecision, ratingColumns, ratingsOf, reviewEligibility, type ReviewRules } from './reviews-rules.js';

type DinerBody = z.output<typeof dinerReviewSchema>;
type FeedbackBody = z.output<typeof feedbackSchema>;

const orderInclude = {
  items: { orderBy: { sortOrder: 'asc' }, select: { id: true, menuItemId: true, nameAr: true, nameEn: true, variantNameAr: true, variantNameEn: true, quantity: true } },
  branch: { select: { id: true, name: true, slug: true, googleReviewUrl: true } },
  restaurant: { select: { id: true, name: true, subdomain: true, status: true } },
  review: { include: dinerReviewInclude },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
type ExistingReview = NonNullable<OrderRow['review']>;

const orderNotFound = () => fail('notFound', ORDER_ERROR_CODES.ORDER_NOT_FOUND, 'Order not found.');
const uploadsKey = (orderId: string) => `reviews:uploads:${orderId}`;
const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Diners' side of reviews: the tracking page's review (proven by the order's tracking token, one
 * per order, editable within the window from the browser that wrote it), its photos, and
 * unverified feedback from a table QR or the menu (when the owner allows it, rate-limited).
 */
@Injectable()
export class ReviewsDinerService {
  private readonly logger = new Logger(ReviewsDinerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReviewsAccess,
    private readonly trackingTokens: TrackingTokens,
    private readonly media: MediaService,
    private readonly photos: ReviewPhotos,
    private readonly notifier: ReviewNotifier,
    private readonly publicReviews: ReviewsPublicService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async state(token: string, now = new Date()): Promise<DinerReviewState> {
    const order = await this.orderFor(token);
    const { rules, eligibility } = await this.eligibility(order, now);
    const open = eligibility === 'OPEN' || eligibility === 'EDITABLE';
    return {
      eligibility,
      form: open ? this.form(order, rules) : null,
      review: order.review ? toDinerReview(order.review) : null,
      editableUntil: order.review ? order.review.editableUntil.toISOString() : null,
      outcome: order.review ? outcomeFor(order.review.status, order.review.overall, rules, order.branch.googleReviewUrl) : null,
    };
  }

  /** Creates the order's review or, within the edit window and from the same browser, edits it. */
  async submit(token: string, body: DinerBody, now = new Date()): Promise<DinerReviewResult> {
    for (let attempt = 0; ; attempt++) {
      const order = await this.orderFor(token);
      try {
        return await this.write(order, body, now);
      } catch (error) {
        // Two first submissions at once: the second becomes an edit of the first.
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  /** A private photo for this order's review (sent in photoIds afterwards). */
  async uploadPhoto(token: string, file: Buffer | undefined, now = new Date()): Promise<ReviewPhotoUpload> {
    const order = await this.orderFor(token);
    const { rules, eligibility } = await this.eligibility(order, now);
    this.assertOpen(eligibility);
    if (!rules.photos) throw fail('bad', CODES.PHOTOS_OFF, 'This restaurant does not take photos with reviews.');
    const key = uploadsKey(order.id);
    if ((await this.redis.scard(key)) >= REVIEW_LIMITS.photoUploadsPerOrder) {
      throw fail('conflict', CODES.PHOTO_LIMIT, 'Too many photos for this order.', { limit: REVIEW_LIMITS.photoUploadsPerOrder });
    }
    const media = await this.media.store(order.restaurantId, 'REVIEW', file);
    // Unattached uploads are purged after a day (MediaService.purgeUnused); so is this list.
    await this.redis.multi().sadd(key, media.id).expire(key, 24 * 60 * 60).exec();
    return { id: media.id, width: media.width, height: media.height };
  }

  /** A photo of this order's review (or uploaded for it), for the diner's own form. */
  async photo(token: string, mediaId: string): Promise<Buffer> {
    const order = await this.orderFor(token);
    const attached = order.review?.photos.some((photo) => photo.mediaId === mediaId) ?? false;
    if (!attached && !(await this.redis.sismember(uploadsKey(order.id), mediaId))) throw mediaNotFound();
    return this.photos.read(order.restaurantId, mediaId);
  }

  /** Unverified feedback from a table QR or the menu. A filled honeypot gets the same answer, and nothing is kept. */
  async feedback(rawSubdomain: string, body: FeedbackBody, ip: string, now = new Date()): Promise<FeedbackResult> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain: normalizeSubdomain(rawSubdomain) }, select: { id: true, status: true } });
    if (!restaurant) throw fail('notFound', RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, 'Restaurant not found.');
    const [planIncludes, rules] = await Promise.all([this.access.planIncludes(restaurant), this.access.rules(restaurant.id)]);
    if (!planIncludes || !rules.enabled || !rules.allowUnverified) {
      throw fail('conflict', CODES.FEEDBACK_UNAVAILABLE, 'This restaurant does not take feedback here.');
    }
    if (body.website) return { outcome: { status: 'PENDING', google: null } };

    let table: { label: string; branchId: string } | null = null;
    if (body.tableCode) {
      table = await this.prisma.table.findFirst({ where: { publicCode: body.tableCode, restaurantId: restaurant.id, isActive: true }, select: { label: true, branchId: true } });
      if (!table) throw fail('notFound', ORDER_ERROR_CODES.TABLE_NOT_FOUND, 'This table was not found. Scan the QR code again.');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { restaurantId: restaurant.id, isActive: true, ...(table ? { id: table.branchId } : body.branch ? { slug: body.branch } : { isMain: true }) },
      select: { id: true, googleReviewUrl: true },
    });
    if (!branch) throw fail('notFound', BRANCH_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found.');
    const fields = this.validate(body, rules);
    await this.countFeedback(restaurant.id, ip);

    const status = publishDecision(rules, body.overall);
    const low = isLowRating(body.overall, rules.alertBelowStars);
    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          restaurantId: restaurant.id,
          branchId: branch.id,
          source: table ? 'TABLE' : 'MENU',
          verified: false,
          tableLabel: table?.label ?? null,
          ...fields,
          // Unverified feedback has no link to come back with: it cannot be edited.
          editableUntil: now,
          status,
          publishedAt: status === 'PUBLISHED' ? now : null,
          ...(low && { followUpStatus: 'OPEN' as const, followUpUpdatedAt: now }),
          createdAt: now,
        },
      });
      await tx.reviewEvent.create({ data: { reviewId: created.id, kind: 'CREATED', createdAt: now } });
      return created;
    });
    await this.after(review.id, rules, 'created', status === 'PUBLISHED');
    return { outcome: outcomeFor(status, review.overall, rules, branch.googleReviewUrl) };
  }

  // --- Helpers -------------------------------------------------------------------------------------

  private async write(order: OrderRow, body: DinerBody, now: Date): Promise<DinerReviewResult> {
    const { rules, eligibility } = await this.eligibility(order, now);
    this.assertOpen(eligibility);
    const existing = order.review;
    if (existing?.editKeyHash && (!body.editKey || hashKey(body.editKey) !== existing.editKeyHash)) {
      throw fail('forbidden', CODES.EDIT_FORBIDDEN, 'This review was written on another device.');
    }
    const fields = this.validate(body, rules);
    // Diners never see their stored phone again, so an edit that leaves it out (while still
    // consenting) keeps it; sending an empty value or withdrawing consent removes it.
    if (existing && body.contactPhone === undefined && body.contactConsent && existing.contactPhone) {
      fields.contactPhone = existing.contactPhone;
      fields.contactConsent = true;
    }
    const dishes = this.dishes(body, rules, order);
    const photoIds = await this.photoIds(body, rules, order);
    const status = publishDecision(rules, body.overall, existing?.status);
    const low = isLowRating(body.overall, rules.alertBelowStars);

    const reviewId = await this.prisma.$transaction(async (tx) => {
      let id: string;
      if (!existing) {
        const created = await tx.review.create({
          data: {
            restaurantId: order.restaurantId,
            branchId: order.branchId,
            orderId: order.id,
            source: 'ORDER',
            verified: true,
            ...fields,
            editKeyHash: body.editKey ? hashKey(body.editKey) : null,
            editableUntil: new Date(now.getTime() + rules.editWindowHours * 3_600_000),
            status,
            publishedAt: status === 'PUBLISHED' ? now : null,
            ...(low && { followUpStatus: 'OPEN' as const, followUpUpdatedAt: now }),
            createdAt: now,
          },
        });
        id = created.id;
        await tx.reviewEvent.create({ data: { reviewId: id, kind: 'CREATED', createdAt: now } });
      } else {
        id = existing.id;
        // The edit window and the order are fixed; a review kept by a moderator decision stays hidden.
        const changed = await tx.review.updateMany({
          where: { id, editableUntil: { gt: now } },
          data: {
            ...fields,
            status,
            // When it was first published (the public page lists published reviews by it).
            publishedAt: status === 'PUBLISHED' ? (existing.publishedAt ?? now) : existing.publishedAt,
            editCount: { increment: 1 },
            ...(low && !existing.followUpStatus && { followUpStatus: 'OPEN' as const, followUpUpdatedAt: now }),
          },
        });
        if (changed.count !== 1) throw fail('conflict', CODES.NOT_ELIGIBLE, 'This review can no longer be changed.', { eligibility: 'LOCKED' });
        const before = snapshot(existing);
        await tx.reviewEvent.create({ data: { reviewId: id, kind: 'EDITED', previousOverall: existing.overall, metadata: before, createdAt: now } });
        await this.audit.record({
          actorId: null, restaurantId: order.restaurantId, action: 'review.edited', targetType: 'review', targetId: id,
          metadata: { from: before, to: { overall: body.overall, ratings: body.ratings ?? {}, comment: fields.comment, tags: fields.tags } } as Prisma.InputJsonValue,
        }, tx);
        await tx.reviewDishRating.deleteMany({ where: { reviewId: id } });
        await tx.reviewPhoto.deleteMany({ where: { reviewId: id } });
      }
      if (dishes.length) await tx.reviewDishRating.createMany({ data: dishes.map((dish) => ({ ...dish, reviewId: id, createdAt: now })) });
      if (photoIds.length) await tx.reviewPhoto.createMany({ data: photoIds.map((mediaId, sortOrder) => ({ reviewId: id, mediaId, sortOrder })) });
      return id;
    });

    // Photos dropped by an edit go private at once (and are purged later as unused).
    const dropped = existing?.photos.map((photo) => photo.mediaId).filter((mediaId) => !photoIds.includes(mediaId)) ?? [];
    await this.photos.makePrivate(dropped);
    const wasPublished = existing?.status === 'PUBLISHED';
    await this.after(reviewId, rules, existing ? 'updated' : 'created', status === 'PUBLISHED' || wasPublished);

    const row = await this.prisma.review.findUniqueOrThrow({ where: { id: reviewId }, include: dinerReviewInclude });
    return {
      review: toDinerReview(row),
      outcome: outcomeFor(row.status, row.overall, rules, order.branch.googleReviewUrl),
      editableUntil: row.editableUntil.toISOString(),
    };
  }

  /** After a review is written: photos follow its status, the public caches, the dashboards, and the low-rating alert. */
  private async after(reviewId: string, rules: ReviewRules, kind: 'created' | 'updated', publicChanged: boolean): Promise<void> {
    await this.photos.sync(reviewId, rules);
    if (publicChanged) await this.publicReviews.invalidate((await this.prisma.review.findUniqueOrThrow({ where: { id: reviewId }, select: { restaurantId: true } })).restaurantId);
    await this.notifier.changed(kind, reviewId, rules);
    await this.notifier.alertIfLow(reviewId, rules);
  }

  private async eligibility(order: OrderRow, now: Date) {
    const [planIncludes, rules] = await Promise.all([this.access.planIncludes(order.restaurant), this.access.rules(order.restaurantId)]);
    const eligibility = reviewEligibility({ reviewsOn: planIncludes && rules.enabled, askAfter: rules.askAfter, order, review: order.review, now });
    return { rules, eligibility };
  }

  private assertOpen(eligibility: ReturnType<typeof reviewEligibility>): void {
    if (eligibility === 'OPEN' || eligibility === 'EDITABLE') return;
    if (eligibility === 'UNAVAILABLE') throw fail('conflict', CODES.UNAVAILABLE, 'This restaurant does not take reviews.');
    const message = eligibility === 'LOCKED' ? 'This review can no longer be changed.' : eligibility === 'NOT_YET' ? 'You can review the order once it is served.' : 'This order cannot be reviewed.';
    throw fail('conflict', CODES.NOT_ELIGIBLE, message, { eligibility });
  }

  private form(order: OrderRow, rules: ReviewRules): ReviewForm {
    return {
      restaurant: { name: order.restaurant.name, subdomain: order.restaurant.subdomain },
      branch: { slug: order.branch.slug, name: order.branch.name },
      subRatings: rules.subRatings,
      dishRatings: rules.dishRatings,
      dishRatingScale: rules.dishRatingScale,
      commentRequiredBelow: rules.commentRequiredBelow,
      photos: rules.photos,
      maxPhotos: REVIEW_LIMITS.photosPerReview,
      tags: rules.tags,
      displayName: rules.displayName,
      dishes: rules.dishRatings
        ? order.items.map((item) => ({ orderItemId: item.id, nameAr: item.nameAr, nameEn: item.nameEn, variantNameAr: item.variantNameAr, variantNameEn: item.variantNameEn, quantity: item.quantity }))
        : [],
    };
  }

  /** The review's own fields, checked against what the restaurant asks. */
  private validate(body: DinerBody | FeedbackBody, rules: ReviewRules) {
    for (const key of Object.keys(body.ratings ?? {})) {
      if (!(rules.subRatings as string[]).includes(key)) throw fail('bad', CODES.RATING_NOT_ASKED, 'This restaurant does not ask for this rating.', { field: `ratings.${key}` });
    }
    for (const tag of body.tags ?? []) {
      if (!rules.tags.some((known) => known.code === tag)) throw fail('bad', CODES.TAG_UNKNOWN, 'Pick one of the restaurant’s tags.', { tag });
    }
    const comment = body.comment ?? null;
    if (!comment && commentRequired(body.overall, rules.commentRequiredBelow)) {
      throw fail('bad', CODES.COMMENT_REQUIRED, 'Tell the restaurant what went wrong.', { below: rules.commentRequiredBelow });
    }
    if (body.contactPhone && !body.contactConsent) throw fail('bad', CODES.CONTACT_CONSENT_REQUIRED, 'Agree to be contacted to leave a phone number.');
    return {
      overall: body.overall,
      ...ratingColumns(body.ratings),
      tags: body.tags ?? [],
      comment,
      authorName: body.name ?? null,
      // A phone number is kept only with consent; withdrawing consent forgets it.
      contactPhone: body.contactConsent ? (body.contactPhone ?? null) : null,
      contactConsent: body.contactConsent && Boolean(body.contactPhone),
      language: body.language,
    };
  }

  /** Dish ratings: only the order's own lines, each once, on the restaurant's scale. */
  private dishes(body: DinerBody, rules: ReviewRules, order: OrderRow) {
    if (!body.dishes?.length) return [];
    if (!rules.dishRatings) throw fail('bad', CODES.RATING_NOT_ASKED, 'This restaurant does not ask about each dish.', { field: 'dishes' });
    return body.dishes.map((dish) => {
      const item = order.items.find((line) => line.id === dish.orderItemId);
      if (!item) throw fail('bad', CODES.DISH_NOT_IN_ORDER, 'This dish is not part of the order.', { orderItemId: dish.orderItemId });
      if (rules.dishRatingScale === 'THUMBS' && dish.rating !== DISH_THUMBS.UP && dish.rating !== DISH_THUMBS.DOWN) {
        throw fail('bad', CODES.RATING_NOT_ASKED, 'Rate each dish thumbs up (5) or down (1).', { field: 'dishes.rating' });
      }
      return { orderItemId: item.id, menuItemId: item.menuItemId, nameAr: item.nameAr, nameEn: item.nameEn, rating: dish.rating };
    });
  }

  /** Photos already on the review, or uploaded for this order through the review's photo route. */
  private async photoIds(body: DinerBody, rules: ReviewRules, order: OrderRow): Promise<string[]> {
    const ids = body.photoIds ?? [];
    if (!ids.length) return [];
    if (!rules.photos) throw fail('bad', CODES.PHOTOS_OFF, 'This restaurant does not take photos with reviews.');
    const attached = new Set(order.review?.photos.map((photo) => photo.mediaId));
    for (const id of ids) {
      if (attached.has(id)) continue;
      const uploaded = await this.redis.sismember(uploadsKey(order.id), id);
      const media = uploaded ? await this.prisma.media.count({ where: { id, restaurantId: order.restaurantId, kind: 'REVIEW', reviewPhotos: { none: {} } } }) : 0;
      if (!media) throw fail('bad', CODES.PHOTO_NOT_FOUND, 'Upload the photo again.', { photoId: id });
    }
    return ids;
  }

  /** At most REVIEW_LIMITS.feedbackPerDay pieces of feedback per IP and restaurant a day (counted once validated). */
  private async countFeedback(restaurantId: string, ip: string): Promise<void> {
    const key = `reviews:feedback:${restaurantId}:${hashKey(ip)}`;
    let count: number;
    try {
      const results = await this.redis.multi().incr(key).expire(key, 24 * 60 * 60, 'NX').exec();
      count = Number(results?.[0]?.[1]);
    } catch (error) {
      this.logger.warn({ err: error }, 'Feedback limit check skipped');
      return;
    }
    if (count > REVIEW_LIMITS.feedbackPerDay) {
      throw new HttpException(
        { code: COMMON_ERROR_CODES.RATE_LIMITED, message: 'Thanks! You have already sent feedback today.', details: { limit: REVIEW_LIMITS.feedbackPerDay } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async orderFor(token: string): Promise<OrderRow> {
    const orderId = this.trackingTokens.verify(token);
    const order = orderId ? await this.prisma.order.findUnique({ where: { id: orderId }, include: orderInclude }) : null;
    if (!order) throw orderNotFound();
    return order;
  }
}

/** The review as it was, for its history. */
function snapshot(review: ExistingReview): Prisma.InputJsonObject {
  return {
    overall: review.overall,
    ratings: ratingsOf(review),
    tags: review.tags,
    comment: review.comment,
    authorName: review.authorName,
    dishes: review.dishRatings.map((dish) => ({ orderItemId: dish.orderItemId, rating: dish.rating })),
    photoIds: review.photos.map((photo) => photo.mediaId),
    status: review.status satisfies ReviewStatus,
  };
}
