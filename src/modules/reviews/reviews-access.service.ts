import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type Permission, REVIEW_ERROR_CODES as CODES } from '@bilhanah/contracts';
import type { Prisma, RestaurantStatus } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { effectiveFeatures } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { type ReviewRules, rulesFrom } from './reviews-rules.js';

export type Tx = Prisma.TransactionClient;

export const fail = (status: 'bad' | 'forbidden' | 'conflict' | 'notFound', code: string, message: string, details?: Record<string, unknown>) => {
  const body = { code, message, ...(details && { details }) };
  return status === 'bad' ? new BadRequestException(body) : status === 'forbidden' ? new ForbiddenException(body) : status === 'conflict' ? new ConflictException(body) : new NotFoundException(body);
};

export const reviewNotFound = () => fail('notFound', CODES.REVIEW_NOT_FOUND, 'Review not found.');

/** The caller's scope, and whether they see diners' contact phones (reviews.respond). */
export type ReviewScope = Scope & { phones: boolean };

/**
 * Who may use reviews: the plan must include them (PLAN_FEATURES.reviews) and the restaurant must
 * have access; the caller must hold one of the route's permissions. Contact phones are shown only
 * to callers holding reviews.respond, the people who follow diners up.
 */
@Injectable()
export class ReviewsAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** The caller's scope; refuses without the plan (409) or any of the permissions (403). */
  async scope(userId: string, ...anyOf: Permission[]): Promise<ReviewScope> {
    const scope = await this.scopes.resolve(userId);
    await this.requirePlan(scope.restaurant);
    if (anyOf.length && !anyOf.some((permission) => scope.permissions.has(permission))) this.scopes.require(scope, anyOf[0]!);
    return { ...scope, phones: scope.permissions.has('reviews.respond') };
  }

  async planIncludes(restaurant: { id: string; status: RestaurantStatus }): Promise<boolean> {
    return effectiveFeatures(await this.subscriptions.accessFor(restaurant)).reviews;
  }

  async requirePlan(restaurant: { id: string; status: RestaurantStatus }): Promise<void> {
    if (!(await this.planIncludes(restaurant))) {
      throw fail('conflict', CODES.UNAVAILABLE, 'Feedback and reviews are part of the Menu & Orders and Full Experience plans.');
    }
  }

  /** The restaurant's review settings (the defaults until it saves some). */
  async rules(restaurantId: string, tx: Tx = this.prisma): Promise<ReviewRules & { updatedAt: Date | null }> {
    const row = await tx.reviewSettings.findUnique({ where: { restaurantId } });
    return { ...rulesFrom(row), updatedAt: row?.updatedAt ?? null };
  }

  get branches(): BranchScopeService {
    return this.scopes;
  }
}
