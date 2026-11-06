import { z } from 'zod';
import {
  DISH_RATING_SCALES,
  type DishRatingScale,
  REVIEW_ASK_AFTER,
  REVIEW_DISPLAY_NAMES,
  REVIEW_FOLLOW_UP_STATUSES,
  REVIEW_LIMITS,
  REVIEW_PUBLISH_MODES,
  REVIEW_STATUSES,
  REVIEW_SUB_RATINGS,
  REVIEW_TAG_SENTIMENTS,
  DEFAULT_REVIEW_TAGS,
  type RatingDistribution,
  type ReviewAskAfter,
  type ReviewDisplayNameMode,
  type ReviewFollowUpStatus,
  type ReviewPublishMode,
  type ReviewSource,
  type ReviewStatus,
  type ReviewSubRating,
  type ReviewTag,
} from './review-display.js';
import { BRANCH_SLUG_PATTERN } from './branches.js';

/**
 * Feedback and reviews (docs/REVIEWS.md): request schemas and the restaurant's views. Ratings are
 * integers 1–5; dish thumbs travel as DISH_THUMBS.UP (5) / DOWN (1). Contact phones reach only
 * callers holding reviews.respond (they follow diners up) and never a public response.
 */

export const REVIEW_ERROR_CODES = {
  /** 409: the plan has no reviews, or the restaurant has no access. */
  UNAVAILABLE: 'REVIEWS_UNAVAILABLE',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  /** 409: the order cannot be reviewed now. details: { eligibility } (see REVIEW_ELIGIBILITY) */
  NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  /** 403: the review was written in another browser (its editKey does not match). */
  EDIT_FORBIDDEN: 'REVIEW_EDIT_FORBIDDEN',
  /** 400: a comment is required below commentRequiredBelow stars. details: { below } */
  COMMENT_REQUIRED: 'REVIEW_COMMENT_REQUIRED',
  /** 400: a dish rating for a line that is not on this order (or twice). details: { orderItemId } */
  DISH_NOT_IN_ORDER: 'REVIEW_DISH_NOT_IN_ORDER',
  /** 400: a rating the restaurant does not ask for (a sub-rating, dish ratings, a thumb that is not 1 or 5). details: { field } */
  RATING_NOT_ASKED: 'REVIEW_RATING_NOT_ASKED',
  /** 400: a tag that is not one of the restaurant's. details: { tag } */
  TAG_UNKNOWN: 'REVIEW_TAG_UNKNOWN',
  /** 400: a photo id that was not uploaded for this order. details: { photoId } */
  PHOTO_NOT_FOUND: 'REVIEW_PHOTO_NOT_FOUND',
  /** 400: the restaurant does not take photos. */
  PHOTOS_OFF: 'REVIEW_PHOTOS_OFF',
  /** 409: too many photo uploads for this order. details: { limit } */
  PHOTO_LIMIT: 'REVIEW_PHOTO_LIMIT',
  /** 400: a phone number needs contactConsent. */
  CONTACT_CONSENT_REQUIRED: 'REVIEW_CONTACT_CONSENT_REQUIRED',
  /** 400: the assignee is not an active account of this restaurant that can follow this review up. */
  ASSIGNEE_INVALID: 'REVIEW_ASSIGNEE_INVALID',
  /** 409: publishMode is NEVER: nothing can be published. */
  PUBLISHING_OFF: 'REVIEW_PUBLISHING_OFF',
  /** 409: the restaurant does not take feedback without an order. */
  FEEDBACK_UNAVAILABLE: 'REVIEW_FEEDBACK_UNAVAILABLE',
  /** 404: the restaurant shows no reviews publicly. */
  NOT_PUBLIC: 'REVIEWS_NOT_PUBLIC',
} as const;

// --- Settings -------------------------------------------------------------------------------------

const stars = z.number().int().min(1).max(5);

export const reviewTagSchema = z.strictObject({
  code: z.string().trim().toUpperCase().min(1).max(30).regex(/^[A-Z0-9_]+$/, 'Use letters, digits and _.'),
  nameAr: z.string().trim().min(1).max(REVIEW_LIMITS.tagNameLength),
  nameEn: z.string().trim().max(REVIEW_LIMITS.tagNameLength).nullable().optional().transform((value) => value || null),
  sentiment: z.enum(REVIEW_TAG_SENTIMENTS),
});

/** PUT /v1/reviews/settings: any of the settings; the others stay. */
export const reviewSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  askAfter: z.enum(REVIEW_ASK_AFTER).optional(),
  allowUnverified: z.boolean().optional(),
  subRatings: z.array(z.enum(REVIEW_SUB_RATINGS)).max(REVIEW_SUB_RATINGS.length).transform((list) => REVIEW_SUB_RATINGS.filter((key) => list.includes(key))).optional(),
  dishRatings: z.boolean().optional(),
  dishRatingScale: z.enum(DISH_RATING_SCALES).optional(),
  /** 0: never required. */
  commentRequiredBelow: z.number().int().min(0).max(5).optional(),
  photos: z.boolean().optional(),
  tags: z
    .array(reviewTagSchema)
    .max(REVIEW_LIMITS.tags)
    .refine((tags) => new Set(tags.map((tag) => tag.code)).size === tags.length, 'Each tag code once')
    .optional(),
  publishMode: z.enum(REVIEW_PUBLISH_MODES).optional(),
  publishMinStars: stars.optional(),
  showOnMenu: z.boolean().optional(),
  menuMinCount: z.number().int().min(1).max(1000).optional(),
  googlePrompt: z.boolean().optional(),
  googleMinStars: stars.optional(),
  /** Reviews below this alert the restaurant (0 or 1: never). */
  alertBelowStars: z.number().int().min(0).max(5).optional(),
  /** 0: reviews cannot be edited. */
  editWindowHours: z.number().int().min(0).max(REVIEW_LIMITS.maxEditWindowHours).optional(),
  displayName: z.enum(REVIEW_DISPLAY_NAMES).optional(),
});

export type ReviewSettings = {
  enabled: boolean;
  askAfter: ReviewAskAfter;
  allowUnverified: boolean;
  subRatings: ReviewSubRating[];
  dishRatings: boolean;
  dishRatingScale: DishRatingScale;
  commentRequiredBelow: number;
  photos: boolean;
  tags: ReviewTag[];
  publishMode: ReviewPublishMode;
  publishMinStars: number;
  showOnMenu: boolean;
  menuMinCount: number;
  googlePrompt: boolean;
  googleMinStars: number;
  alertBelowStars: number;
  editWindowHours: number;
  displayName: ReviewDisplayNameMode;
  updatedAt: string | null;
};

export const DEFAULT_REVIEW_SETTINGS: Omit<ReviewSettings, 'updatedAt'> = {
  enabled: false,
  askAfter: 'COMPLETED',
  allowUnverified: false,
  subRatings: ['food', 'service'],
  dishRatings: true,
  dishRatingScale: 'THUMBS',
  commentRequiredBelow: 3,
  photos: true,
  tags: [...DEFAULT_REVIEW_TAGS],
  publishMode: 'AUTO',
  publishMinStars: 1,
  showOnMenu: false,
  menuMinCount: 3,
  googlePrompt: true,
  googleMinStars: 4,
  alertBelowStars: 3,
  editWindowHours: 24,
  displayName: 'FIRST_NAME_INITIAL',
};

// --- Diners ---------------------------------------------------------------------------------------

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((value) => (value === '' ? null : value)).nullable().optional();

const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));

const reviewBody = {
  overall: stars,
  ratings: z.partialRecord(z.enum(REVIEW_SUB_RATINGS), stars).optional(),
  tags: z.array(z.string().trim().toUpperCase().max(30)).max(REVIEW_LIMITS.tagsPerReview).transform((list) => [...new Set(list)]).optional(),
  comment: optionalText(REVIEW_LIMITS.commentLength),
  name: optionalText(REVIEW_LIMITS.nameLength),
  /** Kept only with contactConsent; seen only by the restaurant's staff who follow reviews up. */
  contactPhone: z.union([z.literal('').transform(() => null), phoneSchema]).nullable().optional(),
  contactConsent: z.boolean().default(false),
  language: z.enum(['ar', 'en']).default('ar'),
};

/** PUT /v1/public/orders/:token/review: creates the order's review, or edits it within the edit window. */
export const dinerReviewSchema = z.strictObject({
  ...reviewBody,
  dishes: z
    .array(z.strictObject({ orderItemId: z.uuid(), rating: stars }))
    .max(50)
    .refine((rows) => new Set(rows.map((row) => row.orderItemId)).size === rows.length, 'Each dish once')
    .optional(),
  photoIds: z.array(z.uuid()).max(REVIEW_LIMITS.photosPerReview).transform((list) => [...new Set(list)]).optional(),
  /**
   * A random key the browser keeps (16–128 characters). A review written with one can only be
   * edited by sending the same key, so a shared tracking link cannot change someone's review.
   */
  editKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
});

/** POST /v1/public/restaurants/:subdomain/feedback: unverified feedback (no dishes, no photos). */
export const feedbackSchema = z.strictObject({
  ...reviewBody,
  /** The branch's slug (main branch by default); a table code decides the branch by itself. */
  branch: z.string().trim().toLowerCase().max(40).regex(BRANCH_SLUG_PATTERN).optional(),
  tableCode: z.string().trim().min(4).max(16).optional(),
  /** Honeypot: people leave it empty. */
  website: z.string().max(200).optional(),
});

export const publicReviewsQuerySchema = z.strictObject({
  branch: z.string().trim().toLowerCase().max(40).regex(BRANCH_SLUG_PATTERN).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

// --- The restaurant -------------------------------------------------------------------------------

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

const filters = {
  branchId: z.uuid().optional(),
  /** One or more star ratings, comma-separated: stars=1,2 */
  stars: z
    .string()
    .regex(/^[1-5](,[1-5])*$/)
    .transform((value) => [...new Set(value.split(',').map(Number))])
    .optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  verified: booleanQuery.optional(),
  hasComment: booleanQuery.optional(),
  /** NONE: no follow-up. */
  followUp: z.enum([...REVIEW_FOLLOW_UP_STATUSES, 'NONE']).optional(),
  /** Local days (restaurant time zone), both inclusive. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().trim().min(1).max(100).optional(),
};

export const reviewsQuerySchema = z.strictObject({
  ...filters,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const reviewsExportQuerySchema = z.strictObject(filters);

export const reviewStatsQuerySchema = z.strictObject({
  branchId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(REVIEW_LIMITS.statsDays).default(30),
});

export const reviewReplySchema = z.strictObject({ text: z.string().trim().min(1).max(REVIEW_LIMITS.replyLength) });

export const hideReviewSchema = z.strictObject({ reason: z.string().trim().min(3).max(REVIEW_LIMITS.hideReasonLength) });

export const reviewFollowUpSchema = z.strictObject({
  status: z.enum(REVIEW_FOLLOW_UP_STATUSES),
  /** Internal; kept in the history. */
  note: optionalText(REVIEW_LIMITS.noteLength),
  /** Who follows up (an account of the restaurant holding reviews.respond at the review's branch); null clears. Omitted keeps it. */
  assigneeId: z.uuid().nullable().optional(),
});

export type ReviewFollowUp = {
  status: ReviewFollowUpStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  updatedAt: string;
};

/** One row of the inbox (and the realtime events, which never carry the contact phone). */
export type OwnerReviewListItem = {
  id: string;
  branchId: string;
  branchName: string;
  orderId: string | null;
  orderNumber: number | null;
  verified: boolean;
  source: ReviewSource;
  tableLabel: string | null;
  overall: number;
  ratings: Partial<Record<ReviewSubRating, number>>;
  tags: ReviewTag[];
  comment: string | null;
  /** As the diner typed it. */
  authorName: string | null;
  /** As it shows publicly (null: "Guest"). */
  displayName: string | null;
  /** The diner agreed to be contacted and left a number. */
  hasContact: boolean;
  /** Only for callers holding reviews.respond. */
  contactPhone: string | null;
  language: 'ar' | 'en';
  status: ReviewStatus;
  publishedAt: string | null;
  hidden: { reason: string; at: string; byName: string | null } | null;
  reply: { text: string; at: string; updatedAt: string; byName: string | null } | null;
  followUp: ReviewFollowUp | null;
  /** Below alertBelowStars. */
  lowRating: boolean;
  dishCount: number;
  photoCount: number;
  /** The diner changed it after sending. */
  edited: boolean;
  createdAt: string;
  updatedAt: string;
};

export const REVIEW_EVENT_KINDS = ['CREATED', 'EDITED', 'PUBLISHED', 'HIDDEN', 'REPLIED', 'REPLY_REMOVED', 'FOLLOW_UP'] as const;
export type ReviewEventKind = (typeof REVIEW_EVENT_KINDS)[number];

export type ReviewEvent = {
  kind: ReviewEventKind;
  at: string;
  actorName: string | null;
  /** FOLLOW_UP: the status set, the assignee and the internal note. HIDDEN: the reason. EDITED: the overall rating before. */
  followUpStatus: ReviewFollowUpStatus | null;
  assigneeName: string | null;
  note: string | null;
  previousOverall: number | null;
};

export type OwnerReviewPhoto = {
  id: string;
  width: number;
  height: number;
  /** Public renditions while the review is published; empty otherwise (use privateUrl). */
  sources: { width: number; url: string }[];
  /** API path streaming the photo to staff with reviews.view (send the access token). */
  privateUrl: string;
};

/** GET /v1/reviews/:id */
export type OwnerReview = OwnerReviewListItem & {
  order: {
    id: string;
    number: number;
    type: 'DINE_IN' | 'PICKUP';
    placedAt: string;
    subtotalPiastres: number;
    items: { id: string; nameAr: string; nameEn: string | null; variantNameAr: string | null; variantNameEn: string | null; quantity: number; lineTotalPiastres: number }[];
  } | null;
  dishes: { orderItemId: string | null; menuItemId: string | null; nameAr: string; nameEn: string | null; rating: number }[];
  photos: OwnerReviewPhoto[];
  history: ReviewEvent[];
};

/**
 * Realtime (/owner namespace): only sockets whose account holds reviews.view receive these, in the
 * restaurant's (or their branch's) reviews room. The review never carries the contact phone here.
 */
export const REVIEW_EVENTS = {
  CREATED: 'review.created',
  UPDATED: 'review.updated',
} as const;

export type ReviewRealtimeEvent = { review: OwnerReviewListItem };

export const reviewAssigneesQuerySchema = z.strictObject({ branchId: z.uuid().optional() });

/** Who may be assigned a follow-up (GET /v1/reviews/assignees). */
export type ReviewAssignee = { id: string; fullName: string; role: string; branchId: string | null };

/** GET /v1/reviews/stats: every review of the period (published or not), in the restaurant's time zone. */
export type ReviewStats = {
  days: number;
  count: number;
  average: number | null;
  distribution: RatingDistribution;
  /** Per local day, oldest first; days without reviews have count 0 and average null. */
  series: { day: string; count: number; average: number | null }[];
  subRatings: Partial<Record<ReviewSubRating, { average: number; count: number }>>;
  tags: (ReviewTag & { count: number })[];
  /** Dishes with at least 3 ratings, best first. */
  dishRanking: ReviewDishRow[];
  /** Replied reviews / all reviews (null without reviews). */
  replyRate: number | null;
  /** Minutes from review to first reply, median of replied reviews. */
  medianReplyMinutes: number | null;
  /** Reviews of UNHAPPY_MAX_STARS or fewer, and the share contacted or resolved. */
  unhappy: number;
  unhappyFollowedUpShare: number | null;
  verifiedShare: number | null;
  /** Waiting for moderation right now (whatever the period). */
  pending: number;
  /** Follow-ups still open right now. */
  openFollowUps: number;
};

export type ReviewDishRow = {
  menuItemId: string | null;
  nameAr: string;
  nameEn: string | null;
  average: number;
  count: number;
  /** Ratings of 4–5 and of 1–2, as shares 0–1. */
  upShare: number;
  downShare: number;
};

/** GET /v1/reviews/dishes */
export type ReviewDishReport = {
  days: number;
  dishRatingScale: DishRatingScale;
  dishes: (ReviewDishRow & { recentComments: { reviewId: string; overall: number; rating: number; comment: string; at: string }[] })[];
};
