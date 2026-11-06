// Menu languages and nutrition. Free of zod, so the website's public menu can
// import it without shipping zod to diners.
//
// Arabic and English are the menu's built-in languages (nameAr / nameEn fields).
// A restaurant may also offer extra languages; their text lives in each
// category's, dish's and size's `translations`, keyed by language code.

export const MENU_LANGUAGES = [
  { code: 'ar', nativeName: 'العربية', nameAr: 'العربية', nameEn: 'Arabic', dir: 'rtl' },
  { code: 'en', nativeName: 'English', nameAr: 'الإنجليزية', nameEn: 'English', dir: 'ltr' },
  { code: 'fr', nativeName: 'Français', nameAr: 'الفرنسية', nameEn: 'French', dir: 'ltr' },
  { code: 'de', nativeName: 'Deutsch', nameAr: 'الألمانية', nameEn: 'German', dir: 'ltr' },
  { code: 'it', nativeName: 'Italiano', nameAr: 'الإيطالية', nameEn: 'Italian', dir: 'ltr' },
  { code: 'es', nativeName: 'Español', nameAr: 'الإسبانية', nameEn: 'Spanish', dir: 'ltr' },
  { code: 'ru', nativeName: 'Русский', nameAr: 'الروسية', nameEn: 'Russian', dir: 'ltr' },
  { code: 'zh', nativeName: '中文', nameAr: 'الصينية', nameEn: 'Chinese', dir: 'ltr' },
  { code: 'tr', nativeName: 'Türkçe', nameAr: 'التركية', nameEn: 'Turkish', dir: 'ltr' },
] as const;

export type MenuLanguage = (typeof MENU_LANGUAGES)[number]['code'];

/** Languages a restaurant can add on top of Arabic and English. */
export const EXTRA_MENU_LANGUAGES = ['fr', 'de', 'it', 'es', 'ru', 'zh', 'tr'] as const satisfies readonly MenuLanguage[];
export type ExtraMenuLanguage = (typeof EXTRA_MENU_LANGUAGES)[number];

export function isExtraMenuLanguage(value: unknown): value is ExtraMenuLanguage {
  return typeof value === 'string' && (EXTRA_MENU_LANGUAGES as readonly string[]).includes(value);
}

export function menuLanguageInfo(code: MenuLanguage) {
  return MENU_LANGUAGES.find((language) => language.code === code)!;
}

/** Text in extra languages, per field: { fr: { name: '…', description: '…' } }. Missing languages and fields fall back. */
export type Translations<Field extends string> = Partial<Record<ExtraMenuLanguage, Partial<Record<Field, string>>>>;

type Named = { nameAr: string; nameEn: string | null; translations?: Translations<'name'> };
type NamedOptional = { nameAr: string | null; nameEn: string | null; translations?: Translations<'name'> };
type Described = { descriptionAr: string | null; descriptionEn: string | null; translations?: Translations<'name' | 'description'> };

/**
 * The text to show in `language`: the extra language's own text, else English,
 * else Arabic. In Arabic, Arabic first; in English, English first.
 */
export function menuName(entity: Named, language: MenuLanguage): string;
export function menuName(entity: NamedOptional, language: MenuLanguage): string | null;
export function menuName(entity: Named | NamedOptional, language: MenuLanguage): string | null {
  if (language === 'ar') return entity.nameAr ?? entity.nameEn;
  if (language === 'en') return entity.nameEn ?? entity.nameAr;
  return entity.translations?.[language]?.name ?? entity.nameEn ?? entity.nameAr;
}

export function menuDescription(entity: Described, language: MenuLanguage): string | null {
  if (language === 'ar') return entity.descriptionAr ?? entity.descriptionEn;
  if (language === 'en') return entity.descriptionEn ?? entity.descriptionAr;
  return entity.translations?.[language]?.description ?? entity.descriptionEn ?? entity.descriptionAr;
}

/** How much of the given text exists in an extra language, for the owner's progress indicator. */
export function hasTranslation(entity: { translations?: Translations<string> }, language: ExtraMenuLanguage, field = 'name'): boolean {
  return Boolean(entity.translations?.[language]?.[field]);
}

// --- Nutrition and portions -------------------------------------------------------

/** How a portion is measured. */
export const PORTION_UNITS = ['GRAM', 'ML', 'PIECE'] as const;
export type PortionUnit = (typeof PORTION_UNITS)[number];

export const NUTRITION_LIMITS = {
  calories: { min: 0, max: 10_000 },
  portion: { min: 1, max: 100_000 },
  serves: { min: 1, max: 50 },
} as const;

/** Per size; every field is optional and shown only when set. */
export type VariantNutrition = {
  /** Energy in kcal. */
  calories: number | null;
  portionValue: number | null;
  portionUnit: PortionUnit | null;
  /** How many people the size serves. */
  serves: number | null;
};

const UNIT_LABELS: Record<PortionUnit, Record<'ar' | 'en', string>> = {
  GRAM: { ar: 'جم', en: 'g' },
  ML: { ar: 'مل', en: 'ml' },
  PIECE: { ar: 'قطعة', en: 'pcs' },
};

/** A short portion label such as "250 g" or "٦ قطع"; Arabic for Arabic, the English abbreviation otherwise. */
export function portionLabel(nutrition: Pick<VariantNutrition, 'portionValue' | 'portionUnit'>, language: MenuLanguage): string | null {
  if (!nutrition.portionValue || !nutrition.portionUnit) return null;
  const arabic = language === 'ar';
  const value = new Intl.NumberFormat(arabic ? 'ar-EG' : 'en').format(nutrition.portionValue);
  if (nutrition.portionUnit === 'PIECE' && arabic) return `${value} ${nutrition.portionValue === 1 ? 'قطعة' : nutrition.portionValue <= 10 ? 'قطع' : 'قطعة'}`;
  return `${value} ${UNIT_LABELS[nutrition.portionUnit][arabic ? 'ar' : 'en']}`;
}

export function hasNutrition(nutrition: VariantNutrition): boolean {
  return nutrition.calories !== null || nutrition.portionValue !== null || nutrition.serves !== null;
}
