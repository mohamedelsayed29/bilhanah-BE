import { normalize } from '../faq/faq-search.js';

/**
 * Whether a message asks for a person rather than an answer: "عاوز اكلم خدمة العملاء", "كلموني",
 * "talk to a human", "customer service"... Matched on the normalized text (no diacritics, one alef).
 */
const ARABIC_TARGETS = ['خدمه العملاء', 'خدمه عملاء', 'الدعم الفني', 'فريق الدعم', 'الدعم', 'السابورت', 'سابورت', 'موظف', 'ممثل', 'حد من الفريق', 'حد حقيقي', 'بني ادم', 'انسان', 'بشري'];
const ARABIC_VERBS = ['اكلم', 'كلم', 'اتكلم', 'تواصل', 'اتواصل', 'توصلني', 'وصلني', 'محتاج', 'عاوز', 'عايز', 'ابغي', 'اريد', 'ممكن'];
const ENGLISH = /\b(customer (service|support|care)|live (chat|agent|support)|(talk|speak|chat|connect)( me)? (to|with) (a |an |the |your )?(human|person|agent|someone|somebody|support|representative|team|staff)|real (person|human)|human agent|representative)\b/;

export function wantsHuman(text: string): boolean {
  const value = normalize(text);
  if (!value) return false;
  if (ENGLISH.test(value)) return true;
  if (value.includes('خدمه العملاء') || value.includes('خدمه عملاء')) return true;
  // A verb of reaching someone together with who: "عاوز اكلم الدعم", "محتاج حد من الفريق".
  return ARABIC_VERBS.some((verb) => value.includes(verb)) && ARABIC_TARGETS.some((target) => value.includes(target));
}
