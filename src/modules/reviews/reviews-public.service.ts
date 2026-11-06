import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BRANCH_ERROR_CODES,
  normalizeSubdomain,
  type PublicMenuCategory,
  type PublicReviewsInfo,
  type PublicReviewsPage,
  type publicReviewsQuerySchema,
  REVIEW_ERROR_CODES as CODES,
  REVIEW_SUB_RATINGS,
  RESTAURANT_ERROR_CODES,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { MediaService } from '../media/media.service.js';
import { publicReviewInclude, toPublicReview } from './review-views.js';
import { fail, ReviewsAccess } from './reviews-access.service.js';
import { distribution, menuRating } from './reviews-math.js';
import { type ReviewRules, SUB_RATING_COLUMNS, showsPublicly } from './reviews-rules.js';

type DishAggregate = { count: number; sum: number; positive: number };

/**
 * Dish ratings change with every published review, more often than the menu (cached per menu
 * version), so they are cached on their own, keyed by a ratings version that every change bumps:
 * a cache filled from data read before a change lands under the old version and is never read.
 */
const RATINGS_TTL_SECONDS = 10 * 60;
const ratingsVersionKey = (restaurantId: string) => `reviews:menu-ratings-version:${restaurantId}`;
const ratingsKey = (restaurantId: string, version: string) => `reviews:menu-ratings:${restaurantId}:${version}`;

/**
 * What diners see of reviews: the public reviews page (summary from every published review), the
 * dish badges on the public menu, and whether the menu offers reviews and feedback at all. Contact
 * phones and unpublished reviews never leave through here.
 */
@Injectable()
export class ReviewsPublicService {
  private readonly logger = new Logger(ReviewsPublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReviewsAccess,
    private readonly media: MediaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** For the public restaurant view (whose access is already resolved); null when the plan has no reviews. */
  async info(restaurantId: string, planIncludes: boolean): Promise<PublicReviewsInfo | null> {
    if (!planIncludes) return null;
    const rules = await this.access.rules(restaurantId);
    return { page: showsPublicly(true, rules), feedback: rules.enabled && rules.allowUnverified, dishRatingScale: rules.dishRatingScale };
  }

  /**
   * The menu's dishes with their rating (published reviews of every branch, at least menuMinCount
   * ratings), for a restaurant whose view says reviews are shown (PublicReviewsInfo.page). Attached
   * after the menu cache, from a short-lived cache of its own whose key every change to a published
   * review (or the settings) bumps, so badges are never stale.
   */
  async withRatings(restaurantId: string, categories: PublicMenuCategory[]): Promise<PublicMenuCategory[]> {
    if (!categories.length) return categories;
    const rules = await this.access.rules(restaurantId);
    if (!showsPublicly(true, rules)) return categories;
    const aggregates = await this.dishAggregates(restaurantId);
    return categories.map((category) => ({
      ...category,
      items: category.items.map((item) => {
        const aggregate = aggregates[item.id];
        return { ...item, rating: aggregate ? menuRating(aggregate, rules.menuMinCount) : null };
      }),
    }));
  }

  /** Forgets the cached dish ratings: a published review, its dishes or the settings changed. */
  async invalidate(restaurantId: string): Promise<void> {
    await this.redis.incr(ratingsVersionKey(restaurantId)).catch((error: unknown) => this.logger.warn({ err: error }, 'Could not clear the dish ratings cache'));
  }

  async page(rawSubdomain: string, query: z.output<typeof publicReviewsQuerySchema>): Promise<PublicReviewsPage> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain: normalizeSubdomain(rawSubdomain) }, select: { id: true, name: true, subdomain: true, status: true } });
    if (!restaurant) throw fail('notFound', RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, 'Restaurant not found.');
    const [planIncludes, rules] = await Promise.all([this.access.planIncludes(restaurant), this.access.rules(restaurant.id)]);
    if (!showsPublicly(planIncludes, rules)) throw fail('notFound', CODES.NOT_PUBLIC, 'This restaurant does not show reviews.');
    const branch = query.branch
      ? await this.prisma.branch.findFirst({ where: { restaurantId: restaurant.id, slug: query.branch, isActive: true }, select: { id: true, slug: true, name: true } })
      : null;
    if (query.branch && !branch) throw fail('notFound', BRANCH_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found.');

    const where: Prisma.ReviewWhereInput = { restaurantId: restaurant.id, status: 'PUBLISHED', ...(branch && { branchId: branch.id }) };
    const [summary, items, total] = await Promise.all([
      this.summary(restaurant.id, branch?.id ?? null, rules),
      this.prisma.review.findMany({
        where,
        include: publicReviewInclude,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.review.count({ where }),
    ]);
    return {
      restaurant: { name: restaurant.name, subdomain: restaurant.subdomain },
      branch: branch && { slug: branch.slug, name: branch.name },
      summary,
      dishRatingScale: rules.dishRatingScale,
      items: items.map((row) => toPublicReview(row, rules, this.media)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Average, count and distribution of every published review: the page can filter what it lists, never what it counts. */
  private async summary(restaurantId: string, branchId: string | null, rules: ReviewRules): Promise<PublicReviewsPage['summary']> {
    const branch = branchId ? Prisma.sql`AND branch_id = ${branchId}::uuid` : Prisma.empty;
    const subColumns = REVIEW_SUB_RATINGS.map((key) => Prisma.raw(`AVG("${toColumn(SUB_RATING_COLUMNS[key])}")::float8 AS "${key}"`));
    const [row] = await this.prisma.$queryRaw<Record<string, number | bigint | null>[]>`
      SELECT COUNT(*) AS count, AVG(overall)::float8 AS average,
        COUNT(*) FILTER (WHERE overall = 1) AS s1, COUNT(*) FILTER (WHERE overall = 2) AS s2, COUNT(*) FILTER (WHERE overall = 3) AS s3,
        COUNT(*) FILTER (WHERE overall = 4) AS s4, COUNT(*) FILTER (WHERE overall = 5) AS s5,
        COUNT(*) FILTER (WHERE verified) AS verified, ${Prisma.join(subColumns)}
      FROM reviews WHERE restaurant_id = ${restaurantId}::uuid AND status = 'PUBLISHED' ${branch}`;
    const number = (value: number | bigint | null | undefined) => (value === null || value === undefined ? null : Number(value));
    const counts = distribution([]);
    for (const star of ['1', '2', '3', '4', '5'] as const) counts[star] = number(row?.[`s${star}`]) ?? 0;
    const subRatings: PublicReviewsPage['summary']['subRatings'] = {};
    for (const key of REVIEW_SUB_RATINGS) {
      const value = number(row?.[key]);
      if (value !== null) subRatings[key] = Math.round(value * 100) / 100;
    }
    const average = number(row?.['average']);
    return {
      average: average === null ? null : Math.round(average * 100) / 100,
      count: number(row?.['count']) ?? 0,
      distribution: counts,
      verifiedCount: number(row?.['verified']) ?? 0,
      subRatings,
      policy: rules.publishMode === 'AUTO' ? { mode: 'AUTO', minStars: rules.publishMinStars } : { mode: 'MANUAL', minStars: 1 },
    };
  }

  private async dishAggregates(restaurantId: string): Promise<Record<string, DishAggregate>> {
    let key: string | null = null;
    try {
      key = ratingsKey(restaurantId, (await this.redis.get(ratingsVersionKey(restaurantId))) ?? '0');
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as Record<string, DishAggregate>;
    } catch (error) {
      this.logger.warn({ err: error }, 'Dish ratings cache unavailable');
    }
    const rows = await this.prisma.$queryRaw<{ menuItemId: string; count: bigint; sum: bigint; positive: bigint }[]>`
      SELECT d.menu_item_id AS "menuItemId", COUNT(*) AS count, SUM(d.rating) AS sum, COUNT(*) FILTER (WHERE d.rating >= 4) AS positive
      FROM review_dish_ratings d JOIN reviews r ON r.id = d.review_id
      WHERE r.restaurant_id = ${restaurantId}::uuid AND r.status = 'PUBLISHED' AND d.menu_item_id IS NOT NULL
      GROUP BY d.menu_item_id`;
    const result = Object.fromEntries(rows.map((row) => [row.menuItemId, { count: Number(row.count), sum: Number(row.sum), positive: Number(row.positive) }]));
    if (key) {
      this.redis.set(key, JSON.stringify(result), 'EX', RATINGS_TTL_SECONDS).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Could not cache dish ratings');
      });
    }
    return result;
  }
}

/** foodRating → food_rating */
const toColumn = (field: string) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
