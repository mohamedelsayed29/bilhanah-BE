import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ACTIVE_ORDER_STATUSES,
  BRANCH_ERROR_CODES,
  BRANCH_LIMITS,
  type BranchList,
  type BranchMenu,
  type BranchMenuCopy,
  type BranchMenuItem,
  type BranchMenuReset,
  COMMON_ERROR_CODES,
  type createBranchSchema,
  MENU_ERROR_CODES,
  type OpeningHours,
  ORDER_ERROR_CODES,
  type OrderingSettings,
  OWNER_ONLY_BRANCH_FIELDS,
  type OwnerBranch,
  RESTAURANT_ERROR_CODES,
  type setBranchItemSchema,
  type updateBranchSchema,
} from '@bilhanah/contracts';
import { type Branch, Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MenusService } from '../menus/menus.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { effectiveItem, isEmptyItemOverride, itemOverride } from './branch-menu.js';
import { BranchScopeService, branchNotFound, type Scope } from './branch-scope.service.js';

type CreateBranch = z.output<typeof createBranchSchema>;
type UpdateBranch = z.output<typeof updateBranchSchema>;
type SetBranchItem = z.output<typeof setBranchItemSchema>;

const ORDERING_FIELDS = ['orderingEnabled', 'acceptsDineIn', 'acceptsPickup', 'ordersPaused'] as const;

const slugTaken = () =>
  new ConflictException({ code: BRANCH_ERROR_CODES.BRANCH_SLUG_TAKEN, message: 'Another branch already uses this address.' });
const mainLocked = () =>
  new ConflictException({
    code: BRANCH_ERROR_CODES.MAIN_BRANCH_LOCKED,
    message: 'The main branch cannot be archived or deleted. Make another branch the main one first.',
  });

/** 64 random bits, URL-safe; printed in a table's QR code. */
const newTableCode = () => randomBytes(8).toString('base64url');

/** Validated by openingHoursSchema on the way in. */
const hoursOf = (branch: Branch) => branch.openingHours as OpeningHours | null;

/**
 * Branches of a restaurant and their menu overrides. Owners manage every
 * branch; managers run their own (contact details, hours, ordering switches,
 * menu overrides); kitchen screens may only mark dishes sold out.
 */
@Injectable()
export class BranchesService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly subscriptions: SubscriptionsService,
    private readonly menus: MenusService,
    private readonly realtime: RealtimeService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  // --- Branches ----------------------------------------------------------------

  async list(userId: string): Promise<BranchList> {
    const scope = await this.scopes.resolve(userId);
    const branches = await this.scopes.visibleBranches(scope);
    const [views, limit, used] = await Promise.all([this.toViews(scope, branches), this.allowance(scope), this.activeCount(scope.restaurant.id)]);
    return { branches: views, limit, used };
  }

  async get(userId: string, branchId: string): Promise<OwnerBranch> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, branchId);
    return (await this.toViews(scope, [branch]))[0]!;
  }

  async create(userId: string, input: CreateBranch): Promise<OwnerBranch> {
    const scope = await this.ownerScope(userId);
    this.assertWritable(scope);
    await this.assertRoomForActiveBranch(scope);
    const total = await this.prisma.branch.count({ where: { restaurantId: scope.restaurant.id } });
    if (total >= BRANCH_LIMITS.max) throw this.limitReached(BRANCH_LIMITS.max);
    const source = input.copyTablesFrom ? await this.scopes.branch(scope, input.copyTablesFrom) : null;

    const { copyTablesFrom: _copy, openingHours, ...fields } = input;
    try {
      const branch = await this.prisma.$transaction(async (tx) => {
        const { _max } = await tx.branch.aggregate({ where: { restaurantId: scope.restaurant.id }, _max: { sortOrder: true } });
        const created = await tx.branch.create({
          data: {
            ...fields,
            restaurantId: scope.restaurant.id,
            ...(openingHours !== undefined && { openingHours: openingHours ?? Prisma.DbNull }),
            sortOrder: (_max.sortOrder ?? -1) + 1,
          },
        });
        if (source) {
          // The source's seating areas come along, and each copied table stays in its area.
          const areas = await tx.tableArea.findMany({ where: { branchId: source.id }, orderBy: { sortOrder: 'asc' } });
          const areaIds = new Map<string, string>();
          for (const area of areas) {
            const copy = await tx.tableArea.create({
              data: { restaurantId: scope.restaurant.id, branchId: created.id, name: area.name, location: area.location, theme: area.theme, sortOrder: area.sortOrder },
            });
            areaIds.set(area.id, copy.id);
          }
          const tables = await tx.table.findMany({ where: { branchId: source.id }, orderBy: { sortOrder: 'asc' } });
          await tx.table.createMany({
            data: tables.map((table) => ({
              restaurantId: scope.restaurant.id,
              branchId: created.id,
              label: table.label,
              shape: table.shape,
              seats: table.seats,
              location: table.location,
              floorX: table.floorX,
              floorY: table.floorY,
              floorRotation: table.floorRotation,
              floorScale: table.floorScale,
              areaId: table.areaId ? (areaIds.get(table.areaId) ?? null) : null,
              isActive: table.isActive,
              sortOrder: table.sortOrder,
              publicCode: newTableCode(),
            })),
          });
        }
        return created;
      });
      return (await this.toViews(scope, [branch]))[0]!;
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
  }

  async update(userId: string, branchId: string, input: UpdateBranch): Promise<OwnerBranch> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'settings.operational');
    if (!scope.permissions.has('branches.manage')) {
      const refused = OWNER_ONLY_BRANCH_FIELDS.filter((field) => input[field] !== undefined);
      if (refused.length) {
        throw new ForbiddenException({
          code: COMMON_ERROR_CODES.FORBIDDEN,
          message: 'Only the owner can rename, move or archive a branch.',
          details: { fields: refused },
        });
      }
    }
    this.assertWritable(scope);
    const branch = await this.scopes.branch(scope, branchId);

    if (input.isActive === false && branch.isMain) throw mainLocked();
    if (input.isActive === true && !branch.isActive) await this.assertRoomForActiveBranch(scope);
    if ((input.acceptsDineIn ?? branch.acceptsDineIn) === false && (input.acceptsPickup ?? branch.acceptsPickup) === false) {
      throw new BadRequestException({
        code: COMMON_ERROR_CODES.VALIDATION_FAILED,
        message: 'Keep dine-in or pickup on.',
        details: [{ path: 'acceptsPickup', code: 'custom', message: 'Keep dine-in or pickup on.' }],
      });
    }
    if (input.orderingEnabled === true && !(await this.subscriptions.accessFor(scope.restaurant)).features.ordering) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.ORDERING_UNAVAILABLE, message: 'Your plan does not include ordering. Upgrade to take orders.' });
    }

    const { openingHours, ...fields } = input;
    let updated: Branch;
    try {
      updated = await this.prisma.branch.update({
        where: { id: branch.id },
        data: { ...fields, ...(openingHours !== undefined && { openingHours: openingHours ?? Prisma.DbNull }) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
    const view = (await this.toViews(scope, [updated]))[0]!;
    if (ORDERING_FIELDS.some((key) => key in input) || 'isActive' in input) {
      this.realtime.emitRestaurantUpdated(scope.restaurant.id, updated.id, view.ordering);
    }
    return view;
  }

  /** Deletes a branch that never received an order and has no staff; otherwise archive it. */
  async remove(userId: string, branchId: string): Promise<void> {
    const scope = await this.ownerScope(userId);
    const branch = await this.scopes.branch(scope, branchId);
    if (branch.isMain) throw mainLocked();
    const [orders, staff] = await Promise.all([
      this.prisma.order.count({ where: { branchId: branch.id } }),
      this.prisma.user.count({ where: { staffBranchId: branch.id } }),
    ]);
    if (orders) {
      throw new ConflictException({
        code: BRANCH_ERROR_CODES.BRANCH_HAS_ORDERS,
        message: 'This branch has orders. Archive it instead, so its history stays.',
        details: { count: orders },
      });
    }
    if (staff) {
      throw new ConflictException({
        code: BRANCH_ERROR_CODES.BRANCH_HAS_STAFF,
        message: 'Move or delete this branch’s staff accounts first.',
        details: { count: staff },
      });
    }
    // Tables and menu overrides cascade.
    await this.prisma.branch.delete({ where: { id: branch.id } });
  }

  /** Diners without a branch choice land on the main branch. */
  async makeMain(userId: string, branchId: string): Promise<BranchList> {
    const scope = await this.ownerScope(userId);
    this.assertWritable(scope);
    const branch = await this.scopes.branch(scope, branchId);
    if (!branch.isActive) {
      throw new ConflictException({ code: BRANCH_ERROR_CODES.BRANCH_ARCHIVED, message: 'Restore this branch before making it the main one.' });
    }
    if (!branch.isMain) {
      await this.prisma.$transaction([
        this.prisma.branch.updateMany({ where: { restaurantId: scope.restaurant.id, isMain: true }, data: { isMain: false } }),
        this.prisma.branch.update({ where: { id: branch.id }, data: { isMain: true } }),
      ]);
    }
    return this.list(userId);
  }

  async reorder(userId: string, ids: string[]): Promise<BranchList> {
    const scope = await this.ownerScope(userId);
    const existing = await this.prisma.branch.findMany({ where: { restaurantId: scope.restaurant.id }, select: { id: true } });
    const known = new Set(existing.map((row) => row.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw new BadRequestException({ code: MENU_ERROR_CODES.ORDER_MISMATCH, message: 'The new order must list every branch exactly once.' });
    }
    await this.prisma.$transaction(ids.map((id, sortOrder) => this.prisma.branch.update({ where: { id }, data: { sortOrder } })));
    return this.list(userId);
  }

  // --- Branch menu ---------------------------------------------------------------

  async menu(userId: string, branchId: string): Promise<BranchMenu> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, branchId);
    const [categories, overrides] = await Promise.all([this.menus.ownerCategories(scope.restaurant.id), this.menus.branchOverrides(branch.id)]);
    return {
      branchId: branch.id,
      categories: categories.map((category) => ({
        ...category,
        items: category.items.map((item) => ({
          ...item,
          override: itemOverride(item, overrides),
          effective: effectiveItem(item, overrides),
        })),
      })),
    };
  }

  async setItem(userId: string, branchId: string, itemId: string, input: SetBranchItem): Promise<BranchMenuItem> {
    const scope = await this.scopes.resolve(userId);
    if ((input.hidden !== undefined || input.prices !== undefined) && !scope.permissions.has('menu.branch')) {
      throw new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You can only mark dishes sold out or back in stock.' });
    }
    if (input.available !== undefined) this.scopes.require(scope, 'menu.availability');
    this.assertWritable(scope);
    const branch = await this.scopes.branch(scope, branchId);
    const item = await this.prisma.menuItem.findFirst({ where: { id: itemId, restaurantId: scope.restaurant.id }, include: { variants: { select: { id: true } } } });
    if (!item) throw new NotFoundException({ code: MENU_ERROR_CODES.ITEM_NOT_FOUND, message: 'Item not found.' });
    const variantIds = new Set(item.variants.map((variant) => variant.id));
    if (input.prices?.some((price) => !variantIds.has(price.variantId))) {
      throw new BadRequestException({ code: BRANCH_ERROR_CODES.VARIANT_MISMATCH, message: 'A price was given for a size this dish does not have.' });
    }

    await this.prisma.$transaction(async (tx) => {
      if (input.available !== undefined || input.hidden !== undefined) {
        const current = await tx.branchMenuItem.findUnique({ where: { branchId_itemId: { branchId: branch.id, itemId } } });
        const next = {
          isAvailable: input.available !== undefined ? input.available : (current?.isAvailable ?? null),
          isHidden: input.hidden ?? current?.isHidden ?? false,
          // A manual availability change replaces inventory's mark, so restocking never undoes it.
          soldOutByInventory: input.available !== undefined ? false : (current?.soldOutByInventory ?? false),
        };
        if (isEmptyItemOverride(next)) await tx.branchMenuItem.deleteMany({ where: { branchId: branch.id, itemId } });
        else await tx.branchMenuItem.upsert({ where: { branchId_itemId: { branchId: branch.id, itemId } }, create: { branchId: branch.id, itemId, ...next }, update: next });
      }
      for (const price of input.prices ?? []) {
        const key = { branchId_variantId: { branchId: branch.id, variantId: price.variantId } };
        if (price.pricePiastres === null) await tx.branchVariantPrice.deleteMany({ where: { branchId: branch.id, variantId: price.variantId } });
        else await tx.branchVariantPrice.upsert({ where: key, create: { branchId: branch.id, variantId: price.variantId, pricePiastres: price.pricePiastres }, update: { pricePiastres: price.pricePiastres } });
      }
      await this.bumpMenu(tx, scope.restaurant.id);
    });

    const menu = await this.menu(userId, branch.id);
    const found = menu.categories.flatMap((category) => category.items).find((candidate) => candidate.id === itemId);
    if (!found) throw new NotFoundException({ code: MENU_ERROR_CODES.ITEM_NOT_FOUND, message: 'Item not found.' });
    return found;
  }

  /** Back to the shared menu: every override of the branch is removed. */
  async resetMenu(userId: string, branchId: string): Promise<BranchMenuReset> {
    const scope = await this.managerScope(userId);
    this.assertWritable(scope);
    const branch = await this.scopes.branch(scope, branchId);
    const removed = await this.prisma.$transaction(async (tx) => {
      const [items, prices] = await Promise.all([
        tx.branchMenuItem.deleteMany({ where: { branchId: branch.id } }),
        tx.branchVariantPrice.deleteMany({ where: { branchId: branch.id } }),
      ]);
      await this.bumpMenu(tx, scope.restaurant.id);
      return items.count + prices.count;
    });
    return { removed };
  }

  /** Replaces this branch's overrides with a copy of another branch's (e.g. a new branch that prices like an old one). */
  async copyMenu(userId: string, branchId: string, sourceId: string): Promise<BranchMenuCopy> {
    const scope = await this.ownerScope(userId);
    this.assertWritable(scope);
    const [target, source] = await Promise.all([this.scopes.branch(scope, branchId), this.scopes.branch(scope, sourceId)]);
    if (target.id === source.id) return { copied: 0 };
    const copied = await this.prisma.$transaction(async (tx) => {
      await tx.branchMenuItem.deleteMany({ where: { branchId: target.id } });
      await tx.branchVariantPrice.deleteMany({ where: { branchId: target.id } });
      const [items, prices] = await Promise.all([
        tx.branchMenuItem.findMany({ where: { branchId: source.id } }),
        tx.branchVariantPrice.findMany({ where: { branchId: source.id } }),
      ]);
      // Inventory's sold-out marks belong to the source's stock, not the target's: they are not copied.
      const copiedItems = items
        .map(({ updatedAt: _u, ...row }) => (row.soldOutByInventory ? { ...row, isAvailable: null, soldOutByInventory: false } : row))
        .filter((row) => !isEmptyItemOverride(row));
      await tx.branchMenuItem.createMany({ data: copiedItems.map((row) => ({ ...row, branchId: target.id })) });
      await tx.branchVariantPrice.createMany({ data: prices.map(({ updatedAt: _u, ...row }) => ({ ...row, branchId: target.id })) });
      await this.bumpMenu(tx, scope.restaurant.id);
      return copiedItems.length + prices.length;
    });
    return { copied };
  }

  // --- Helpers -------------------------------------------------------------------

  private async toViews(scope: Scope, branches: Branch[]): Promise<OwnerBranch[]> {
    if (!branches.length) return [];
    const ids = branches.map((branch) => branch.id);
    const [access, tables, staff, active] = await Promise.all([
      this.subscriptions.accessFor(scope.restaurant),
      this.prisma.table.groupBy({ by: ['branchId'], where: { branchId: { in: ids } }, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['staffBranchId'], where: { staffBranchId: { in: ids } }, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['branchId'], where: { branchId: { in: ids }, status: { in: [...ACTIVE_ORDER_STATUSES] } }, _count: { _all: true } }),
    ]);
    const base = this.urlTemplate.replace('{subdomain}', scope.restaurant.subdomain);
    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      slug: branch.slug,
      isMain: branch.isMain,
      isActive: branch.isActive,
      phone: branch.phone,
      whatsappNumber: branch.whatsappNumber,
      city: branch.city,
      address: branch.address,
      mapUrl: branch.mapUrl,
      openingHours: hoursOf(branch),
      ordering: orderingSettings(branch, access.features.ordering),
      publicUrl: branch.isMain ? base : `${base}/?b=${branch.slug}`,
      tableCount: tables.find((row) => row.branchId === branch.id)?._count._all ?? 0,
      staffCount: staff.find((row) => row.staffBranchId === branch.id)?._count._all ?? 0,
      activeOrders: active.find((row) => row.branchId === branch.id)?._count._all ?? 0,
      createdAt: branch.createdAt.toISOString(),
    }));
  }

  /** Branches the plan allows; 0 without access (existing branches stay, new ones wait). */
  private async allowance(scope: Scope): Promise<number> {
    const access = await this.subscriptions.accessFor(scope.restaurant);
    return hasAccess(access) ? Math.min(access.features.branches, BRANCH_LIMITS.max) : 0;
  }

  private activeCount(restaurantId: string): Promise<number> {
    return this.prisma.branch.count({ where: { restaurantId, isActive: true } });
  }

  private async assertRoomForActiveBranch(scope: Scope): Promise<void> {
    const [limit, used] = await Promise.all([this.allowance(scope), this.activeCount(scope.restaurant.id)]);
    if (used >= limit) throw this.limitReached(limit);
  }

  private limitReached(limit: number) {
    return new ConflictException({
      code: BRANCH_ERROR_CODES.BRANCH_LIMIT_REACHED,
      message: limit <= 1 ? 'Your plan includes one branch. Upgrade to add more.' : `Your plan includes up to ${limit} branches.`,
      details: { limit },
    });
  }

  /** Adding, removing, reordering branches and copying menus between them. */
  private async ownerScope(userId: string): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'branches.manage');
    return scope;
  }

  /** A branch's own menu: hidden dishes and prices. */
  private async managerScope(userId: string): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'menu.branch');
    return scope;
  }

  private assertWritable(scope: Scope): void {
    if (scope.restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED, message: 'This restaurant is suspended. Please contact Bilhanah support.' });
    }
  }

  private forbidden() {
    return new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have permission to do this.' });
  }

  private bumpMenu(tx: Prisma.TransactionClient, restaurantId: string) {
    return tx.restaurant.update({ where: { id: restaurantId }, data: { menuVersion: { increment: 1 } } });
  }
}

export function orderingSettings(branch: Branch, included: boolean): OrderingSettings {
  return {
    included,
    enabled: branch.orderingEnabled,
    acceptsDineIn: branch.acceptsDineIn,
    acceptsPickup: branch.acceptsPickup,
    paused: branch.ordersPaused,
  };
}

export { branchNotFound };
