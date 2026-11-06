import { describe, expect, it } from 'vitest';
import { menuDescription, menuName, portionLabel } from '../src/menu-languages.js';
import { createItemSchema, itemTranslationsSchema } from '../src/menus.js';
import { updateRestaurantSchema } from '../src/restaurants.js';

const dish = {
  nameAr: 'كشري',
  nameEn: 'Koshary',
  descriptionAr: 'عدس ورز',
  descriptionEn: null,
  translations: { fr: { name: 'Kochari' } },
};

describe('menu text fallbacks', () => {
  it('uses the language’s own text, then English, then Arabic', () => {
    expect(menuName(dish, 'ar')).toBe('كشري');
    expect(menuName(dish, 'en')).toBe('Koshary');
    expect(menuName(dish, 'fr')).toBe('Kochari');
    expect(menuName(dish, 'de')).toBe('Koshary');
    expect(menuName({ ...dish, nameEn: null }, 'de')).toBe('كشري');
    // No French description: English is missing too, so Arabic.
    expect(menuDescription(dish, 'fr')).toBe('عدس ورز');
    expect(menuDescription(dish, 'en')).toBe('عدس ورز');
  });

  it('keeps unnamed sizes unnamed', () => {
    expect(menuName({ nameAr: null, nameEn: null, translations: {} }, 'fr')).toBeNull();
  });
});

describe('translations input', () => {
  it('drops blank fields and languages, and rejects unknown languages', () => {
    expect(itemTranslationsSchema.parse({ fr: { name: ' Kochari ', description: '' }, de: { name: '' } })).toEqual({ fr: { name: 'Kochari' } });
    expect(itemTranslationsSchema.safeParse({ xx: { name: 'nope' } }).success).toBe(false);
    expect(itemTranslationsSchema.safeParse({ fr: { name: 'a'.repeat(101) } }).success).toBe(false);
  });
});

describe('nutrition input', () => {
  const base = { categoryId: '0199f0e2-1b2c-7d3e-8f40-123456789abc', nameAr: 'كشري' };

  it('accepts calories, a portion and servings per size', () => {
    const parsed = createItemSchema.parse({ ...base, variants: [{ pricePiastres: 3500, calories: 650, portionValue: 400, portionUnit: 'GRAM', serves: 1 }] });
    expect(parsed.variants[0]).toMatchObject({ calories: 650, portionValue: 400, portionUnit: 'GRAM', serves: 1 });
  });

  it('needs a portion’s amount and unit together, within limits', () => {
    expect(createItemSchema.safeParse({ ...base, variants: [{ pricePiastres: 1, portionValue: 400 }] }).success).toBe(false);
    expect(createItemSchema.safeParse({ ...base, variants: [{ pricePiastres: 1, portionUnit: 'ML' }] }).success).toBe(false);
    expect(createItemSchema.safeParse({ ...base, variants: [{ pricePiastres: 1, calories: -5 }] }).success).toBe(false);
    expect(createItemSchema.safeParse({ ...base, variants: [{ pricePiastres: 1, serves: 0 }] }).success).toBe(false);
    expect(createItemSchema.safeParse({ ...base, variants: [{ pricePiastres: 1, calories: 1.5 }] }).success).toBe(false);
  });
});

describe('portion labels', () => {
  it('reads naturally in Arabic and abbreviates otherwise', () => {
    expect(portionLabel({ portionValue: 250, portionUnit: 'GRAM' }, 'en')).toBe('250 g');
    expect(portionLabel({ portionValue: 330, portionUnit: 'ML' }, 'fr')).toBe('330 ml');
    expect(portionLabel({ portionValue: 6, portionUnit: 'PIECE' }, 'ar')).toBe('٦ قطع');
    expect(portionLabel({ portionValue: 250, portionUnit: 'GRAM' }, 'ar')).toBe('٢٥٠ جم');
    expect(portionLabel({ portionValue: null, portionUnit: null }, 'en')).toBeNull();
  });
});

describe('restaurant menu languages', () => {
  it('accepts known extra languages once each', () => {
    expect(updateRestaurantSchema.parse({ menuLanguages: ['fr', 'ru'] }).menuLanguages).toEqual(['fr', 'ru']);
    expect(updateRestaurantSchema.safeParse({ menuLanguages: ['fr', 'fr'] }).success).toBe(false);
    // Arabic and English are always there; they are not "extra".
    expect(updateRestaurantSchema.safeParse({ menuLanguages: ['en'] }).success).toBe(false);
  });
});
