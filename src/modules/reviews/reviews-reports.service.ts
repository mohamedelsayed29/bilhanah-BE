import { Injectable } from '@nestjs/common';
import {
  REVIEW_LIMITS,
  REVIEW_SUB_RATING_LABELS,
  REVIEW_SUB_RATINGS,
  type ReviewDishReport,
  type reviewsExportQuerySchema,
  type ReviewStats,
  type reviewStatsQuerySchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { zonedInstant } from '../attendance/attendance-rules.js';
import { reviewListInclude } from './review-views.js';
import { ReviewsAccess, type ReviewScope } from './reviews-access.service.js';
import { computeStats, dishRows, lastDays, localDay, toCsv } from './reviews-math.js';
import { ratingsOf, resolveTags } from './reviews-rules.js';
import { ReviewsService } from './reviews.service.js';

/** Dishes need this many ratings to be ranked. */
const RANKING_MIN_COUNT = 3;
const RECENT_COMMENTS = 3;

/**
 * Review stats, the dish report and the CSV export. They count every review of the period, whether
 * published or not: low ratings are never hidden from the restaurant.
 */
@Injectable()
export class ReviewsReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReviewsAccess,
    private readonly reviews: ReviewsService,
  ) {}

  async stats(userId: string, query: z.output<typeof reviewStatsQuerySchema>, now = new Date()): Promise<ReviewStats> {
    const scope = await this.access.scope(userId, 'reviews.view');
    const own = await this.access.branches.branchWhere(scope, query.branchId);
    const where: Prisma.ReviewWhereInput = { ...own, createdAt: { gte: this.since(scope, query.days, now) } };
    const [rows, ratings, pending, openFollowUps, rules] = await Promise.all([
      this.prisma.review.findMany({
        where,
        select: {
          overall: true, tags: true, verified: true, followUpStatus: true, createdAt: true, repliedAt: true,
          foodRating: true, serviceRating: true, valueRating: true, speedRating: true, cleanlinessRating: true, atmosphereRating: true,
        },
      }),
      this.prisma.reviewDishRating.findMany({ where: { review: where }, select: { menuItemId: true, nameAr: true, nameEn: true, rating: true } }),
      this.prisma.review.count({ where: { ...own, status: 'PENDING' } }),
      this.prisma.review.count({ where: { ...own, followUpStatus: { in: ['OPEN', 'CONTACTED'] } } }),
      this.access.rules(scope.restaurant.id),
    ]);
    const computed = computeStats(rows.map((row) => ({ ...row, ratings: ratingsOf(row) })), { days: query.days, now, timeZone: scope.restaurant.timezone, tags: rules.tags });
    return { ...computed, dishRanking: dishRows(ratings, RANKING_MIN_COUNT), pending, openFollowUps };
  }

  async dishes(userId: string, query: z.output<typeof reviewStatsQuerySchema>, now = new Date()): Promise<ReviewDishReport> {
    const scope = await this.access.scope(userId, 'reviews.view');
    const where: Prisma.ReviewWhereInput = { ...(await this.access.branches.branchWhere(scope, query.branchId)), createdAt: { gte: this.since(scope, query.days, now) } };
    const [ratings, rules] = await Promise.all([
      this.prisma.reviewDishRating.findMany({
        where: { review: where },
        select: { menuItemId: true, nameAr: true, nameEn: true, rating: true, review: { select: { id: true, overall: true, comment: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.access.rules(scope.restaurant.id),
    ]);
    const dishes = dishRows(ratings).map((dish) => {
      const mine = ratings.filter((row) => (dish.menuItemId ? row.menuItemId === dish.menuItemId : !row.menuItemId && row.nameAr === dish.nameAr));
      const recentComments = mine
        .filter((row) => row.review.comment)
        .slice(0, RECENT_COMMENTS)
        .map((row) => ({ reviewId: row.review.id, overall: row.review.overall, rating: row.rating, comment: row.review.comment!, at: row.review.createdAt.toISOString() }));
      return { ...dish, recentComments };
    });
    return { days: query.days, dishRatingScale: rules.dishRatingScale, dishes };
  }

  /** The filtered reviews as CSV (newest first). Phone numbers only for callers who see them (reviews.respond). */
  async export(userId: string, query: z.output<typeof reviewsExportQuerySchema>): Promise<{ filename: string; csv: string }> {
    const scope = await this.access.scope(userId, 'reviews.view');
    const [rows, rules] = await Promise.all([
      this.prisma.review.findMany({ where: await this.reviews.filterWhere(scope, query), include: reviewListInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: REVIEW_LIMITS.exportRows }),
      this.access.rules(scope.restaurant.id),
    ]);
    const header = [
      'date', 'branch', 'order', 'verified', 'source', 'overall',
      ...REVIEW_SUB_RATINGS.map((key) => REVIEW_SUB_RATING_LABELS[key][1].toLowerCase()),
      'tags', 'comment', 'name', ...(scope.phones ? ['contact phone'] : []), 'status', 'reply', 'follow-up', 'assignee',
    ];
    const lines = rows.map((row) => {
      const ratings = ratingsOf(row);
      return [
        `${localDay(row.createdAt, scope.restaurant.timezone)} ${row.createdAt.toLocaleTimeString('en-GB', { timeZone: scope.restaurant.timezone, hour: '2-digit', minute: '2-digit' })}`,
        row.branch.name,
        row.order?.number ?? null,
        row.verified ? 'yes' : 'no',
        row.source,
        row.overall,
        ...REVIEW_SUB_RATINGS.map((key) => ratings[key] ?? null),
        resolveTags(row.tags, rules.tags).map((tag) => tag.nameEn ?? tag.nameAr).join('; '),
        row.comment,
        row.authorName,
        ...(scope.phones ? [row.contactConsent ? row.contactPhone : null] : []),
        row.status,
        row.replyText,
        row.followUpStatus,
        row.followUpAssignee?.fullName ?? null,
      ];
    });
    const today = localDay(new Date(), scope.restaurant.timezone);
    return { filename: `reviews-${scope.restaurant.subdomain}-${today}.csv`, csv: toCsv([header, ...lines]) };
  }

  /** The start of the first of the last `days` local days. */
  private since(scope: ReviewScope, days: number, now: Date): Date {
    return zonedInstant(lastDays(days, now, scope.restaurant.timezone)[0]!, '00:00', scope.restaurant.timezone);
  }
}
