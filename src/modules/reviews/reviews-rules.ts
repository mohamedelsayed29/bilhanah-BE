import {
  DEFAULT_REVIEW_SETTINGS,
  DEFAULT_REVIEW_TAGS,
  REVIEW_LIMITS,
  REVIEW_SUB_RATINGS,
  type ReviewEligibility,
  type ReviewOutcome,
  type ReviewSettings,
  type ReviewStatus,
  type ReviewSubRating,
  type ReviewTag,
} from '@bilhanah/contracts';
import type { OrderStatus, ReviewSettings as ReviewSettingsRow } from '@bilhanah/database';

// The rules of docs/REVIEWS.md, free of I/O so they can be tested on their own.

export type ReviewRules = Omit<ReviewSettings, 'updatedAt'>;

const TAG_SENTIMENTS = new Set(['POSITIVE', 'NEGATIVE']);

/** The owner's tags, or the defaults; malformed entries (never written by the API) are skipped. */
export function tagsFrom(value: unknown): ReviewTag[] {
  if (!Array.isArray(value)) return [...DEFAULT_REVIEW_TAGS];
  return value.flatMap((entry) => {
    const tag = entry as Partial<ReviewTag> | null;
    return tag && typeof tag.code === 'string' && typeof tag.nameAr === 'string' && TAG_SENTIMENTS.has(String(tag.sentiment))
      ? [{ code: tag.code, nameAr: tag.nameAr, nameEn: typeof tag.nameEn === 'string' ? tag.nameEn : null, sentiment: tag.sentiment! }]
      : [];
  });
}

/** The restaurant's settings, or the defaults when it never saved any. */
export function rulesFrom(row: ReviewSettingsRow | null): ReviewRules {
  if (!row) return { ...DEFAULT_REVIEW_SETTINGS, tags: [...DEFAULT_REVIEW_SETTINGS.tags], subRatings: [...DEFAULT_REVIEW_SETTINGS.subRatings] };
  return {
    enabled: row.enabled,
    askAfter: row.askAfter,
    allowUnverified: row.allowUnverified,
    subRatings: REVIEW_SUB_RATINGS.filter((key) => row.subRatings.includes(key)),
    dishRatings: row.dishRatings,
    dishRatingScale: row.dishRatingScale,
    commentRequiredBelow: row.commentRequiredBelow,
    photos: row.photos,
    tags: tagsFrom(row.tags),
    publishMode: row.publishMode,
    publishMinStars: row.publishMinStars,
    showOnMenu: row.showOnMenu,
    menuMinCount: row.menuMinCount,
    googlePrompt: row.googlePrompt,
    googleMinStars: row.googleMinStars,
    alertBelowStars: row.alertBelowStars,
    editWindowHours: row.editWindowHours,
    displayName: row.displayName,
  };
}

/**
 * Whether the diner may review the order now. `reviewsOn` is the plan including reviews and the
 * owner asking for them. A diner who already reviewed may edit until the review's own edit window
 * closes (fixed when it was written), and only while reviews are on.
 */
export function reviewEligibility(input: {
  reviewsOn: boolean;
  askAfter: ReviewRules['askAfter'];
  order: { status: OrderStatus; placedAt: Date };
  review: { editableUntil: Date } | null;
  now: Date;
}): ReviewEligibility {
  const { reviewsOn, askAfter, order, review, now } = input;
  if (review) return reviewsOn && now < review.editableUntil ? 'EDITABLE' : 'LOCKED';
  if (!reviewsOn) return 'UNAVAILABLE';
  if (order.status === 'REJECTED' || order.status === 'CANCELLED') return 'CLOSED';
  if (now.getTime() - order.placedAt.getTime() > REVIEW_LIMITS.reviewWithinDays * 86_400_000) return 'CLOSED';
  const reached = askAfter === 'READY' ? order.status === 'READY' || order.status === 'COMPLETED' : order.status === 'COMPLETED';
  return reached ? 'OPEN' : 'NOT_YET';
}

/**
 * Where a new (or edited) review goes. AUTO publishes at or above publishMinStars and holds the
 * rest for moderation, the same rule for every rating; MANUAL holds everything; NEVER keeps
 * everything private. A review a moderator hid stays hidden when the diner edits it; any other edit
 * goes through the rule again (a manually approved review needs approving again).
 */
export function publishDecision(rules: Pick<ReviewRules, 'publishMode' | 'publishMinStars'>, overall: number, current?: ReviewStatus): ReviewStatus {
  if (current === 'HIDDEN') return 'HIDDEN';
  return rules.publishMode === 'AUTO' && overall >= rules.publishMinStars ? 'PUBLISHED' : 'PENDING';
}

/** Public reviews (the page, dish badges) are shown: the plan includes reviews, the owner shows them, and publishing is not NEVER. */
export function showsPublicly(planIncludes: boolean, rules: Pick<ReviewRules, 'showOnMenu' | 'publishMode'>): boolean {
  return planIncludes && rules.showOnMenu && rules.publishMode !== 'NEVER';
}

/** A review photo is public only while its review is published and publishing is not NEVER. */
export function photosPublic(status: ReviewStatus, rules: Pick<ReviewRules, 'publishMode'>): boolean {
  return status === 'PUBLISHED' && rules.publishMode !== 'NEVER';
}

/** Below alertBelowStars (0 or 1: nothing alerts). */
export const isLowRating = (overall: number, alertBelowStars: number) => overall < alertBelowStars;

/** A comment is required below commentRequiredBelow (0: never). */
export const commentRequired = (overall: number, below: number) => below > 0 && overall < below;

/** What the diner is told after sending, and whether to invite them to Google. */
export function outcomeFor(
  status: ReviewStatus,
  overall: number,
  rules: Pick<ReviewRules, 'publishMode' | 'googlePrompt' | 'googleMinStars'>,
  googleReviewUrl: string | null,
): ReviewOutcome {
  const shown = rules.publishMode === 'NEVER' ? 'NOT_PUBLIC' : status === 'PUBLISHED' ? 'PUBLISHED' : status === 'PENDING' ? 'PENDING' : 'NOT_PUBLIC';
  const google = rules.googlePrompt && googleReviewUrl && overall >= rules.googleMinStars ? { url: googleReviewUrl } : null;
  return { status: shown, google };
}

/** Review columns for each sub-rating. */
export const SUB_RATING_COLUMNS = {
  food: 'foodRating',
  service: 'serviceRating',
  value: 'valueRating',
  speed: 'speedRating',
  cleanliness: 'cleanlinessRating',
  atmosphere: 'atmosphereRating',
} as const satisfies Record<ReviewSubRating, string>;

type SubRatingColumns = { [K in (typeof SUB_RATING_COLUMNS)[ReviewSubRating]]: number | null };

/** The sub-ratings a review carries. */
export function ratingsOf(row: SubRatingColumns): Partial<Record<ReviewSubRating, number>> {
  const ratings: Partial<Record<ReviewSubRating, number>> = {};
  for (const key of REVIEW_SUB_RATINGS) {
    const value = row[SUB_RATING_COLUMNS[key]];
    if (value !== null) ratings[key] = value;
  }
  return ratings;
}

/** The columns to write for the given sub-ratings (the others cleared). */
export function ratingColumns(ratings: Partial<Record<ReviewSubRating, number>> | undefined): SubRatingColumns {
  return Object.fromEntries(REVIEW_SUB_RATINGS.map((key) => [SUB_RATING_COLUMNS[key], ratings?.[key] ?? null])) as SubRatingColumns;
}

/** The restaurant's tags for the codes, in the order chosen; codes no longer offered keep the code as their name. */
export function resolveTags(codes: readonly string[], tags: readonly ReviewTag[]): ReviewTag[] {
  return codes.map((code) => tags.find((tag) => tag.code === code) ?? { code, nameAr: code, nameEn: null, sentiment: 'POSITIVE' });
}
