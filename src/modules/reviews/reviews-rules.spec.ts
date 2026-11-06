import { DEFAULT_REVIEW_SETTINGS, DEFAULT_REVIEW_TAGS } from '@bilhanah/contracts';
import {
  commentRequired,
  isLowRating,
  outcomeFor,
  photosPublic,
  publishDecision,
  ratingColumns,
  ratingsOf,
  resolveTags,
  reviewEligibility,
  rulesFrom,
  showsPublicly,
  tagsFrom,
} from './reviews-rules.js';

const now = new Date('2026-11-06T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

describe('review eligibility', () => {
  const base = { reviewsOn: true, askAfter: 'COMPLETED' as const, review: null, now };

  it('opens once the order reaches askAfter', () => {
    expect(reviewEligibility({ ...base, order: { status: 'COMPLETED', placedAt: hoursAgo(1) } })).toBe('OPEN');
    expect(reviewEligibility({ ...base, order: { status: 'READY', placedAt: hoursAgo(1) } })).toBe('NOT_YET');
    expect(reviewEligibility({ ...base, order: { status: 'PLACED', placedAt: hoursAgo(1) } })).toBe('NOT_YET');
    expect(reviewEligibility({ ...base, askAfter: 'READY', order: { status: 'READY', placedAt: hoursAgo(1) } })).toBe('OPEN');
    expect(reviewEligibility({ ...base, askAfter: 'READY', order: { status: 'COMPLETED', placedAt: hoursAgo(1) } })).toBe('OPEN');
    expect(reviewEligibility({ ...base, askAfter: 'READY', order: { status: 'PREPARING', placedAt: hoursAgo(1) } })).toBe('NOT_YET');
  });

  it('closes rejected, cancelled and old orders, and is unavailable without the plan or the owner asking', () => {
    expect(reviewEligibility({ ...base, order: { status: 'REJECTED', placedAt: hoursAgo(1) } })).toBe('CLOSED');
    expect(reviewEligibility({ ...base, askAfter: 'READY', order: { status: 'CANCELLED', placedAt: hoursAgo(1) } })).toBe('CLOSED');
    expect(reviewEligibility({ ...base, order: { status: 'COMPLETED', placedAt: hoursAgo(24 * 30 - 1) } })).toBe('OPEN');
    expect(reviewEligibility({ ...base, order: { status: 'COMPLETED', placedAt: hoursAgo(24 * 30 + 1) } })).toBe('CLOSED');
    expect(reviewEligibility({ ...base, reviewsOn: false, order: { status: 'COMPLETED', placedAt: hoursAgo(1) } })).toBe('UNAVAILABLE');
  });

  it('lets the diner edit until the review’s own window closes, while reviews are on', () => {
    const order = { status: 'COMPLETED' as const, placedAt: hoursAgo(48) };
    expect(reviewEligibility({ ...base, order, review: { editableUntil: new Date(now.getTime() + 1000) } })).toBe('EDITABLE');
    expect(reviewEligibility({ ...base, order, review: { editableUntil: now } })).toBe('LOCKED');
    expect(reviewEligibility({ ...base, reviewsOn: false, order, review: { editableUntil: new Date(now.getTime() + 1000) } })).toBe('LOCKED');
  });
});

describe('publish rules', () => {
  it('AUTO publishes at or above the threshold and holds the rest, for every rating alike', () => {
    expect(publishDecision({ publishMode: 'AUTO', publishMinStars: 1 }, 1)).toBe('PUBLISHED');
    expect(publishDecision({ publishMode: 'AUTO', publishMinStars: 4 }, 4)).toBe('PUBLISHED');
    expect(publishDecision({ publishMode: 'AUTO', publishMinStars: 4 }, 3)).toBe('PENDING');
  });

  it('MANUAL and NEVER hold everything; a hidden review stays hidden when edited', () => {
    expect(publishDecision({ publishMode: 'MANUAL', publishMinStars: 1 }, 5)).toBe('PENDING');
    expect(publishDecision({ publishMode: 'NEVER', publishMinStars: 1 }, 5)).toBe('PENDING');
    expect(publishDecision({ publishMode: 'AUTO', publishMinStars: 1 }, 5, 'HIDDEN')).toBe('HIDDEN');
    expect(publishDecision({ publishMode: 'AUTO', publishMinStars: 4 }, 2, 'PUBLISHED')).toBe('PENDING');
  });

  it('shows reviews publicly only with the plan, showOnMenu and publishing on; photos only for published reviews', () => {
    expect(showsPublicly(true, { showOnMenu: true, publishMode: 'AUTO' })).toBe(true);
    expect(showsPublicly(true, { showOnMenu: true, publishMode: 'MANUAL' })).toBe(true);
    expect(showsPublicly(true, { showOnMenu: true, publishMode: 'NEVER' })).toBe(false);
    expect(showsPublicly(true, { showOnMenu: false, publishMode: 'AUTO' })).toBe(false);
    expect(showsPublicly(false, { showOnMenu: true, publishMode: 'AUTO' })).toBe(false);
    expect(photosPublic('PUBLISHED', { publishMode: 'AUTO' })).toBe(true);
    expect(photosPublic('PUBLISHED', { publishMode: 'NEVER' })).toBe(false);
    expect(photosPublic('PENDING', { publishMode: 'AUTO' })).toBe(false);
    expect(photosPublic('HIDDEN', { publishMode: 'AUTO' })).toBe(false);
  });

  it('tells the diner what happens next and invites happy diners to Google when the branch has a link', () => {
    const rules = { publishMode: 'AUTO' as const, googlePrompt: true, googleMinStars: 4 };
    expect(outcomeFor('PUBLISHED', 5, rules, 'https://g.page/r/x/review')).toEqual({ status: 'PUBLISHED', google: { url: 'https://g.page/r/x/review' } });
    expect(outcomeFor('PUBLISHED', 3, rules, 'https://g.page/r/x/review')).toEqual({ status: 'PUBLISHED', google: null });
    expect(outcomeFor('PENDING', 4, rules, null)).toEqual({ status: 'PENDING', google: null });
    expect(outcomeFor('PENDING', 5, { ...rules, googlePrompt: false }, 'https://g.page/r/x/review').google).toBeNull();
    expect(outcomeFor('HIDDEN', 5, rules, null).status).toBe('NOT_PUBLIC');
    expect(outcomeFor('PENDING', 5, { ...rules, publishMode: 'NEVER' }, null).status).toBe('NOT_PUBLIC');
  });

  it('alerts below alertBelowStars and requires comments below commentRequiredBelow (0 never)', () => {
    expect(isLowRating(2, 3)).toBe(true);
    expect(isLowRating(3, 3)).toBe(false);
    expect(isLowRating(1, 1)).toBe(false);
    expect(isLowRating(1, 0)).toBe(false);
    expect(commentRequired(2, 3)).toBe(true);
    expect(commentRequired(3, 3)).toBe(false);
    expect(commentRequired(1, 0)).toBe(false);
  });
});

describe('settings and fields', () => {
  it('uses the defaults until the restaurant saves settings', () => {
    expect(rulesFrom(null)).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(tagsFrom(null)).toEqual(DEFAULT_REVIEW_TAGS);
    expect(tagsFrom([{ code: 'A', nameAr: 'أ', sentiment: 'NEGATIVE' }, { code: 'B' }, null])).toEqual([{ code: 'A', nameAr: 'أ', nameEn: null, sentiment: 'NEGATIVE' }]);
  });

  it('maps sub-ratings to their columns and back', () => {
    const columns = ratingColumns({ food: 5, speed: 2 });
    expect(columns).toEqual({ foodRating: 5, serviceRating: null, valueRating: null, speedRating: 2, cleanlinessRating: null, atmosphereRating: null });
    expect(ratingsOf(columns)).toEqual({ food: 5, speed: 2 });
  });

  it('names tags from the settings, keeping codes no longer offered', () => {
    expect(resolveTags(['FAST', 'GONE'], DEFAULT_REVIEW_TAGS)).toEqual([
      DEFAULT_REVIEW_TAGS.find((tag) => tag.code === 'FAST'),
      { code: 'GONE', nameAr: 'GONE', nameEn: null, sentiment: 'POSITIVE' },
    ]);
  });
});
