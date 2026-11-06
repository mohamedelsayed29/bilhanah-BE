import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  KITCHEN_DISPLAY_ERROR_CODES,
  type createCategorySchema,
  type createItemSchema,
  MENU_ERROR_CODES,
  MENU_LIMITS,
  type OwnerMenu,
  type OwnerMenuItem,
  type PublicMenuCategory,
  type PublicMenuItem,
  RESTAURANT_ERROR_CODES,
  type updateCategorySchema,
  type updateItemSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { MediaService } from '../media/media.service.js';
import { type BranchOverrides, effectiveItem, NO_OVERRIDES, toOverrides } from '../branches/branch-menu.js';
import { asTranslations } from './translations.js';

type Tx = Prisma.TransactionClient;

const PUBLIC_MENU_TTL_SECONDS = 60 * 60;

const categoryNotFound = () =>
  new NotFoundException({ code: MENU_ERROR_CODES.CATEGORY_NOT_FOUND, message: 'Category not found.' });
const itemNotFound = () => new NotFoundException({ code: MENU_ERROR_CODES.ITEM_NOT_FOUND, message: 'Item not found.' });
const limitReached = (what: string, limit: number) =>
  new BadRequestException({
    code: MENU_ERROR_CODES.MENU_LIMIT_REACHED,
    message: `A menu can have at most ${limit} ${what}.`,
    details: { limit },
  });

const itemInclude = {
  image: true,
  variants: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.MenuItemInclude;

type ItemRow = Prisma.MenuItemGetPayload<{ include: typeof itemInclude }>;

/**
 * Menu editing for restaurant owners, and the cached public menu. Every
 * owner query is scoped to the caller's restaurant; ids from other
 * restaurants behave as if they did not exist. Every change bumps the
 * restaurant's menuVersion, which keys the public menu cache.
 */
@Injectable()
export class MenusService {
  private readonly logger = new Logger(MenusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async getMenu(ownerId: string): Promise<OwnerMenu> {
    const restaurantId = await this.restaurantIdFor(ownerId, { forWrite: false });
    return { categories: await this.ownerCategories(restaurantId) };
  }

  /** The whole shared menu as its owner sees it; also the base of every branch menu. */
  async ownerCategories(restaurantId: string): Promise<OwnerMenu['categories']> {
    const categories = await this.prisma.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: 'asc' },
      include: { items: { orderBy: { sortOrder: 'asc' }, include: itemInclude } },
    });
    return categories.map((category) => ({
      id: category.id,
      nameAr: category.nameAr,
      nameEn: category.nameEn,
      translations: asTranslations(category.translations),
      isVisible: category.isVisible,
      stationId: category.stationId,
      items: category.items.map((item) => this.toOwnerItem(item)),
    }));
  }

  /** A branch's overrides of this restaurant's menu. */
  async branchOverrides(branchId: string): Promise<BranchOverrides> {
    const [items, prices] = await Promise.all([
      this.prisma.branchMenuItem.findMany({ where: { branchId }, select: { itemId: true, isAvailable: true, isHidden: true } }),
      this.prisma.branchVariantPrice.findMany({ where: { branchId }, select: { variantId: true, pricePiastres: true } }),
    ]);
    return toOverrides(items, prices);
  }

  // --- Categories --------------------------------------------------------

  async createCategory(ownerId: string, input: z.output<typeof createCategorySchema>): Promise<OwnerMenu['categories'][number]> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    return this.change(restaurantId, async (tx) => {
      const { _count, _max } = await tx.category.aggregate({
        where: { restaurantId },
        _count: true,
        _max: { sortOrder: true },
      });
      if (_count >= MENU_LIMITS.categories) throw limitReached('categories', MENU_LIMITS.categories);
      await this.assertStation(tx, restaurantId, input.stationId);
      const category = await tx.category.create({
        data: { ...input, restaurantId, sortOrder: (_max.sortOrder ?? -1) + 1 },
      });
      return { id: category.id, nameAr: category.nameAr, nameEn: category.nameEn, translations: asTranslations(category.translations), isVisible: category.isVisible, stationId: category.stationId, items: [] };
    });
  }

  async updateCategory(ownerId: string, categoryId: string, input: z.output<typeof updateCategorySchema>): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    await this.change(restaurantId, async (tx) => {
      await this.assertStation(tx, restaurantId, input.stationId);
      const updated = await tx.category.updateMany({ where: { id: categoryId, restaurantId }, data: input });
      if (updated.count === 0) throw categoryNotFound();
    });
  }

  /** Deletes the category and every item in it. */
  async deleteCategory(ownerId: string, categoryId: string): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    await this.change(restaurantId, async (tx) => {
      const deleted = await tx.category.deleteMany({ where: { id: categoryId, restaurantId } });
      if (deleted.count === 0) throw categoryNotFound();
    });
  }

  async reorderCategories(ownerId: string, ids: string[]): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    await this.change(restaurantId, async (tx) => {
      const existing = await tx.category.findMany({ where: { restaurantId }, select: { id: true } });
      assertSameSet(existing.map((row) => row.id), ids);
      await applyOrder(ids, (id, sortOrder) => tx.category.update({ where: { id }, data: { sortOrder } }));
    });
  }

  // --- Items -------------------------------------------------------------

  async createItem(ownerId: string, input: z.output<typeof createItemSchema>): Promise<OwnerMenuItem> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    if (input.imageId) await this.media.assertUsable(restaurantId, input.imageId, 'ITEM');
    const { variants, ...fields } = input;
    return this.change(restaurantId, async (tx) => {
      await this.assertCategory(tx, restaurantId, input.categoryId);
      await this.assertStation(tx, restaurantId, input.stationId);
      if ((await tx.menuItem.count({ where: { restaurantId } })) >= MENU_LIMITS.items) {
        throw limitReached('items', MENU_LIMITS.items);
      }
      const item = await tx.menuItem.create({
        data: {
          ...fields,
          restaurantId,
          sortOrder: await nextItemPosition(tx, input.categoryId),
          variants: { create: variants.map((variant, index) => ({ ...variant, sortOrder: index })) },
        },
        include: itemInclude,
      });
      return this.toOwnerItem(item);
    });
  }

  async updateItem(ownerId: string, itemId: string, input: z.output<typeof updateItemSchema>): Promise<OwnerMenuItem> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    if (input.imageId) await this.media.assertUsable(restaurantId, input.imageId, 'ITEM');
    const { variants, ...fields } = input;
    return this.change(restaurantId, async (tx) => {
      const current = await tx.menuItem.findFirst({ where: { id: itemId, restaurantId }, select: { categoryId: true } });
      if (!current) throw itemNotFound();
      await this.assertStation(tx, restaurantId, input.stationId);

      const data: Prisma.MenuItemUncheckedUpdateInput = { ...fields };
      if (input.categoryId && input.categoryId !== current.categoryId) {
        await this.assertCategory(tx, restaurantId, input.categoryId);
        data.sortOrder = await nextItemPosition(tx, input.categoryId);
      }
      if (variants) {
        // Sizes are matched by position and updated in place, so branch prices
        // set for a size survive edits to its name or shared price.
        const existing = await tx.menuItemVariant.findMany({ where: { itemId }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
        await tx.menuItemVariant.deleteMany({ where: { itemId, id: { in: existing.slice(variants.length).map((row) => row.id) } } });
        for (const [index, variant] of variants.entries()) {
          const current = existing[index];
          if (current) await tx.menuItemVariant.update({ where: { id: current.id }, data: { ...variant, sortOrder: index } });
          else await tx.menuItemVariant.create({ data: { ...variant, itemId, sortOrder: index } });
        }
      }
      const item = await tx.menuItem.update({ where: { id: itemId }, data, include: itemInclude });
      return this.toOwnerItem(item);
    });
  }

  async deleteItem(ownerId: string, itemId: string): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    await this.change(restaurantId, async (tx) => {
      const deleted = await tx.menuItem.deleteMany({ where: { id: itemId, restaurantId } });
      if (deleted.count === 0) throw itemNotFound();
    });
  }

  async reorderItems(ownerId: string, categoryId: string, ids: string[]): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    await this.change(restaurantId, async (tx) => {
      await this.assertCategory(tx, restaurantId, categoryId);
      const existing = await tx.menuItem.findMany({ where: { categoryId, restaurantId }, select: { id: true } });
      assertSameSet(existing.map((row) => row.id), ids);
      await applyOrder(ids, (id, sortOrder) => tx.menuItem.update({ where: { id }, data: { sortOrder } }));
    });
  }

  // --- Public menu ---------------------------------------------------------

  /**
   * Visible categories with their visible items; empty categories are left
   * out. Cached in Redis per menu version, so any edit is visible at once.
   */
  async publicCategories(restaurantId: string, menuVersion: number, branchId?: string): Promise<PublicMenuCategory[]> {
    // Branch overrides bump menuVersion too, so one key per branch and version is enough.
    const key = `menu:public:${restaurantId}:${menuVersion}${branchId ? `:${branchId}` : ''}`;
    try {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as PublicMenuCategory[];
    } catch (error) {
      this.logger.warn({ err: error }, 'Menu cache unavailable');
    }

    const [categories, overrides] = await Promise.all([
      this.prisma.category.findMany({
        where: { restaurantId, isVisible: true },
        orderBy: { sortOrder: 'asc' },
        include: { items: { where: { isVisible: true }, orderBy: { sortOrder: 'asc' }, include: itemInclude } },
      }),
      branchId ? this.branchOverrides(branchId) : Promise.resolve(NO_OVERRIDES),
    ]);
    const result: PublicMenuCategory[] = categories
      .map((category) => ({
        id: category.id,
        nameAr: category.nameAr,
        nameEn: category.nameEn,
        translations: asTranslations(category.translations),
        items: category.items.flatMap((item) => {
          const shared = this.toPublicItem(item);
          const effective = effectiveItem({ ...shared, isVisible: item.isVisible }, overrides);
          return effective.visible ? [{ ...shared, isAvailable: effective.available, variants: effective.variants }] : [];
        }),
      }))
      .filter((category) => category.items.length > 0);

    this.redis.set(key, JSON.stringify(result), 'EX', PUBLIC_MENU_TTL_SECONDS).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Could not cache menu');
    });
    return result;
  }

  // --- Helpers -------------------------------------------------------------

  private async restaurantIdFor(ownerId: string, { forWrite = true } = {}): Promise<string> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true, status: true } });
    if (!restaurant) {
      throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    }
    if (forWrite && restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED,
        message: 'This restaurant is suspended. Please contact Bilhanah support.',
      });
    }
    return restaurant.id;
  }

  /** Runs a menu change and bumps the menu version in the same transaction. */
  private change<T>(restaurantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await work(tx);
      await tx.restaurant.update({ where: { id: restaurantId }, data: { menuVersion: { increment: 1 } } });
      return result;
    });
  }

  private async assertCategory(tx: Tx, restaurantId: string, categoryId: string): Promise<void> {
    const category = await tx.category.findFirst({ where: { id: categoryId, restaurantId }, select: { id: true } });
    if (!category) throw categoryNotFound();
  }

  /** A kitchen station of this restaurant (or none). */
  private async assertStation(tx: Tx, restaurantId: string, stationId: string | null | undefined): Promise<void> {
    if (!stationId) return;
    const station = await tx.kitchenStation.count({ where: { id: stationId, restaurantId } });
    if (!station) throw new NotFoundException({ code: KITCHEN_DISPLAY_ERROR_CODES.STATION_NOT_FOUND, message: 'Kitchen station not found.' });
  }

  private toPublicItem(item: ItemRow): PublicMenuItem {
    const { categoryId: _category, isVisible: _visible, stationId: _station, ...publicItem } = this.toOwnerItem(item);
    return publicItem;
  }

  private toOwnerItem(item: ItemRow): OwnerMenuItem {
    return {
      id: item.id,
      categoryId: item.categoryId,
      nameAr: item.nameAr,
      nameEn: item.nameEn,
      descriptionAr: item.descriptionAr,
      descriptionEn: item.descriptionEn,
      image: item.image ? this.media.toImageSet(item.image) : null,
      translations: asTranslations<'name' | 'description'>(item.translations),
      isAvailable: item.isAvailable,
      isVisible: item.isVisible,
      stationId: item.stationId,
      variants: item.variants.map((variant) => ({
        id: variant.id,
        nameAr: variant.nameAr,
        nameEn: variant.nameEn,
        pricePiastres: variant.pricePiastres,
        translations: asTranslations(variant.translations),
      })),
        calories: variant.calories,
        portionValue: variant.portionValue,
        portionUnit: variant.portionUnit,
        serves: variant.serves,
    };
  }
}

async function nextItemPosition(tx: Tx, categoryId: string): Promise<number> {
  const { _max } = await tx.menuItem.aggregate({ where: { categoryId }, _max: { sortOrder: true } });
  return (_max.sortOrder ?? -1) + 1;
}

function assertSameSet(existing: string[], requested: string[]): void {
  const known = new Set(existing);
  if (requested.length !== known.size || requested.some((id) => !known.has(id))) {
    throw new BadRequestException({
      code: MENU_ERROR_CODES.ORDER_MISMATCH,
      message: 'The new order must list every entry exactly once.',
    });
  }
}

async function applyOrder(ids: string[], update: (id: string, sortOrder: number) => Promise<unknown>): Promise<void> {
  for (const [sortOrder, id] of ids.entries()) await update(id, sortOrder);
}
