import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { effectivePermissions } from '@bilhanah/contracts';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { lowRatingEmail } from './review-emails.js';
import { reviewListInclude, toListItem } from './review-views.js';
import { isLowRating, type ReviewRules } from './reviews-rules.js';

/**
 * Tells the restaurant about reviews: realtime events to the dashboards of staff holding
 * reviews.view, and the low-rating email (once per review) to the owner and the staff holding
 * reviews.respond at the review's branch. Never fails the request that caused it.
 */
@Injectable()
export class ReviewNotifier {
  private readonly logger = new Logger(ReviewNotifier.name);
  private readonly dashboardUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly mailer: MailerService,
    config: ConfigService<Env, true>,
  ) {
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '');
  }

  /** review.created / review.updated, without the contact phone (some receivers may not see it). */
  async changed(kind: 'created' | 'updated', reviewId: string, rules: ReviewRules): Promise<void> {
    try {
      const row = await this.prisma.review.findUnique({ where: { id: reviewId }, include: reviewListInclude });
      if (row) this.realtime.emitReview(kind, row.restaurantId, toListItem(row, rules, false));
    } catch (error) {
      this.logger.warn({ err: error, reviewId }, 'Could not send the review event');
    }
  }

  /** Sends the low-rating alert when the review is below alertBelowStars and has not alerted before. */
  async alertIfLow(reviewId: string, rules: ReviewRules): Promise<void> {
    try {
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId },
        select: {
          id: true, restaurantId: true, branchId: true, overall: true, comment: true, verified: true, alertedAt: true, contactPhone: true, contactConsent: true,
          order: { select: { number: true } },
          branch: { select: { name: true } },
          restaurant: { select: { name: true, owner: { select: { email: true, fullName: true, preferredLanguage: true, status: true } } } },
        },
      });
      if (!review || review.alertedAt || !isLowRating(review.overall, rules.alertBelowStars)) return;
      // Compare-and-swap: two edits at once still alert once.
      const claimed = await this.prisma.review.updateMany({ where: { id: reviewId, alertedAt: null }, data: { alertedAt: new Date() } });
      if (claimed.count !== 1) return;

      const staff = await this.prisma.user.findMany({
        where: { staffRestaurantId: review.restaurantId, status: 'ACTIVE', OR: [{ staffBranchId: null }, { staffBranchId: review.branchId }] },
        select: { email: true, fullName: true, preferredLanguage: true, role: true, permissionGrants: true },
      });
      const owner = review.restaurant.owner;
      const recipients = [
        ...(owner.status === 'ACTIVE' ? [owner] : []),
        ...staff.filter((account) => effectivePermissions(account.role, account.permissionGrants).includes('reviews.respond')),
      ];
      const facts = {
        restaurantName: review.restaurant.name,
        branchName: review.branch.name,
        overall: review.overall,
        comment: review.comment,
        orderNumber: review.order?.number ?? null,
        verified: review.verified,
        hasContact: review.contactConsent && review.contactPhone !== null,
      };
      const link = `${this.dashboardUrl}/reviews/${review.id}`;
      for (const recipient of new Map(recipients.map((account) => [account.email, account])).values()) {
        this.mailer.sendInBackground(lowRatingEmail(recipient, facts, link), 'review-low-rating');
      }
    } catch (error) {
      this.logger.warn({ err: error, reviewId }, 'Could not send the low-rating alert');
    }
  }
}
