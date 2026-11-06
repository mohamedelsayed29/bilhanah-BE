import { Injectable } from '@nestjs/common';
import {
  effectivePermissions,
  type hideReviewSchema,
  type OwnerReview,
  type OwnerReviewListItem,
  type Paginated,
  REVIEW_ERROR_CODES as CODES,
  type ReviewAssignee,
  type reviewFollowUpSchema,
  type reviewsExportQuerySchema,
  type ReviewSettings,
  type reviewSettingsSchema,
  type reviewsQuerySchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { localDayRange } from '../inventory/inventory-access.service.js';
import { MediaService } from '../media/media.service.js';
import { ReviewNotifier } from './review-notifier.service.js';
import { ReviewPhotos } from './review-photos.service.js';
import { reviewDetailInclude, reviewListInclude, toListItem, toOwnerReview } from './review-views.js';
import { fail, reviewNotFound, ReviewsAccess, type ReviewScope } from './reviews-access.service.js';
import { ReviewsPublicService } from './reviews-public.service.js';

type Filters = z.output<typeof reviewsExportQuerySchema>;

/**
 * The restaurant's side of reviews (docs/REVIEWS.md): settings, the inbox and a review's detail,
 * replies, moderation and follow-ups. Reviews of other restaurants look unknown (404); staff tied
 * to a branch see only its reviews (another branch's: 403).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReviewsAccess,
    private readonly media: MediaService,
    private readonly photos: ReviewPhotos,
    private readonly notifier: ReviewNotifier,
    private readonly publicReviews: ReviewsPublicService,
    private readonly audit: AuditService,
  ) {}

  // --- Settings ------------------------------------------------------------------------------------

  async getSettings(userId: string): Promise<ReviewSettings> {
    const scope = await this.access.scope(userId, 'reviews.view', 'reviews.settings');
    return this.settingsView(scope.restaurant.id);
  }

  async updateSettings(userId: string, input: z.output<typeof reviewSettingsSchema>, ipAddress?: string): Promise<ReviewSettings> {
    const scope = await this.access.scope(userId, 'reviews.settings');
    const restaurantId = scope.restaurant.id;
    const { before, after } = await this.prisma.$transaction(async (tx) => {
      const before = await this.access.rules(restaurantId, tx);
      const data = { ...input, ...(input.tags && { tags: input.tags as Prisma.InputJsonValue }), updatedById: userId };
      await tx.reviewSettings.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
      await this.audit.record({
        actorId: userId, restaurantId, action: 'reviews.settings', targetType: 'review-settings', targetId: restaurantId,
        metadata: { from: { ...before, updatedAt: undefined }, changes: input } as Prisma.InputJsonValue, ipAddress,
      }, tx);
      return { before, after: await this.access.rules(restaurantId, tx) };
    });
    // Nothing is public while publishing is NEVER, photos included.
    if ((before.publishMode === 'NEVER') !== (after.publishMode === 'NEVER')) await this.photos.syncRestaurant(restaurantId, after);
    await this.publicReviews.invalidate(restaurantId);
    return this.settingsView(restaurantId);
  }

  // --- Inbox ---------------------------------------------------------------------------------------

  async list(userId: string, query: z.output<typeof reviewsQuerySchema>): Promise<Paginated<OwnerReviewListItem>> {
    const scope = await this.access.scope(userId, 'reviews.view');
    const where = await this.filterWhere(scope, query);
    const [rows, total, rules] = await Promise.all([
      this.prisma.review.findMany({ where, include: reviewListInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.review.count({ where }),
      this.access.rules(scope.restaurant.id),
    ]);
    return { items: rows.map((row) => toListItem(row, rules, scope.phones)), total, page: query.page, pageSize: query.pageSize };
  }

  async get(userId: string, reviewId: string): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.view');
    await this.own(scope, reviewId);
    return this.detail(scope, reviewId);
  }

  /** A review photo, for the inbox (private until published). */
  async photo(userId: string, reviewId: string, mediaId: string): Promise<Buffer> {
    const scope = await this.access.scope(userId, 'reviews.view');
    await this.own(scope, reviewId);
    const attached = await this.prisma.reviewPhoto.count({ where: { reviewId, mediaId } });
    if (!attached) throw reviewNotFound();
    return this.photos.read(scope.restaurant.id, mediaId);
  }

  /** Who a follow-up can be given to: active accounts holding reviews.respond that work at the branch (or every branch). */
  async assignees(userId: string, branchId?: string): Promise<ReviewAssignee[]> {
    const scope = await this.access.scope(userId, 'reviews.respond');
    const branch = branchId ?? scope.fixedBranchId ?? undefined;
    if (branch) await this.access.branches.branch(scope, branch);
    return this.eligibleAssignees(scope.restaurant.id, branch ?? null);
  }

  // --- Replies, moderation, follow-ups ------------------------------------------------------------

  /** One public reply per review; sending again edits it (the first reply time is kept for the stats). */
  async reply(userId: string, reviewId: string, text: string): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.respond');
    const review = await this.own(scope, reviewId);
    const now = new Date();
    const actor = await this.actorName(userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id: reviewId }, data: { replyText: text, repliedAt: review.repliedAt ?? now, replyUpdatedAt: now, repliedById: userId } });
      await tx.reviewEvent.create({ data: { reviewId, kind: 'REPLIED', actorId: userId, actorName: actor, note: text.slice(0, 500), createdAt: now } });
    });
    return this.changed(scope, reviewId, review.status === 'PUBLISHED');
  }

  async removeReply(userId: string, reviewId: string): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.respond');
    const review = await this.own(scope, reviewId);
    if (!review.replyText) return this.detail(scope, reviewId);
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id: reviewId }, data: { replyText: null, repliedAt: null, replyUpdatedAt: null, repliedById: null } });
      await tx.reviewEvent.create({ data: { reviewId, kind: 'REPLY_REMOVED', actorId: userId, actorName: await this.actorName(userId) } });
    });
    return this.changed(scope, reviewId, review.status === 'PUBLISHED');
  }

  /** Publishes a pending or hidden review (refused while publishing is NEVER). Audited. */
  async publish(userId: string, reviewId: string, ipAddress?: string): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.moderate');
    const review = await this.own(scope, reviewId);
    const rules = await this.access.rules(scope.restaurant.id);
    if (rules.publishMode === 'NEVER') throw fail('conflict', CODES.PUBLISHING_OFF, 'Publishing is off in the review settings.');
    if (review.status === 'PUBLISHED') return this.detail(scope, reviewId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({
        where: { id: reviewId },
        data: { status: 'PUBLISHED', publishedAt: review.publishedAt ?? now, hiddenAt: null, hiddenReason: null, moderatedById: userId, moderatedAt: now },
      });
      await tx.reviewEvent.create({ data: { reviewId, kind: 'PUBLISHED', actorId: userId, actorName: await this.actorName(userId), createdAt: now } });
      await this.audit.record({
        actorId: userId, restaurantId: scope.restaurant.id, action: 'review.published', targetType: 'review', targetId: reviewId,
        metadata: { from: review.status, overall: review.overall }, ipAddress,
      }, tx);
    });
    await this.photos.sync(reviewId, rules);
    return this.changed(scope, reviewId, true);
  }

  /** Hides a review from the public (with a reason, kept and audited); the restaurant still sees it. */
  async hide(userId: string, reviewId: string, input: z.output<typeof hideReviewSchema>, ipAddress?: string): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.moderate');
    const review = await this.own(scope, reviewId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id: reviewId }, data: { status: 'HIDDEN', hiddenAt: now, hiddenReason: input.reason, moderatedById: userId, moderatedAt: now } });
      await tx.reviewEvent.create({ data: { reviewId, kind: 'HIDDEN', actorId: userId, actorName: await this.actorName(userId), note: input.reason, createdAt: now } });
      await this.audit.record({
        actorId: userId, restaurantId: scope.restaurant.id, action: 'review.hidden', targetType: 'review', targetId: reviewId,
        metadata: { from: review.status, overall: review.overall, reason: input.reason }, ipAddress,
      }, tx);
    });
    await this.photos.sync(reviewId, await this.access.rules(scope.restaurant.id));
    return this.changed(scope, reviewId, review.status === 'PUBLISHED');
  }

  /** Moves the follow-up along (OPEN → CONTACTED → RESOLVED, or back), with an internal note and an assignee, into the history. */
  async followUp(userId: string, reviewId: string, input: z.output<typeof reviewFollowUpSchema>): Promise<OwnerReview> {
    const scope = await this.access.scope(userId, 'reviews.respond');
    const review = await this.own(scope, reviewId);
    let assignee: { id: string; fullName: string } | null | undefined;
    if (input.assigneeId) {
      assignee = (await this.eligibleAssignees(scope.restaurant.id, review.branchId)).find((candidate) => candidate.id === input.assigneeId);
      if (!assignee) throw fail('bad', CODES.ASSIGNEE_INVALID, 'Choose someone of this restaurant who follows reviews up at this branch.');
    } else if (input.assigneeId === null) {
      assignee = null;
    }
    const now = new Date();
    const actor = await this.actorName(userId);
    const assigneeId = assignee === undefined ? review.followUpAssigneeId : (assignee?.id ?? null);
    const assigneeName = assignee === undefined
      ? (review.followUpAssigneeId ? (await this.prisma.user.findUnique({ where: { id: review.followUpAssigneeId }, select: { fullName: true } }))?.fullName ?? null : null)
      : (assignee?.fullName ?? null);
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id: reviewId }, data: { followUpStatus: input.status, followUpAssigneeId: assigneeId, followUpUpdatedAt: now } });
      await tx.reviewEvent.create({
        data: { reviewId, kind: 'FOLLOW_UP', actorId: userId, actorName: actor, followUpStatus: input.status, assigneeId, assigneeName, note: input.note ?? null, createdAt: now },
      });
    });
    return this.changed(scope, reviewId, false);
  }

  // --- Helpers -------------------------------------------------------------------------------------

  /** The inbox and export filters, inside the caller's scope (a branch they may not see: 403/404). */
  async filterWhere(scope: ReviewScope, query: Filters): Promise<Prisma.ReviewWhereInput> {
    const q = query.q;
    const number = q && /^#?\d{1,6}$/.test(q) ? Number(q.replace('#', '')) : null;
    const hasDates = query.from || query.to;
    return {
      ...(await this.access.branches.branchWhere(scope, query.branchId)),
      ...(query.stars && { overall: { in: query.stars } }),
      ...(query.status && { status: query.status }),
      ...(query.verified !== undefined && { verified: query.verified }),
      ...(query.hasComment !== undefined && { comment: query.hasComment ? { not: null } : null }),
      ...(query.followUp && { followUpStatus: query.followUp === 'NONE' ? null : query.followUp }),
      ...(hasDates && { createdAt: localDayRange(scope.restaurant.timezone, query.from, query.to) }),
      ...(q && {
        OR: [
          { comment: { contains: q, mode: 'insensitive' } },
          { authorName: { contains: q, mode: 'insensitive' } },
          { replyText: { contains: q, mode: 'insensitive' } },
          { tags: { has: q.toUpperCase() } },
          ...(number !== null ? [{ order: { number } }] : []),
        ],
      }),
    };
  }

  /** The review, if the caller may see it: another restaurant's looks unknown, another branch's is refused. */
  private async own(scope: ReviewScope, reviewId: string) {
    const review = await this.prisma.review.findFirst({ where: { id: reviewId, restaurantId: scope.restaurant.id } });
    if (!review) throw reviewNotFound();
    if (scope.fixedBranchId && review.branchId !== scope.fixedBranchId) await this.access.branches.branch(scope, review.branchId);
    return review;
  }

  private async detail(scope: ReviewScope, reviewId: string): Promise<OwnerReview> {
    const [row, rules] = await Promise.all([
      this.prisma.review.findUniqueOrThrow({ where: { id: reviewId }, include: reviewDetailInclude }),
      this.access.rules(scope.restaurant.id),
    ]);
    return toOwnerReview(row, rules, scope.phones, this.media);
  }

  /** After a change: the public caches (when what diners see changed) and the dashboards. */
  private async changed(scope: ReviewScope, reviewId: string, publicChanged: boolean): Promise<OwnerReview> {
    if (publicChanged) await this.publicReviews.invalidate(scope.restaurant.id);
    const rules = await this.access.rules(scope.restaurant.id);
    await this.notifier.changed('updated', reviewId, rules);
    return this.detail(scope, reviewId);
  }

  private async eligibleAssignees(restaurantId: string, branchId: string | null): Promise<ReviewAssignee[]> {
    const [owner, staff] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { owner: { select: { id: true, fullName: true, role: true, status: true } } } }),
      this.prisma.user.findMany({
        where: { staffRestaurantId: restaurantId, status: 'ACTIVE', ...(branchId && { OR: [{ staffBranchId: null }, { staffBranchId: branchId }] }) },
        select: { id: true, fullName: true, role: true, staffBranchId: true, permissionGrants: true },
        orderBy: { fullName: 'asc' },
      }),
    ]);
    return [
      ...(owner.owner.status === 'ACTIVE' ? [{ id: owner.owner.id, fullName: owner.owner.fullName, role: owner.owner.role, branchId: null }] : []),
      ...staff
        .filter((account) => effectivePermissions(account.role, account.permissionGrants).includes('reviews.respond'))
        .map((account) => ({ id: account.id, fullName: account.fullName, role: account.role, branchId: account.staffBranchId })),
    ];
  }

  private async actorName(userId: string): Promise<string | null> {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }))?.fullName ?? null;
  }

  private async settingsView(restaurantId: string): Promise<ReviewSettings> {
    const { updatedAt, ...rules } = await this.access.rules(restaurantId);
    return { ...rules, updatedAt: updatedAt?.toISOString() ?? null };
  }
}

