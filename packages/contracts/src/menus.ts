import { z } from 'zod';
import type { ImageSet } from './media.js';
import type { MenuItemRating } from './review-display.js';
import { EXTRA_MENU_LANGUAGES, NUTRITION_LIMITS, PORTION_UNITS, type Translations, type VariantNutrition } from './menu-languages.js';

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

/**
 * Text in extra menu languages: { fr: { name, description? } }. Blank fields and
 * languages are dropped, so sending '' removes a translation.
 */
function translationsSchema<const Fields extends Record<string, number>>(fields: Fields) {
  const shape = Object.fromEntries(Object.entries(fields).map(([field, max]) => [field, z.string().trim().max(max).optional()])) as {
    [Field in keyof Fields]: z.ZodOptional<z.ZodString>;
  };
  return z
    .partialRecord(z.enum(EXTRA_MENU_LANGUAGES), z.strictObject(shape))
    .transform((value) => {
      const clean: Translations<Extract<keyof Fields, string>> = {};
      for (const [language, texts] of Object.entries(value) as [keyof typeof clean, Record<string, string | undefined> | undefined][]) {
        const kept = Object.fromEntries(Object.entries(texts ?? {}).filter(([, text]) => text));
        if (Object.keys(kept).length) clean[language] = kept as Partial<Record<Extract<keyof Fields, string>, string>>;
      }
      return clean;
    });
}

export const categoryTranslationsSchema = translationsSchema({ name: 80 });
export const itemTranslationsSchema = translationsSchema({ name: 100, description: 500 });
export const variantTranslationsSchema = translationsSchema({ name: 40 });

export const createCategorySchema = z.strictObject({
  nameAr: requiredText(80),
  nameEn: optionalText(80),
  translations: categoryTranslationsSchema.optional(),
  isVisible: z.boolean().optional(),
  /** The kitchen station preparing its dishes; null for the default station. */
  stationId: z.uuid().nullable().optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export const pricePiastresSchema = z.number().int().min(0).max(MAX_PRICE_PIASTRES);

const optionalInt = (limits: { min: number; max: number }) => z.number().int().min(limits.min).max(limits.max).nullable().optional();

const variantSchema = z
  .strictObject({
    nameAr: optionalText(40),
    nameEn: optionalText(40),
    translations: variantTranslationsSchema.optional(),
    pricePiastres: pricePiastresSchema,
    /** kcal; null hides it. */
    calories: optionalInt(NUTRITION_LIMITS.calories),
    /** A portion needs both its amount and its unit. */
    portionValue: optionalInt(NUTRITION_LIMITS.portion),
    portionUnit: z.enum(PORTION_UNITS).nullable().optional(),
    serves: optionalInt(NUTRITION_LIMITS.serves),
  })
  .superRefine((variant, context) => {
    if ((variant.portionValue == null) !== (variant.portionUnit == null)) {
      context.addIssue({ code: 'custom', path: [variant.portionValue == null ? 'portionValue' : 'portionUnit'], message: 'Give the portion amount and its unit.' });
    }
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
  translations: itemTranslationsSchema.optional(),
  imageId: z.uuid().nullable().optional(),
  isAvailable: z.boolean().optional(),
  isVisible: z.boolean().optional(),
  /** Its own kitchen station; null follows the category's. */
  stationId: z.uuid().nullable().optional(),
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
  translations: Translations<'name'>;
  pricePiastres: number;
} & VariantNutrition;

export type OwnerMenuItem = {
  id: string;
  categoryId: string;
  nameAr: string;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  /** Name and description in the restaurant's extra menu languages. */
  translations: Translations<'name' | 'description'>;
  image: ImageSet | null;
  isAvailable: boolean;
  isVisible: boolean;
  variants: MenuVariant[];
  /** Its own kitchen station; null follows the category's. */
  stationId: string | null;
};

export type OwnerMenuCategory = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  translations: Translations<'name'>;
  isVisible: boolean;
  /** The kitchen station preparing its dishes; null for the default station. */
  stationId: string | null;
  items: OwnerMenuItem[];
};

/** The owner's full menu, hidden entries included, in display order. */
export type OwnerMenu = { categories: OwnerMenuCategory[] };

export type PublicMenuItem = Omit<OwnerMenuItem, 'categoryId' | 'isVisible' | 'stationId'> & {
  /** Diners' rating of the dish (docs/REVIEWS.md); null below menuMinCount ratings or when reviews are not shown. */
  rating: MenuItemRating | null;
};

export type PublicMenuCategory = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  translations: Translations<'name'>;
  items: PublicMenuItem[];
};
