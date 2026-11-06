import { isExtraMenuLanguage, type Translations } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';

/**
 * The stored translations JSON, keeping only known languages and string fields.
 * Written through the contracts' translations schemas, so this is a safety net
 * against hand-edited rows rather than the main validation.
 */
export function asTranslations<Field extends string = 'name'>(value: Prisma.JsonValue): Translations<Field> {
  const result: Translations<Field> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [language, texts] of Object.entries(value)) {
    if (!isExtraMenuLanguage(language) || !texts || typeof texts !== 'object' || Array.isArray(texts)) continue;
    const kept = Object.fromEntries(Object.entries(texts).filter(([, text]) => typeof text === 'string' && text));
    if (Object.keys(kept).length) result[language] = kept as Partial<Record<Field, string>>;
  }
  return result;
}
