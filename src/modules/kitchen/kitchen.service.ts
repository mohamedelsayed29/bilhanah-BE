import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createKitchenAccountSchema,
  KITCHEN_ERROR_CODES,
  KITCHEN_LIMITS,
  type KitchenAccount,
  type KitchenContext,
  RESTAURANT_ERROR_CODES,
  STAFF_LIMITS,
  type StaffRole,
  type updateKitchenAccountSchema,
} from '@bilhanah/contracts';
import type { Prisma, User } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { orderingSettings } from '../branches/branches.service.js';

const STAFF_ROLES: StaffRole[] = ['KITCHEN', 'MANAGER'];
const staffWhere = (restaurantId: string): Prisma.UserWhereInput => ({ role: { in: STAFF_ROLES }, staffRestaurantId: restaurantId });
type StaffRow = User & { staffBranch: { name: string } | null };

const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

const accountNotFound = () =>
  new NotFoundException({ code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_NOT_FOUND, message: 'Kitchen account not found.' });

/**
 * Staff accounts, made by a restaurant's owner: kitchen screens and branch
 * managers, each tied to one branch or working at all of them.
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly subscriptions: SubscriptionsService,
    private readonly scopes: BranchScopeService,
  ) {}

  async list(ownerId: string): Promise<KitchenAccount[]> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const users = await this.prisma.user.findMany({
      where: staffWhere(restaurantId),
      orderBy: { createdAt: 'asc' },
      include: { staffBranch: { select: { name: true } } },
    });
    return Promise.all(users.map((user) => this.toAccount(user)));
  }

  async create(ownerId: string, input: z.output<typeof createKitchenAccountSchema>): Promise<KitchenAccount> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const branchId = await this.checkBranch(restaurantId, input.branchId);
    const count = await this.prisma.user.count({ where: staffWhere(restaurantId) });
    if (count >= STAFF_LIMITS.accounts) {
      throw new ConflictException({
        code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_LIMIT_REACHED,
        message: `A restaurant can have up to ${STAFF_LIMITS.accounts} staff accounts.`,
      });
    }
    // Kitchen screens are limited per branch (or per restaurant, for all-branch screens).
    if (input.role === 'KITCHEN') {
      const kitchens = await this.prisma.user.count({ where: { role: 'KITCHEN', staffRestaurantId: restaurantId, staffBranchId: branchId } });
      if (kitchens >= KITCHEN_LIMITS.accounts) {
        throw new ConflictException({
          code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_LIMIT_REACHED,
          message: `A branch can have up to ${KITCHEN_LIMITS.accounts} kitchen accounts.`,
        });
      }
    }
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          role: input.role,
          staffRestaurantId: restaurantId,
          staffBranchId: branchId,
          // The owner chose the address; nobody has to confirm it.
          emailVerifiedAt: new Date(),
        },
        include: { staffBranch: { select: { name: true } } },
      });
      return await this.toAccount(user);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({ code: KITCHEN_ERROR_CODES.EMAIL_TAKEN, message: 'Another account already uses this email.' });
    }
  }

  async update(ownerId: string, id: string, input: z.output<typeof updateKitchenAccountSchema>): Promise<KitchenAccount> {
    const current = await this.findOwned(ownerId, id);
    const branchId = input.branchId !== undefined ? await this.checkBranch(current.staffRestaurantId!, input.branchId) : undefined;
    const now = new Date();
    // Role and branch are read when signing in and connecting, so a change signs the account's screens out.
    const accessChanged = (input.role !== undefined && input.role !== current.role) || (branchId !== undefined && branchId !== current.staffBranchId);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined && { fullName: input.fullName }),
          ...(input.active !== undefined && { status: input.active ? 'ACTIVE' : 'SUSPENDED' }),
          ...(input.role !== undefined && { role: input.role }),
          ...(branchId !== undefined && { staffBranchId: branchId }),
        },
        include: { staffBranch: { select: { name: true } } },
      }),
      ...(input.active === false || accessChanged
        ? [this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'REVOKED_BY_USER' } })]
        : []),
    ]);
    return this.toAccount(user);
  }

  /** Sets a new password and signs every screen using the account out. */
  async setPassword(ownerId: string, id: string, password: string): Promise<void> {
    await this.findOwned(ownerId, id);
    const now = new Date();
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: now } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'PASSWORD_RESET' } }),
    ]);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.findOwned(ownerId, id);
    // Sessions cascade with the user.
    await this.prisma.user.delete({ where: { id } });
  }

  /** What a kitchen screen or manager needs about its restaurant and branch. */
  async context(userId: string): Promise<KitchenContext> {
    const scope = await this.scopes.resolve(userId);
    if (scope.role === 'OWNER') throw restaurantNotFound();
    const [branch, branches, access] = await Promise.all([
      this.scopes.branch(scope),
      this.scopes.visibleBranches(scope, { activeOnly: true }),
      this.subscriptions.accessFor(scope.restaurant),
    ]);
    return {
      role: scope.role,
      restaurant: { name: scope.restaurant.name, subdomain: scope.restaurant.subdomain },
      branch: scope.fixedBranchId ? { id: branch.id, name: branch.name, slug: branch.slug } : null,
      branches: branches.map((row) => ({ id: row.id, name: row.name, slug: row.slug, isMain: row.isMain })),
      ordering: orderingSettings(branch, access.features.ordering),
    };
  }

  /** A branch of this restaurant, or null for every branch. */
  private async checkBranch(restaurantId: string, branchId: string | null | undefined): Promise<string | null> {
    if (!branchId) return null;
    const found = await this.prisma.branch.count({ where: { id: branchId, restaurantId } });
    if (!found) throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', message: 'Branch not found.' });
    return branchId;
  }

  private async restaurantIdFor(ownerId: string): Promise<string> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true } });
    if (!restaurant) throw restaurantNotFound();
    return restaurant.id;
  }

  /** Other restaurants' accounts look unknown. */
  private async findOwned(ownerId: string, id: string): Promise<User> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const found = await this.prisma.user.findFirst({ where: { id, ...staffWhere(restaurantId) } });
    if (!found) throw accountNotFound();
    return found;
  }

  private async toAccount(user: StaffRow): Promise<KitchenAccount> {
    const lastSession = await this.prisma.session.findFirst({
      where: { userId: user.id, lastUsedAt: { not: null } },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    });
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role === 'MANAGER' ? 'MANAGER' : 'KITCHEN',
      branchId: user.staffBranchId,
      branchName: user.staffBranch?.name ?? null,
      active: user.status === 'ACTIVE',
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: lastSession?.lastUsedAt?.toISOString() ?? null,
    };
  }
}
