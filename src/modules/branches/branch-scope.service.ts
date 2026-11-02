import { ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { BRANCH_ERROR_CODES, RESTAURANT_ERROR_CODES, type UserRole } from '@bilhanah/contracts';
import type { Branch, Prisma, RestaurantStatus } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

/** Roles that work inside a restaurant. */
export type RestaurantRole = Extract<UserRole, 'OWNER' | 'KITCHEN' | 'MANAGER'>;

/** Who is calling, which restaurant they belong to, and which branches they may see. */
export type Scope = {
  userId: string;
  role: RestaurantRole;
  restaurant: { id: string; name: string; subdomain: string; timezone: string; status: RestaurantStatus };
  /** A staff account tied to one branch; null for owners and all-branch staff. */
  fixedBranchId: string | null;
};

const restaurantSelect = { id: true, name: true, subdomain: true, timezone: true, status: true } satisfies Prisma.RestaurantSelect;

export const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

export const branchNotFound = () => new NotFoundException({ code: BRANCH_ERROR_CODES.BRANCH_NOT_FOUND, message: 'Branch not found.' });

const branchForbidden = () =>
  new ForbiddenException({ code: BRANCH_ERROR_CODES.BRANCH_FORBIDDEN, message: 'You can only work with your own branch.' });

/**
 * Resolves the tenant boundary for every owner and staff request. Owners see
 * all their restaurant's branches; staff see their restaurant, and only their
 * branch when tied to one. Branch ids from other restaurants look unknown (404);
 * another branch of the caller's own restaurant is refused (403).
 */
@Injectable()
export class BranchScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string): Promise<Scope> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        staffBranchId: true,
        restaurant: { select: restaurantSelect },
        staffRestaurant: { select: restaurantSelect },
      },
    });
    if (!user || user.role === 'ADMIN') throw restaurantNotFound();
    const restaurant = user.role === 'OWNER' ? user.restaurant : user.staffRestaurant;
    if (!restaurant) throw restaurantNotFound();
    return { userId, role: user.role, restaurant, fixedBranchId: user.role === 'OWNER' ? null : user.staffBranchId };
  }

  /** A filter for rows with a branchId: the requested branch (checked), the caller's own, or every branch. */
  async branchWhere(scope: Scope, requested?: string): Promise<{ restaurantId: string; branchId?: string }> {
    if (requested) {
      await this.branch(scope, requested);
      return { restaurantId: scope.restaurant.id, branchId: requested };
    }
    return { restaurantId: scope.restaurant.id, ...(scope.fixedBranchId && { branchId: scope.fixedBranchId }) };
  }

  /** One branch to act on: the requested one (checked), the caller's own, or the main branch. */
  async branch(scope: Scope, requested?: string): Promise<Branch> {
    const id = requested ?? scope.fixedBranchId;
    if (id && scope.fixedBranchId && id !== scope.fixedBranchId) {
      // Distinguish "not yours" from "does not exist" only inside the caller's own restaurant.
      const exists = await this.prisma.branch.count({ where: { id, restaurantId: scope.restaurant.id } });
      throw exists ? branchForbidden() : branchNotFound();
    }
    const branch = id
      ? await this.prisma.branch.findFirst({ where: { id, restaurantId: scope.restaurant.id } })
      : await this.prisma.branch.findFirst({ where: { restaurantId: scope.restaurant.id, isMain: true } });
    if (!branch) throw branchNotFound();
    return branch;
  }

  /** The restaurant's main branch (every restaurant has one). */
  async mainBranch(restaurantId: string): Promise<Branch> {
    const branch = await this.prisma.branch.findFirst({ where: { restaurantId, isMain: true } });
    if (!branch) throw branchNotFound();
    return branch;
  }

  /** Every branch the caller may see, main first, then by position. */
  visibleBranches(scope: Scope, { activeOnly = false } = {}): Promise<Branch[]> {
    return this.prisma.branch.findMany({
      where: {
        restaurantId: scope.restaurant.id,
        ...(scope.fixedBranchId && { id: scope.fixedBranchId }),
        ...(activeOnly && { isActive: true }),
      },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }
}

/** Global, so every restaurant module can scope its queries without import cycles. */
@Global()
@Module({ providers: [BranchScopeService], exports: [BranchScopeService] })
export class BranchScopeModule {}
