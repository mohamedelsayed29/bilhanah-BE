/**
 * FAQ search without a search engine: the published FAQs of a language are few (tens to hundreds), so
 * they are scored in memory. Arabic is normalized (diacritics, alef/ya/ta marbuta forms, Arabic-Indic
 * digits) so "إضافة" finds "اضافة", and a word matches by prefix so "طلب" finds "طلبات".
 */

const DIACRITICS = /[ً-ٰٟـ]/g;

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words too common to tell questions apart. */
const STOP_WORDS = new Set([
  'ازاي', 'ايه', 'في', 'من', 'على', 'علي', 'ال', 'او', 'و', 'لو', 'هل', 'عايز', 'عاوز', 'اعمل', 'انا', 'مش', 'ده', 'دي', 'اللي', 'مع', 'بس', 'كل',
  'how', 'do', 'i', 'can', 'the', 'a', 'an', 'to', 'my', 'is', 'of', 'for', 'and', 'in', 'on', 'what', 'with', 'it', 'me', 'does',
]);

export function terms(query: string): string[] {
  const words = normalize(query).split(' ').filter(Boolean);
  const useful = words.filter((word) => !STOP_WORDS.has(word) && word.length > 1);
  return [...new Set(useful.length ? useful : words)];
}

export type Searchable = { question: string; answer: string; keywords: string[]; sortOrder: number };

/** How well an article matches: keywords and the question weigh more than the answer. 0 is no match. */
export function score(article: Searchable, queryTerms: string[]): number {
  if (!queryTerms.length) return 0;
  const question = normalize(article.question).split(' ');
  const keywords = article.keywords.flatMap((keyword) => normalize(keyword).split(' '));
  const answer = normalize(article.answer).split(' ');
  const hit = (words: string[], term: string) => words.some((word) => word === term || (term.length >= 3 && word.startsWith(term)));
  let total = 0;
  let matched = 0;
  for (const term of queryTerms) {
    const value = (hit(keywords, term) ? 4 : 0) + (hit(question, term) ? 3 : 0) + (hit(answer, term) ? 1 : 0);
    if (value > 0) matched += 1;
    total += value;
  }
  // Every term found counts for more than one term found many times.
  return total === 0 ? 0 : total + (matched / queryTerms.length) * 5;
}

export function search<T extends Searchable>(articles: T[], query: string, limit = 8): T[] {
  const queryTerms = terms(query);
  return articles
    .map((article) => ({ article, value: score(article, queryTerms) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.article.sortOrder - b.article.sortOrder)
    .slice(0, limit)
    .map((entry) => entry.article);
}
