import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_SETTINGS,
  dinerReviewSchema,
  effectivePermissions,
  feedbackSchema,
  GRANTABLE_PERMISSIONS,
  PLAN_FEATURES,
  reviewDisplayName,
  reviewSettingsSchema,
  reviewsQuerySchema,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  uploadMediaQuerySchema,
} from '../src/index.js';

describe('review display names', () => {
  it('shows the first name and an initial by default', () => {
    expect(reviewDisplayName('Mona Ahmed', 'FIRST_NAME_INITIAL')).toBe('Mona A.');
    expect(reviewDisplayName('  mona   ahmed  ali ', 'FIRST_NAME_INITIAL')).toBe('mona A.');
    expect(reviewDisplayName('منى أحمد', 'FIRST_NAME_INITIAL')).toBe('منى أ.');
    expect(reviewDisplayName('Mona', 'FIRST_NAME_INITIAL')).toBe('Mona');
  });

  it('keeps Arabic compound first names whole', () => {
    expect(reviewDisplayName('عبد الرحمن محمد', 'FIRST_NAME_INITIAL')).toBe('عبد الرحمن م.');
    expect(reviewDisplayName('أبو بكر سالم', 'FIRST_NAME')).toBe('أبو بكر');
    expect(reviewDisplayName('Abd El Rahman Mohamed', 'FIRST_NAME_INITIAL')).toBe('Abd El Rahman M.');
    expect(reviewDisplayName('عبد الله', 'FIRST_NAME_INITIAL')).toBe('عبد الله');
  });

  it('shows only the first name, or nothing ("Guest"), as chosen', () => {
    expect(reviewDisplayName('Mona Ahmed', 'FIRST_NAME')).toBe('Mona');
    expect(reviewDisplayName('Mona Ahmed', 'ANONYMOUS')).toBeNull();
    expect(reviewDisplayName(null, 'FIRST_NAME_INITIAL')).toBeNull();
    expect(reviewDisplayName('   ', 'FIRST_NAME')).toBeNull();
  });

  it('never shows digits or symbols (a phone number typed as a name)', () => {
    expect(reviewDisplayName('01012345678', 'FIRST_NAME_INITIAL')).toBeNull();
    expect(reviewDisplayName('Mona 0101 2345', 'FIRST_NAME_INITIAL')).toBe('Mona');
    expect(reviewDisplayName('Mona 🙂 Said!', 'FIRST_NAME_INITIAL')).toBe('Mona S.');
  });
});

describe('review permissions and plans', () => {
  it('gives owners and managers view, respond and moderate; settings to owners', () => {
    for (const permission of ['reviews.view', 'reviews.respond', 'reviews.moderate', 'reviews.settings'] as const) {
      expect(ROLE_PERMISSIONS.OWNER).toContain(permission);
    }
    expect(ROLE_PERMISSIONS.MANAGER).toEqual(expect.arrayContaining(['reviews.view', 'reviews.respond', 'reviews.moderate']));
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain('reviews.settings');
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) expect(ROLE_PERMISSIONS[role].some((permission) => permission.startsWith('reviews.'))).toBe(false);
  });

  it('lets every staff role be granted every reviews permission', () => {
    for (const role of STAFF_ROLES) {
      const all = effectivePermissions(role, ['reviews.view', 'reviews.respond', 'reviews.moderate', 'reviews.settings']);
      expect(all).toEqual(expect.arrayContaining(['reviews.view', 'reviews.respond', 'reviews.moderate', 'reviews.settings']));
      expect(GRANTABLE_PERMISSIONS[role].filter((permission) => permission.startsWith('reviews.')).length + ROLE_PERMISSIONS[role].filter((permission) => permission.startsWith('reviews.')).length).toBe(4);
    }
  });

  it('includes reviews in Menu & Orders and the Full Experience only', () => {
    expect(PLAN_FEATURES.MENU.reviews).toBe(false);
    expect(PLAN_FEATURES.ORDERS.reviews).toBe(true);
    expect(PLAN_FEATURES.ADVANCED.reviews).toBe(true);
  });

  it('does not let restaurants upload review photos through /v1/media', () => {
    expect(uploadMediaQuerySchema.safeParse({ kind: 'ITEM' }).success).toBe(true);
    expect(uploadMediaQuerySchema.safeParse({ kind: 'REVIEW' }).success).toBe(false);
  });
});

describe('review schemas', () => {
  it('takes integer 1–5 ratings and bounded texts', () => {
    expect(dinerReviewSchema.parse({ overall: 5 })).toMatchObject({ overall: 5, contactConsent: false, language: 'ar' });
    for (const overall of [0, 6, 4.5, '5']) expect(dinerReviewSchema.safeParse({ overall }).success).toBe(false);
    expect(dinerReviewSchema.safeParse({ overall: 5, ratings: { food: 6 } }).success).toBe(false);
    expect(dinerReviewSchema.safeParse({ overall: 5, ratings: { taste: 5 } }).success).toBe(false);
    expect(dinerReviewSchema.safeParse({ overall: 5, comment: 'x'.repeat(1001) }).success).toBe(false);
    expect(dinerReviewSchema.parse({ overall: 5, comment: '  ', name: '' })).toMatchObject({ comment: null, name: null });
    expect(dinerReviewSchema.safeParse({ overall: 5, photoIds: Array.from({ length: 4 }, () => crypto.randomUUID()) }).success).toBe(false);
    const line = crypto.randomUUID();
    expect(dinerReviewSchema.safeParse({ overall: 5, dishes: [{ orderItemId: line, rating: 5 }, { orderItemId: line, rating: 1 }] }).success).toBe(false);
    expect(dinerReviewSchema.parse({ overall: 4, contactPhone: '010 1234-5678', contactConsent: true }).contactPhone).toBe('01012345678');
  });

  it('keeps dishes and photos out of unverified feedback', () => {
    expect(feedbackSchema.safeParse({ overall: 4, tableCode: 'abcd1234', website: '' }).success).toBe(true);
    expect(feedbackSchema.safeParse({ overall: 4, dishes: [] }).success).toBe(false);
    expect(feedbackSchema.safeParse({ overall: 4, photoIds: [] }).success).toBe(false);
  });

  it('validates settings and keeps the sub-ratings in their order', () => {
    expect(reviewSettingsSchema.parse({ subRatings: ['speed', 'food', 'food'] }).subRatings).toEqual(['food', 'speed']);
    for (const body of [{ publishMinStars: 0 }, { googleMinStars: 6 }, { editWindowHours: 721 }, { menuMinCount: 0 }, { publishMode: 'SOMETIMES' }, { tags: [{ code: 'A', nameAr: 'أ', sentiment: 'POSITIVE' }, { code: 'a', nameAr: 'ب', sentiment: 'NEGATIVE' }] }]) {
      expect(reviewSettingsSchema.safeParse(body).success).toBe(false);
    }
    expect(reviewSettingsSchema.safeParse({ tags: Array.from({ length: 21 }, (_, index) => ({ code: `T${index}`, nameAr: 'وسم', sentiment: 'POSITIVE' })) }).success).toBe(false);
    expect(DEFAULT_REVIEW_SETTINGS).toMatchObject({ enabled: false, askAfter: 'COMPLETED', publishMode: 'AUTO', publishMinStars: 1, menuMinCount: 3, googleMinStars: 4, alertBelowStars: 3, editWindowHours: 24, displayName: 'FIRST_NAME_INITIAL' });
    expect(DEFAULT_REVIEW_SETTINGS.tags).toHaveLength(10);
  });

  it('parses inbox filters', () => {
    expect(reviewsQuerySchema.parse({ stars: '1,2,2', verified: 'false', hasComment: 'true', followUp: 'NONE' })).toMatchObject({ stars: [1, 2], verified: false, hasComment: true, followUp: 'NONE', page: 1, pageSize: 25 });
    expect(reviewsQuerySchema.safeParse({ stars: '0' }).success).toBe(false);
  });
});
