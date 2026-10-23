import { z } from 'zod';
import type { ImageSet } from './media.js';

export const MENU_ERROR_CODES = {
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  MENU_LIMIT_REACHED: 'MENU_LIMIT_REACHED',
  ORDER_MISMATCH: 'ORDER_MISMATCH',
} as const;

/** Protects the public menu's size; generous for any real restaurant. */
export const MENU_LIMITS = { categories: 50, items: 500, variantsPerItem: 10 } as const;

/** EGP 100,000, in piastres. */
export const MAX_PRICE_PIASTRES = 10_000_000;

const requiredText = (max: number) => z.string().trim().min(1).max(max);
/** Optional text: empty strings are stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const createCategorySchema = z.strictObject({
  nameAr: requiredText(80),
  nameEn: optionalText(80),
  isVisible: z.boolean().optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export const pricePiastresSchema = z.number().int().min(0).max(MAX_PRICE_PIASTRES);

const variantSchema = z.strictObject({
  nameAr: optionalText(40),
  nameEn: optionalText(40),
  pricePiastres: pricePiastresSchema,
});

/** One unnamed price, or several sizes that each have an Arabic name. */
const variantsSchema = z
  .array(variantSchema)
  .min(1)
  .max(MENU_LIMITS.variantsPerItem)
  .superRefine((variants, context) => {
    if (variants.length < 2) return;
    variants.forEach((variant, index) => {
      if (!variant.nameAr) {
        context.addIssue({ code: 'custom', path: [index, 'nameAr'], message: 'Name each size.' });
      }
    });
  });

const itemFields = {
  categoryId: z.uuid(),
  nameAr: requiredText(100),
  nameEn: optionalText(100),
  descriptionAr: optionalText(500),
  descriptionEn: optionalText(500),
  imageId: z.uuid().nullable().optional(),
  isAvailable: z.boolean().optional(),
  isVisible: z.boolean().optional(),
  variants: variantsSchema,
};

export const createItemSchema = z.strictObject(itemFields);

/** `variants`, when given, replaces the item's sizes. Changing `categoryId` moves the item to the end of that category. */
export const updateItemSchema = z.strictObject(itemFields).partial();

/** The complete new order: every id in the list, each exactly once. */
export const reorderSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .max(MENU_LIMITS.items)
    .refine((ids) => new Set(ids).size === ids.length, 'Each id may appear only once.'),
});

export const menuIdParamSchema = z.uuid();

export type MenuVariant = {
  id: string;
  nameAr: string | null;
  nameEn: string | null;
  pricePiastres: number;
};

export type OwnerMenuItem = {
  id: string;
  categoryId: string;
  nameAr: string;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  image: ImageSet | null;
  isAvailable: boolean;
  isVisible: boolean;
  variants: MenuVariant[];
};

export type OwnerMenuCategory = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  isVisible: boolean;
  items: OwnerMenuItem[];
};

/** The owner's full menu, hidden entries included, in display order. */
export type OwnerMenu = { categories: OwnerMenuCategory[] };

export type PublicMenuItem = Omit<OwnerMenuItem, 'categoryId' | 'isVisible'>;

export type PublicMenuCategory = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  items: PublicMenuItem[];
};
