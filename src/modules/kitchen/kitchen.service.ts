import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assignableRoles,
  type createKitchenAccountSchema,
  effectivePermissions,
  grantablePermissions,
  KITCHEN_ERROR_CODES,
  KITCHEN_LIMITS,
  type KitchenAccount,
  type KitchenContext,
  type Permission,
  RESTAURANT_ERROR_CODES,
  STAFF_LIMITS,
  STAFF_ROLES,
  type StaffAuditEntry,
  type StaffOptions,
  type StaffRole,
  type updateKitchenAccountSchema,
} from '@bilhanah/contracts';
import type { Prisma, User } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { effectiveFeatures } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { orderingSettings } from '../branches/branches.service.js';

const staffWhere = (restaurantId: string): Prisma.UserWhereInput => ({ role: { in: [...STAFF_ROLES] }, staffRestaurantId: restaurantId });
type StaffRow = User & { staffBranch: { name: string } | null };

const STAFF_ACTIONS: StaffAuditEntry['action'][] = [
  'staff.created', 'staff.updated', 'staff.role_changed', 'staff.permissions_changed', 'staff.activated', 'staff.deactivated', 'staff.password_reset', 'staff.deleted',
];

const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

const accountNotFound = () =>
  new NotFoundException({ code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_NOT_FOUND, message: 'Kitchen account not found.' });

const roleNotAssignable = (role: string, assignable: StaffRole[]) =>
  new ForbiddenException({ code: KITCHEN_ERROR_CODES.ROLE_NOT_ASSIGNABLE, message: 'You cannot give this role or manage this account.', details: { role, assignable } });

/** Who made a change, and from where, for the audit log. */
export type Actor = { userId: string; ipAddress?: string };

/**
 * Staff accounts: managers, cashiers, waiters and kitchen screens, each tied to one branch or working
 * at all of them. The owner manages every one; a manager (with staff.manage and roles.assign) only
 * the roles below their own, at their own branch when tied to one. The owner's own account is never
 * a staff account, so the restaurant always keeps its one owner. Every change is logged.
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly subscriptions: SubscriptionsService,
    private readonly scopes: BranchScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<KitchenAccount[]> {
    const scope = await this.staffScope(userId, 'staff.view');
    const users = await this.prisma.user.findMany({
      where: this.visibleWhere(scope),
      orderBy: { createdAt: 'asc' },
      include: { staffBranch: { select: { name: true } } },
    });
    return Promise.all(users.map((user) => this.toAccount(user)));
  }

  /** The roles and extra permissions the caller may give, for the staff page. */
  async options(userId: string): Promise<StaffOptions> {
    const scope = await this.staffScope(userId, 'staff.view');
    const permissions = [...scope.permissions];
    const roles = scope.permissions.has('staff.manage') ? assignableRoles(scope.role, permissions) : [];
    return {
      roles,
      grantable: Object.fromEntries(STAFF_ROLES.map((role) => [role, roles.includes(role) ? grantablePermissions(role, permissions) : []])) as Record<StaffRole, Permission[]>,
      branchId: scope.fixedBranchId,
    };
  }

  async create(actor: Actor, input: z.output<typeof createKitchenAccountSchema>): Promise<KitchenAccount> {
    const scope = await this.staffScope(actor.userId, 'staff.manage', 'roles.assign');
    const restaurantId = scope.restaurant.id;
    this.checkRole(scope, input.role);
    const grants = this.checkGrants(scope, input.role, input.permissions);
    const branchId = await this.checkBranch(scope, input.branchId);
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
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            fullName: input.fullName,
            passwordHash,
            role: input.role,
            permissionGrants: grants,
            staffRestaurantId: restaurantId,
            staffBranchId: branchId,
            // The owner chose the address; nobody has to confirm it.
            emailVerifiedAt: new Date(),
          },
          include: { staffBranch: { select: { name: true } } },
        });
        await this.log(tx, scope, actor, 'staff.created', created, { to: input.role });
        return created;
      });
      return await this.toAccount(user);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({ code: KITCHEN_ERROR_CODES.EMAIL_TAKEN, message: 'Another account already uses this email.' });
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateKitchenAccountSchema>): Promise<KitchenAccount> {
    const scope = await this.staffScope(actor.userId, 'staff.manage');
    const current = await this.findManageable(scope, id);
    const role = input.role ?? (current.role as StaffRole);
    const roleChanged = role !== current.role;
    if (roleChanged || input.permissions !== undefined) this.scopes.require(scope, 'roles.assign');
    if (roleChanged) this.checkRole(scope, role);
    // A new role keeps only the grants it may have; given ones are checked against the caller.
    const grants = input.permissions !== undefined
      ? this.checkGrants(scope, role, input.permissions)
      : current.permissionGrants.filter((grant) => effectivePermissions(role, [grant]).includes(grant as Permission));
    const grantsChanged = grants.length !== current.permissionGrants.length || grants.some((grant) => !current.permissionGrants.includes(grant));
    const branchId = input.branchId !== undefined ? await this.checkBranch(scope, input.branchId) : undefined;
    const branchChanged = branchId !== undefined && branchId !== current.staffBranchId;
    const activeChanged = input.active !== undefined && input.active !== (current.status === 'ACTIVE');
    const now = new Date();
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined && { fullName: input.fullName }),
          ...(activeChanged && { status: input.active ? 'ACTIVE' : 'SUSPENDED' }),
          ...(roleChanged && { role }),
          ...(grantsChanged && { permissionGrants: grants }),
          ...(branchId !== undefined && { staffBranchId: branchId }),
        },
        include: { staffBranch: { select: { name: true } } },
      });
      // Permissions are read on every request; a new role or branch also changes the account's
      // screens, so it signs them out to start again with the new ones.
      if (input.active === false || roleChanged || branchChanged) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'REVOKED_BY_USER' } });
      }
      if (roleChanged) await this.log(tx, scope, actor, 'staff.role_changed', updated, { from: current.role, to: role });
      if (grantsChanged) await this.log(tx, scope, actor, 'staff.permissions_changed', updated, { from: current.permissionGrants.join(', ') || null, to: grants.join(', ') || null });
      if (activeChanged) await this.log(tx, scope, actor, input.active ? 'staff.activated' : 'staff.deactivated', updated, {});
      if ((input.fullName !== undefined && input.fullName !== current.fullName) || branchChanged) await this.log(tx, scope, actor, 'staff.updated', updated, {});
      return updated;
    });
    return this.toAccount(user);
  }

  /** Sets a new password and signs every screen using the account out. */
  async setPassword(actor: Actor, id: string, password: string): Promise<void> {
    const scope = await this.staffScope(actor.userId, 'staff.manage');
    const target = await this.findManageable(scope, id);
    const now = new Date();
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: now } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'PASSWORD_RESET' } });
      await this.log(tx, scope, actor, 'staff.password_reset', target, {});
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const scope = await this.staffScope(actor.userId, 'staff.manage');
    const target = await this.findManageable(scope, id);
    // Sessions cascade with the user; the log keeps the name.
    await this.prisma.$transaction(async (tx) => {
      await this.log(tx, scope, actor, 'staff.deleted', target, { from: target.role });
      await tx.user.delete({ where: { id } });
    });
  }

  /** The latest staff changes in the restaurant (for a branch-tied manager: at their branch). */
  async activity(userId: string): Promise<StaffAuditEntry[]> {
    const scope = await this.staffScope(userId, 'staff.manage');
    const rows = await this.prisma.auditLog.findMany({
      where: {
        restaurantId: scope.restaurant.id,
        action: { in: STAFF_ACTIONS },
        ...(scope.fixedBranchId && { metadata: { path: ['branchId'], equals: scope.fixedBranchId } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { actor: { select: { fullName: true } } },
    });
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    return rows.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        action: row.action as StaffAuditEntry['action'],
        actorName: row.actor?.fullName ?? null,
        targetName: text(metadata['targetName']),
        from: text(metadata['from']),
        to: text(metadata['to']),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /** What a staff account's screen needs about its restaurant and branch. */
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
      permissions: [...scope.permissions],
      restaurant: { name: scope.restaurant.name, subdomain: scope.restaurant.subdomain },
      branch: scope.fixedBranchId ? { id: branch.id, name: branch.name, slug: branch.slug } : null,
      branches: branches.map((row) => ({ id: row.id, name: row.name, slug: row.slug, isMain: row.isMain })),
      ordering: orderingSettings(branch, access.features.ordering),
      orderPrepMinutes: scope.restaurant.orderPrepMinutes,
      features: effectiveFeatures(access),
    };
  }

  private async staffScope(userId: string, ...permissions: Permission[]): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, ...permissions);
    return scope;
  }

  /** The restaurant's staff, and only a branch-tied caller's branch. */
  private visibleWhere(scope: Scope): Prisma.UserWhereInput {
    return { ...staffWhere(scope.restaurant.id), ...(scope.fixedBranchId && { staffBranchId: scope.fixedBranchId }) };
  }

  private checkRole(scope: Scope, role: StaffRole): void {
    const assignable = assignableRoles(scope.role, [...scope.permissions]);
    if (!assignable.includes(role)) throw roleNotAssignable(role, assignable);
  }

  /** The grants, each one allowed for the role and held by the caller. */
  private checkGrants(scope: Scope, role: StaffRole, grants: readonly Permission[]): Permission[] {
    const allowed = grantablePermissions(role, [...scope.permissions]);
    const refused = grants.filter((grant) => !allowed.includes(grant));
    if (refused.length) {
      throw new ForbiddenException({ code: KITCHEN_ERROR_CODES.PERMISSION_NOT_GRANTABLE, message: 'You cannot give these permissions.', details: { permissions: refused } });
    }
    return [...grants];
  }

  /** A branch of this restaurant, or null for every branch; a branch-tied caller only gives their own. */
  private async checkBranch(scope: Scope, branchId: string | null | undefined): Promise<string | null> {
    if (scope.fixedBranchId) {
      if (branchId && branchId !== scope.fixedBranchId) await this.scopes.branch(scope, branchId);
      return scope.fixedBranchId;
    }
    if (!branchId) return null;
    const found = await this.prisma.branch.count({ where: { id: branchId, restaurantId: scope.restaurant.id } });
    if (!found) throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', message: 'Branch not found.' });
    return branchId;
  }

  /**
   * An account the caller may change: in their restaurant (others look unknown) and branch, not
   * their own, and with a role they could give.
   */
  private async findManageable(scope: Scope, id: string): Promise<User> {
    const found = await this.prisma.user.findFirst({ where: { id, ...this.visibleWhere(scope) } });
    if (!found) throw accountNotFound();
    if (found.id === scope.userId) {
      throw new ForbiddenException({ code: KITCHEN_ERROR_CODES.SELF_CHANGE_FORBIDDEN, message: 'You cannot change your own account here.' });
    }
    this.checkRole(scope, found.role as StaffRole);
    return found;
  }

  private log(tx: Prisma.TransactionClient, scope: Scope, actor: Actor, action: StaffAuditEntry['action'], target: User, details: Record<string, string | null>) {
    return this.audit.record({
      actorId: actor.userId,
      restaurantId: scope.restaurant.id,
      action,
      targetType: 'staff',
      targetId: target.id,
      metadata: { targetName: target.fullName, targetRole: target.role, branchId: target.staffBranchId, ...details },
      ipAddress: actor.ipAddress,
    }, tx);
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
      role: user.role as StaffRole,
      grants: user.permissionGrants as Permission[],
      permissions: effectivePermissions(user.role, user.permissionGrants),
      branchId: user.staffBranchId,
      branchName: user.staffBranch?.name ?? null,
      active: user.status === 'ACTIVE',
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: lastSession?.lastUsedAt?.toISOString() ?? null,
    };
  }
}
