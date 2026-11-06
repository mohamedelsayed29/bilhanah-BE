// Feedback and reviews (docs/REVIEWS.md): the constants, display rules and types diners' pages
// use. Free of zod, so the website's public menu and tracking page can import it without shipping
// zod to diners. The request schemas live in reviews.ts.

import type { ImageSet } from './media.js';

/** The extra 1–5 ratings a restaurant may ask for, besides the overall one. */
export const REVIEW_SUB_RATINGS = ['food', 'service', 'value', 'speed', 'cleanliness', 'atmosphere'] as const;
export type ReviewSubRating = (typeof REVIEW_SUB_RATINGS)[number];

export const REVIEW_SUB_RATING_LABELS: Record<ReviewSubRating, [string, string]> = {
  food: ['الأكل', 'Food'],
  service: ['الخدمة', 'Service'],
  value: ['السعر مقابل القيمة', 'Value'],
  speed: ['السرعة', 'Speed'],
  cleanliness: ['النظافة', 'Cleanliness'],
  atmosphere: ['الجو', 'Atmosphere'],
};

/** When the tracking page invites a review: once the order is ready, or once it is completed. */
export const REVIEW_ASK_AFTER = ['READY', 'COMPLETED'] as const;
export type ReviewAskAfter = (typeof REVIEW_ASK_AFTER)[number];

/** THUMBS: up or down per dish (sent as DISH_THUMBS.UP / DOWN); STARS: 1–5 per dish. */
export const DISH_RATING_SCALES = ['THUMBS', 'STARS'] as const;
export type DishRatingScale = (typeof DISH_RATING_SCALES)[number];

/** Thumbs are stored on the 1–5 scale, so averages and rankings work the same for both scales. */
export const DISH_THUMBS = { UP: 5, DOWN: 1 } as const;

/**
 * AUTO: reviews at or above publishMinStars are published at once, others wait for moderation.
 * MANUAL: every review waits. NEVER: nothing is public (the publish route refuses).
 */
export const REVIEW_PUBLISH_MODES = ['AUTO', 'MANUAL', 'NEVER'] as const;
export type ReviewPublishMode = (typeof REVIEW_PUBLISH_MODES)[number];

/** How a diner's name appears on public reviews. */
export const REVIEW_DISPLAY_NAMES = ['FIRST_NAME_INITIAL', 'FIRST_NAME', 'ANONYMOUS'] as const;
export type ReviewDisplayNameMode = (typeof REVIEW_DISPLAY_NAMES)[number];

/** PENDING waits for moderation (or is kept private under NEVER); HIDDEN was hidden by a moderator, with a reason. */
export const REVIEW_STATUSES = ['PENDING', 'PUBLISHED', 'HIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Following up an unhappy diner. Reviews below alertBelowStars open one automatically. */
export const REVIEW_FOLLOW_UP_STATUSES = ['OPEN', 'CONTACTED', 'RESOLVED'] as const;
export type ReviewFollowUpStatus = (typeof REVIEW_FOLLOW_UP_STATUSES)[number];

/** ORDER: verified by the order's tracking link. TABLE / MENU: unverified feedback from a table QR or the menu. */
export const REVIEW_SOURCES = ['ORDER', 'TABLE', 'MENU'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const REVIEW_TAG_SENTIMENTS = ['POSITIVE', 'NEGATIVE'] as const;
export type ReviewTagSentiment = (typeof REVIEW_TAG_SENTIMENTS)[number];

export type ReviewTag = { code: string; nameAr: string; nameEn: string | null; sentiment: ReviewTagSentiment };

export const DEFAULT_REVIEW_TAGS: readonly ReviewTag[] = [
  { code: 'DELICIOUS', nameAr: 'الأكل حلو', nameEn: 'Delicious', sentiment: 'POSITIVE' },
  { code: 'FAST', nameAr: 'سريع', nameEn: 'Fast', sentiment: 'POSITIVE' },
  { code: 'FRIENDLY_STAFF', nameAr: 'الطاقم لطيف', nameEn: 'Friendly staff', sentiment: 'POSITIVE' },
  { code: 'GOOD_VALUE', nameAr: 'سعره حلو', nameEn: 'Good value', sentiment: 'POSITIVE' },
  { code: 'CLEAN', nameAr: 'نظيف', nameEn: 'Clean', sentiment: 'POSITIVE' },
  { code: 'COLD_FOOD', nameAr: 'الأكل وصل بارد', nameEn: 'Cold food', sentiment: 'NEGATIVE' },
  { code: 'SLOW', nameAr: 'اتأخر', nameEn: 'Slow', sentiment: 'NEGATIVE' },
  { code: 'WRONG_ORDER', nameAr: 'الطلب غلط', nameEn: 'Wrong order', sentiment: 'NEGATIVE' },
  { code: 'SMALL_PORTION', nameAr: 'الكمية قليلة', nameEn: 'Small portion', sentiment: 'NEGATIVE' },
  { code: 'RUDE_STAFF', nameAr: 'معاملة وحشة', nameEn: 'Rude staff', sentiment: 'NEGATIVE' },
];

export const REVIEW_LIMITS = {
  commentLength: 1000,
  nameLength: 40,
  replyLength: 1000,
  noteLength: 500,
  hideReasonLength: 300,
  /** Owner-editable quick chips. */
  tags: 20,
  tagNameLength: 30,
  /** Chips a diner may pick on one review. */
  tagsPerReview: 10,
  photosPerReview: 3,
  /** Photo uploads per order (so a diner can replace photos, but not fill storage). */
  photoUploadsPerOrder: 10,
  /** An order can be reviewed up to this many days after it was placed. */
  reviewWithinDays: 30,
  /** Unverified feedback: per IP, per restaurant, per day. */
  feedbackPerDay: 5,
  maxEditWindowHours: 720,
  /** Stats and dish reports cover at most this many days. */
  statsDays: 366,
  /** CSV export rows. */
  exportRows: 10_000,
} as const;

/** Reviews this many stars or fewer count as unhappy diners in the stats (followed-up share). */
export const UNHAPPY_MAX_STARS = 2;

/**
 * The name shown on a public review, or null for "Guest" (ضيف). FIRST_NAME_INITIAL: "Mona Ahmed" →
 * "Mona A.", "منى أحمد" → "منى أ."; FIRST_NAME: "Mona"; ANONYMOUS: null. Arabic compound first
 * names ("عبد الرحمن", "أبو بكر") stay whole. Digits and symbols are dropped, so a phone number
 * typed as a name never shows.
 */
export function reviewDisplayName(name: string | null | undefined, mode: ReviewDisplayNameMode): string | null {
  if (mode === 'ANONYMOUS' || !name) return null;
  const words = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\s'’-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[-'’]+|[-'’]+$/g, ''))
    .filter(Boolean);
  if (!words.length) return null;
  // "عبد الله", "أبو بكر", "Abd El Rahman": the prefix belongs to the first name.
  const prefixes = new Set(['عبد', 'ابو', 'أبو', 'abd', 'abdel', 'abu', 'abo']);
  const joiners = new Set(['ال', 'el', 'al']);
  let take = 1;
  if (words.length > 1 && prefixes.has(words[0]!.toLowerCase())) {
    take = 2;
    if (words.length > 2 && joiners.has(words[1]!.toLowerCase())) take = 3;
  }
  const first = words.slice(0, take).join(' ').slice(0, 30);
  if (mode === 'FIRST_NAME' || words.length <= take) return first;
  const initial = [...words.at(-1)!][0]!.toLocaleUpperCase();
  return `${first} ${initial}.`;
}

/** A dish's rating on the public menu (null below menuMinCount or when ratings are not shown). */
export type MenuItemRating = {
  /** 1–5, one decimal. */
  average: number;
  count: number;
  /** Share of ratings of 4 or 5 (thumbs up), 0–1: what a thumbs scale shows ("92% liked it"). */
  positiveShare: number;
};

/** What the public menu needs to know about reviews; null when the plan or the owner turned them off. */
export type PublicReviewsInfo = {
  /** The reviews page and the dish badges are shown (showOnMenu, and publishing is not NEVER). */
  page: boolean;
  /** Feedback without an order is accepted (allowUnverified). */
  feedback: boolean;
  dishRatingScale: DishRatingScale;
};

/** 1–5 counts. */
export type RatingDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

/** Computed from every published review (of the branch, when one is chosen). */
export type PublicReviewSummary = {
  average: number | null;
  count: number;
  distribution: RatingDistribution;
  verifiedCount: number;
  subRatings: Partial<Record<ReviewSubRating, number>>;
  /** How reviews get published, for the page to say so: AUTO with minStars 1 publishes everything at once. */
  policy: { mode: 'AUTO' | 'MANUAL'; minStars: number };
};

export type PublicReview = {
  id: string;
  overall: number;
  ratings: Partial<Record<ReviewSubRating, number>>;
  tags: ReviewTag[];
  comment: string | null;
  /** null: show "Guest" / "ضيف". */
  displayName: string | null;
  verified: boolean;
  branch: { slug: string; name: string };
  dishes: { nameAr: string; nameEn: string | null; rating: number }[];
  photos: ImageSet[];
  reply: { text: string; at: string } | null;
  createdAt: string;
  publishedAt: string;
};

/** GET /v1/public/restaurants/:subdomain/reviews */
export type PublicReviewsPage = {
  restaurant: { name: string; subdomain: string };
  /** The branch the summary and reviews are limited to; null for the whole restaurant. */
  branch: { slug: string; name: string } | null;
  summary: PublicReviewSummary;
  dishRatingScale: DishRatingScale;
  items: PublicReview[];
  total: number;
  page: number;
  pageSize: number;
};

// --- The diner's form (tracking page) -------------------------------------------------------------

/**
 * OPEN: the diner may review. NOT_YET: the order has not reached askAfter. EDITABLE: reviewed and
 * still within the edit window. LOCKED: reviewed, window over. CLOSED: rejected or cancelled, or
 * too old to review. UNAVAILABLE: the plan or the owner does not ask for reviews.
 */
export const REVIEW_ELIGIBILITY = ['OPEN', 'NOT_YET', 'EDITABLE', 'LOCKED', 'CLOSED', 'UNAVAILABLE'] as const;
export type ReviewEligibility = (typeof REVIEW_ELIGIBILITY)[number];

export type ReviewForm = {
  restaurant: { name: string; subdomain: string };
  branch: { slug: string; name: string };
  subRatings: ReviewSubRating[];
  dishRatings: boolean;
  dishRatingScale: DishRatingScale;
  /** A comment is required when the overall rating is below this (0: never). */
  commentRequiredBelow: number;
  photos: boolean;
  maxPhotos: number;
  tags: ReviewTag[];
  /** How the diner's name will appear publicly. */
  displayName: ReviewDisplayNameMode;
  /** The order's dishes, to rate one by one (dishRatings). */
  dishes: { orderItemId: string; nameAr: string; nameEn: string | null; variantNameAr: string | null; variantNameEn: string | null; quantity: number }[];
};

/** PUBLISHED: public now. PENDING: waiting for the restaurant. NOT_PUBLIC: the restaurant keeps reviews private (or hid it). */
export type ReviewOutcome = {
  status: 'PUBLISHED' | 'PENDING' | 'NOT_PUBLIC';
  /** Invite the diner to review the branch on Google too (googlePrompt, at or above googleMinStars). */
  google: { url: string } | null;
};

/** The diner's own review, as they wrote it. Photos are private until published, so they carry no public URL. */
export type DinerReview = {
  overall: number;
  ratings: Partial<Record<ReviewSubRating, number>>;
  dishes: { orderItemId: string; rating: number }[];
  tags: string[];
  comment: string | null;
  photoIds: string[];
  name: string | null;
  /** The diner gave a phone number (it is never sent back). */
  hasContact: boolean;
  language: 'ar' | 'en';
  createdAt: string;
  updatedAt: string;
};

/** GET /v1/public/orders/:token/review */
export type DinerReviewState = {
  eligibility: ReviewEligibility;
  /** For OPEN and EDITABLE. */
  form: ReviewForm | null;
  review: DinerReview | null;
  editableUntil: string | null;
  outcome: ReviewOutcome | null;
};

/** PUT /v1/public/orders/:token/review */
export type DinerReviewResult = { review: DinerReview; outcome: ReviewOutcome; editableUntil: string };

/** POST /v1/public/restaurants/:subdomain/feedback (unverified feedback cannot be edited). */
export type FeedbackResult = { outcome: ReviewOutcome };

/** POST /v1/public/orders/:token/review/photos: a private photo to send in photoIds. */
export type ReviewPhotoUpload = { id: string; width: number; height: number };
