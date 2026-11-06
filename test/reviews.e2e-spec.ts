import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { LocalStorageService } from '../src/infrastructure/storage/local-storage.service.js';
import { StorageService } from '../src/infrastructure/storage/storage.service.js';
import { auth, fixtures } from './reviews-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

// The diner's side: plan gating, settings, eligibility, one review per order and its edit window,
// dish ratings, photos and publishing.

let t: TestApp;
const { http, chain, reviewing, settings, order, advance, completed, state, submit, reviewed, upload, staff } = fixtures(() => t);

const storageRoot = () => (t.app.get(StorageService) as LocalStorageService).root;
const errorCode = (response: { body: { error?: { code?: string } } }) => response.body.error?.code;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('reviews: plan and settings', () => {
  it('is part of Menu & Orders and the Full Experience; without it nothing is asked or shown, and data is kept', async () => {
    const r = await reviewing({ showOnMenu: true });
    const first = await reviewed(r, { overall: 5, comment: 'تحفة' });
    const second = await completed(r);

    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'MENU' } });
    for (const path of ['/v1/reviews', '/v1/reviews/settings', '/v1/reviews/stats', '/v1/reviews/dishes', '/v1/reviews/export', `/v1/reviews/${first.reviewId}`]) {
      expect(errorCode(await http().get(path).set(auth(r.token)).expect(409))).toBe('REVIEWS_UNAVAILABLE');
    }
    await settings(r.token, { enabled: false }).expect(409);
    expect((await state(first.token).expect(200)).body).toMatchObject({ eligibility: 'LOCKED', form: null });
    expect((await state(second.token).expect(200)).body).toMatchObject({ eligibility: 'UNAVAILABLE', form: null, review: null });
    expect(errorCode(await submit(second.token, { overall: 5 }).expect(409))).toBe('REVIEWS_UNAVAILABLE');
    expect(errorCode(await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(404))).toBe('REVIEWS_NOT_PUBLIC');
    const menu = (await http().get(`/v1/public/restaurants/${r.subdomain}/menu`).expect(200)).body;
    expect(menu.restaurant.reviews).toBeNull();

    // Menu & Orders includes reviews: everything is still there.
    await t.prisma.entitlement.updateMany({ where: { restaurantId: r.restaurantId }, data: { planCode: 'ORDERS' } });
    expect((await http().get('/v1/reviews').set(auth(r.token)).expect(200)).body.total).toBe(1);
    expect((await state(second.token).expect(200)).body.eligibility).toBe('OPEN');
    expect((await http().get(`/v1/public/restaurants/${r.subdomain}/menu`).expect(200)).body.restaurant.reviews).toEqual({ page: true, feedback: false, dishRatingScale: 'THUMBS' });
  });

  it('starts from the defaults, changes only what is sent, validates, audits, and needs reviews.settings to change', async () => {
    const r = await chain();
    const initial = (await http().get('/v1/reviews/settings').set(auth(r.token)).expect(200)).body;
    expect(initial).toMatchObject({
      enabled: false, askAfter: 'COMPLETED', allowUnverified: false, subRatings: ['food', 'service'], dishRatings: true, dishRatingScale: 'THUMBS',
      commentRequiredBelow: 3, photos: true, publishMode: 'AUTO', publishMinStars: 1, showOnMenu: false, menuMinCount: 3, googlePrompt: true,
      googleMinStars: 4, alertBelowStars: 3, editWindowHours: 24, displayName: 'FIRST_NAME_INITIAL', updatedAt: null,
    });
    expect(initial.tags.map((tag: { code: string }) => tag.code)).toEqual(['DELICIOUS', 'FAST', 'FRIENDLY_STAFF', 'GOOD_VALUE', 'CLEAN', 'COLD_FOOD', 'SLOW', 'WRONG_ORDER', 'SMALL_PORTION', 'RUDE_STAFF']);

    const changed = await settings(r.token, { enabled: true, subRatings: ['value', 'food'], tags: [{ code: 'crispy', nameAr: 'مقرمش', sentiment: 'POSITIVE' }] }).expect(200);
    expect(changed.body).toMatchObject({ enabled: true, subRatings: ['food', 'value'], tags: [{ code: 'CRISPY', nameAr: 'مقرمش', nameEn: null, sentiment: 'POSITIVE' }], publishMode: 'AUTO', updatedAt: expect.any(String) });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'reviews.settings', restaurantId: r.restaurantId } });
    expect(audit.metadata).toMatchObject({ changes: { enabled: true } });

    for (const body of [{ publishMinStars: 0 }, { askAfter: 'PLACED' }, { subRatings: ['taste'] }, { alertBelowStars: 6 }, { unknown: true }, { tags: [{ code: 'x y', nameAr: 'س', sentiment: 'POSITIVE' }] }]) {
      await settings(r.token, body).expect(400);
    }

    // Managers read the settings (for the inbox) but only the owner changes them by default.
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    await http().get('/v1/reviews/settings').set(auth(manager.token)).expect(200);
    await settings(manager.token, { enabled: false }).expect(403);
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    await http().get('/v1/reviews/settings').set(auth(kitchen.token)).expect(403);
    // Any staff role may be granted it.
    const granted = await staff(r.token, 'CASHIER', 'cashier@koshary.test', { permissions: ['reviews.settings'] });
    await settings(granted.token, { googleMinStars: 5 }).expect(200);
  });
});

describe('reviews: eligibility', () => {
  it('asks once the order reaches askAfter, with the order’s dishes and the restaurant’s questions', async () => {
    const r = await reviewing();
    const placed = await order(r);
    expect((await state(placed.token).expect(200)).body).toMatchObject({ eligibility: 'NOT_YET', form: null, review: null });
    expect((await submit(placed.token, { overall: 5 }).expect(409)).body.error).toMatchObject({ code: 'REVIEW_NOT_ELIGIBLE', details: { eligibility: 'NOT_YET' } });

    await advance(r.token, placed.orderId, 'READY');
    expect((await state(placed.token).expect(200)).body.eligibility).toBe('NOT_YET');
    await settings(r.token, { askAfter: 'READY' }).expect(200);
    const ready = (await state(placed.token).expect(200)).body;
    expect(ready).toMatchObject({
      eligibility: 'OPEN',
      form: {
        restaurant: { name: 'Koshary Abou Tarek', subdomain: 'koshary' },
        branch: { slug: 'main' },
        subRatings: ['food', 'service'],
        dishRatings: true,
        dishRatingScale: 'THUMBS',
        commentRequiredBelow: 3,
        photos: true,
        maxPhotos: 3,
        displayName: 'FIRST_NAME_INITIAL',
        dishes: [
          { orderItemId: placed.itemIds[0], nameAr: 'كشري', variantNameAr: 'كبير', quantity: 2 },
          { orderItemId: placed.itemIds[1], nameAr: 'ليمون نعناع', variantNameAr: null, quantity: 1 },
        ],
      },
      review: null,
      outcome: null,
    });
    expect(ready.form.tags).toHaveLength(10);

    await settings(r.token, { enabled: false }).expect(200);
    expect((await state(placed.token).expect(200)).body.eligibility).toBe('UNAVAILABLE');
  });

  it('refuses rejected and cancelled orders, and unknown links', async () => {
    const r = await reviewing({ askAfter: 'READY' });
    const rejected = await order(r);
    await advance(r.token, rejected.orderId, 'REJECTED');
    const cancelled = await order(r);
    await advance(r.token, cancelled.orderId, 'CANCELLED');
    for (const placed of [rejected, cancelled]) {
      expect((await state(placed.token).expect(200)).body).toMatchObject({ eligibility: 'CLOSED', form: null });
      expect((await submit(placed.token, { overall: 1, comment: 'Cancelled on me' }).expect(409)).body.error.details).toEqual({ eligibility: 'CLOSED' });
    }
    expect(errorCode(await state('bogus.token').expect(404))).toBe('ORDER_NOT_FOUND');
    // Diners' pages live on other origins: the review's PUT is allowed cross-origin, without cookies.
    const preflight = await http().options(`/v1/public/orders/${rejected.token}/review`).set('Origin', 'https://koshary.bilhanah.test').set('Access-Control-Request-Method', 'PUT').expect(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(errorCode(await submit(`${rejected.token}x`, { overall: 5 }).expect(404))).toBe('ORDER_NOT_FOUND');
  });

  it('closes orders older than 30 days', async () => {
    const r = await reviewing();
    const placed = await completed(r);
    await t.prisma.order.update({ where: { id: placed.orderId }, data: { placedAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect((await state(placed.token).expect(200)).body.eligibility).toBe('CLOSED');
  });
});

describe('reviews: one per order, editable within the window', () => {
  it('creates once, edits from the same browser within the window, keeps the original in the history, and refuses afterwards', async () => {
    const r = await reviewing({ editWindowHours: 2 });
    const placed = await completed(r);
    const editKey = 'browser-key-0123456789';
    const created = await submit(placed.token, {
      overall: 4, ratings: { food: 5, service: 3 }, tags: ['delicious'], comment: 'الكشري حلو بس الخدمة بطيئة شوية', name: 'Mona Ahmed', language: 'ar', editKey,
      dishes: [{ orderItemId: placed.itemIds[0], rating: 5 }, { orderItemId: placed.itemIds[1], rating: 1 }],
    }).expect(200);
    expect(created.body).toMatchObject({
      review: { overall: 4, ratings: { food: 5, service: 3 }, tags: ['DELICIOUS'], name: 'Mona Ahmed', hasContact: false, dishes: [{ orderItemId: placed.itemIds[0], rating: 5 }, { orderItemId: placed.itemIds[1], rating: 1 }] },
      outcome: { status: 'PUBLISHED', google: null },
      editableUntil: expect.any(String),
    });
    const until = Date.parse(created.body.editableUntil);
    expect(until - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
    expect(until - Date.now()).toBeLessThan(2.1 * 3_600_000);

    // Another browser with the link cannot change it.
    expect(errorCode(await submit(placed.token, { overall: 1, comment: 'hacked' }).expect(403))).toBe('REVIEW_EDIT_FORBIDDEN');
    expect(errorCode(await submit(placed.token, { overall: 1, comment: 'hacked', editKey: 'another-key-0123456789' }).expect(403))).toBe('REVIEW_EDIT_FORBIDDEN');

    const edited = await submit(placed.token, { overall: 2, comment: 'جالي بارد للأسف', tags: ['COLD_FOOD'], editKey }).expect(200);
    expect(edited.body.review).toMatchObject({ overall: 2, ratings: {}, tags: ['COLD_FOOD'], dishes: [], name: null });
    expect(await t.prisma.review.count({ where: { orderId: placed.orderId } })).toBe(1);
    const row = await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    expect(row).toMatchObject({ overall: 2, editCount: 1, verified: true, source: 'ORDER', branchId: r.mainId });
    expect(row.events.map((event) => event.kind)).toEqual(['CREATED', 'EDITED']);
    expect(row.events[1]).toMatchObject({ previousOverall: 4, metadata: expect.objectContaining({ overall: 4, ratings: { food: 5, service: 3 }, comment: 'الكشري حلو بس الخدمة بطيئة شوية' }) });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'review.edited', targetId: row.id } });
    expect(audit).toMatchObject({ actorId: null, restaurantId: r.restaurantId, metadata: expect.objectContaining({ from: expect.objectContaining({ overall: 4 }) }) });

    // The state shows the review and that it is still editable.
    expect((await state(placed.token).expect(200)).body).toMatchObject({ eligibility: 'EDITABLE', review: { overall: 2 }, form: expect.any(Object) });

    // After the window: locked.
    await t.prisma.review.update({ where: { id: row.id }, data: { editableUntil: new Date(Date.now() - 1000) } });
    expect((await state(placed.token).expect(200)).body).toMatchObject({ eligibility: 'LOCKED', form: null, review: { overall: 2 } });
    expect((await submit(placed.token, { overall: 5, editKey }).expect(409)).body.error).toMatchObject({ code: 'REVIEW_NOT_ELIGIBLE', details: { eligibility: 'LOCKED' } });
  });

  it('cannot be edited when the window is 0, and a review without an edit key can be edited with the link alone', async () => {
    const r = await reviewing({ editWindowHours: 0 });
    const locked = await reviewed(r, { overall: 5 });
    expect((await state(locked.token).expect(200)).body.eligibility).toBe('LOCKED');
    await submit(locked.token, { overall: 4 }).expect(409);

    await settings(r.token, { editWindowHours: 24 }).expect(200);
    const open = await reviewed(r, { overall: 5 });
    await submit(open.token, { overall: 4 }).expect(200);
  });

  it('checks ratings, tags, comments and contact consent against the settings; the phone is never sent back', async () => {
    const r = await reviewing();
    const placed = await completed(r);
    const cases: [Record<string, unknown>, string][] = [
      [{ overall: 5, ratings: { atmosphere: 4 } }, 'REVIEW_RATING_NOT_ASKED'],
      [{ overall: 5, tags: ['NOT_A_TAG'] }, 'REVIEW_TAG_UNKNOWN'],
      [{ overall: 2 }, 'REVIEW_COMMENT_REQUIRED'],
      [{ overall: 2, comment: '   ' }, 'REVIEW_COMMENT_REQUIRED'],
      [{ overall: 5, contactPhone: '01011112222' }, 'REVIEW_CONTACT_CONSENT_REQUIRED'],
    ];
    for (const [body, code] of cases) expect(errorCode(await submit(placed.token, body).expect(400))).toBe(code);
    for (const body of [{ overall: 0 }, { overall: 3.5 }, { overall: 6 }, { overall: 5, ratings: { food: 0 } }, { overall: 5, comment: 'x'.repeat(1001) }, { overall: 5, extra: 1 }]) {
      await submit(placed.token, body).expect(400);
    }
    const sent = await submit(placed.token, { overall: 2, comment: 'Slow', contactPhone: '010 1111 2222', contactConsent: true }).expect(200);
    expect(sent.body.review.hasContact).toBe(true);
    expect(JSON.stringify(sent.body)).not.toContain('01011112222');
    expect(JSON.stringify((await state(placed.token).expect(200)).body)).not.toContain('01011112222');
    expect((await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } })).contactPhone).toBe('01011112222');
    // Withdrawing consent forgets the number.
    await submit(placed.token, { overall: 2, comment: 'Slow', contactPhone: '01011112222', contactConsent: false }).expect(400);
    await submit(placed.token, { overall: 2, comment: 'Slow' }).expect(200);
    expect((await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } })).contactPhone).toBeNull();
  });
});

describe('reviews: dish ratings', () => {
  it('rates only the order’s own lines, on the restaurant’s scale', async () => {
    const r = await reviewing();
    const mine = await completed(r);
    const other = await completed(r);
    expect((await submit(mine.token, { overall: 5, dishes: [{ orderItemId: other.itemIds[0], rating: 5 }] }).expect(400)).body.error).toMatchObject({ code: 'REVIEW_DISH_NOT_IN_ORDER', details: { orderItemId: other.itemIds[0] } });
    expect((await submit(mine.token, { overall: 5, dishes: [{ orderItemId: mine.itemIds[0], rating: 3 }] }).expect(400)).body.error.code).toBe('REVIEW_RATING_NOT_ASKED');
    await submit(mine.token, { overall: 5, dishes: [{ orderItemId: mine.itemIds[0], rating: 5 }, { orderItemId: mine.itemIds[0], rating: 1 }] }).expect(400);

    await settings(r.token, { dishRatingScale: 'STARS' }).expect(200);
    await submit(mine.token, { overall: 5, dishes: [{ orderItemId: mine.itemIds[0], rating: 3 }] }).expect(200);
    const ratings = await t.prisma.reviewDishRating.findMany({ where: { review: { orderId: mine.orderId } } });
    expect(ratings).toEqual([expect.objectContaining({ orderItemId: mine.itemIds[0], menuItemId: r.koshary.id, nameAr: 'كشري', rating: 3 })]);

    await settings(r.token, { dishRatings: false }).expect(200);
    expect((await state(other.token).expect(200)).body.form.dishes).toEqual([]);
    expect((await submit(other.token, { overall: 5, dishes: [{ orderItemId: other.itemIds[0], rating: 5 }] }).expect(400)).body.error.details).toEqual({ field: 'dishes' });
  });
});

describe('reviews: photos', () => {
  it('re-encodes uploads, keeps them private until the review is published, and private again when hidden', async () => {
    const r = await reviewing({ publishMode: 'MANUAL', showOnMenu: true });
    const placed = await completed(r);
    const uploaded = await upload(placed.token);
    expect(uploaded.body).toEqual({ id: expect.any(String), width: 640, height: 480 });
    const media = await t.prisma.media.findUniqueOrThrow({ where: { id: uploaded.body.id } });
    expect(media).toMatchObject({ kind: 'REVIEW', restaurantId: r.restaurantId, storageKey: `private/restaurants/${r.restaurantId}/reviews/${media.id}` });
    // Re-encoded to WebP without the camera's metadata.
    const stored = await sharp(join(storageRoot(), media.storageKey, '640.webp')).metadata();
    expect(stored).toMatchObject({ format: 'webp', width: 640 });
    expect(stored.exif).toBeUndefined();
    await http().get(`/media/${media.storageKey}/640.webp`).expect(404);
    // The diner can see their own upload; another order's link cannot.
    const elsewhere = await completed(r);
    const own = await http().get(`/v1/public/orders/${placed.token}/review/photos/${media.id}`).expect(200);
    expect(own.headers['content-type']).toBe('image/webp');
    expect(own.headers['cache-control']).toBe('private, no-store');
    // Shown on the restaurant's own subdomain, so it must be loadable across origins.
    expect(own.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await http().get(`/v1/public/orders/${elsewhere.token}/review/photos/${media.id}`).expect(404);
    // Another order's upload cannot be attached.
    const foreign = await upload(elsewhere.token);
    expect((await submit(placed.token, { overall: 5, photoIds: [foreign.body.id] }).expect(400)).body.error).toMatchObject({ code: 'REVIEW_PHOTO_NOT_FOUND', details: { photoId: foreign.body.id } });

    const sent = await submit(placed.token, { overall: 5, photoIds: [uploaded.body.id] }).expect(200);
    expect(sent.body).toMatchObject({ review: { photoIds: [uploaded.body.id] }, outcome: { status: 'PENDING' } });
    const review = await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } });
    // Staff stream the private photo; it is not on the public page yet.
    const inbox = (await http().get(`/v1/reviews/${review.id}`).set(auth(r.token)).expect(200)).body;
    expect(inbox.photos).toEqual([{ id: media.id, width: 640, height: 480, sources: [], privateUrl: `/v1/reviews/${review.id}/photos/${media.id}` }]);
    await http().get(inbox.photos[0].privateUrl).set(auth(r.token)).expect(200);
    expect((await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(200)).body.items).toEqual([]);

    await http().post(`/v1/reviews/${review.id}/publish`).set(auth(r.token)).expect(200);
    const published = await t.prisma.media.findUniqueOrThrow({ where: { id: media.id } });
    expect(published.storageKey).toBe(`restaurants/${r.restaurantId}/reviews/${media.id}`);
    expect(existsSync(join(storageRoot(), 'private', 'restaurants', r.restaurantId, 'reviews', media.id))).toBe(false);
    const page = (await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(200)).body;
    expect(page.items[0].photos).toEqual([expect.objectContaining({ id: media.id, url: `http://api.test/media/restaurants/${r.restaurantId}/reviews/${media.id}/640.webp` })]);
    await http().get(`/media/restaurants/${r.restaurantId}/reviews/${media.id}/640.webp`).expect(200);

    await http().post(`/v1/reviews/${review.id}/hide`).set(auth(r.token)).send({ reason: 'Shows another diner’s face' }).expect(200);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: media.id } })).storageKey).toBe(`private/restaurants/${r.restaurantId}/reviews/${media.id}`);
    await http().get(`/media/restaurants/${r.restaurantId}/reviews/${media.id}/640.webp`).expect(404);
    await http().get(`/v1/reviews/${review.id}/photos/${media.id}`).set(auth(r.token)).expect(200);
  });

  it('limits photos per review and uploads per order, refuses non-images and follows the photos setting', async () => {
    const r = await reviewing();
    const placed = await completed(r);
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push((await upload(placed.token)).body.id);
    await submit(placed.token, { overall: 5, photoIds: ids }).expect(400);
    await submit(placed.token, { overall: 5, photoIds: ids.slice(0, 3) }).expect(200);
    // An edit can drop a photo; it goes private (it was public: AUTO published the review).
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: ids[0]! } })).storageKey.startsWith('restaurants/')).toBe(true);
    await submit(placed.token, { overall: 5, photoIds: [ids[1]] }).expect(200);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: ids[0]! } })).storageKey.startsWith('private/')).toBe(true);
    expect((await t.prisma.reviewPhoto.findMany({ where: { review: { orderId: placed.orderId } } })).map((photo) => photo.mediaId)).toEqual([ids[1]]);

    for (let index = 4; index < 10; index++) await upload(placed.token);
    expect(errorCode(await upload(placed.token, 409))).toBe('REVIEW_PHOTO_LIMIT');

    const other = await completed(r);
    await http().post(`/v1/public/orders/${other.token}/review/photos`).attach('file', Buffer.from('not an image'), { filename: 'x.jpg', contentType: 'image/jpeg' }).expect(400);
    const notYet = await order(r);
    expect(errorCode(await upload(notYet.token, 409))).toBe('REVIEW_NOT_ELIGIBLE');
    await settings(r.token, { photos: false }).expect(200);
    expect(errorCode(await upload(other.token, 400))).toBe('REVIEW_PHOTOS_OFF');
    // Unattached uploads are purged after a day like any unused image; attached ones are kept.
    await t.prisma.media.updateMany({ where: { kind: 'REVIEW' }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const { MediaService } = await import('../src/modules/media/media.service.js');
    await t.app.get(MediaService).purgeUnused(new Date(Date.now() - 86_400_000));
    expect((await t.prisma.media.findMany({ where: { kind: 'REVIEW' } })).map((media) => media.id)).toEqual([ids[1]]);
  });
});

describe('reviews: publishing', () => {
  it('AUTO publishes at or above publishMinStars, MANUAL holds everything, NEVER keeps everything private', async () => {
    const r = await reviewing({ publishMinStars: 4, showOnMenu: true });
    await http().patch(`/v1/branches/${r.mainId}`).set(auth(r.token)).send({ googleReviewUrl: 'https://g.page/r/koshary/review' }).expect(200);
    const happy = await reviewed(r, { overall: 4 });
    expect(happy.response.outcome).toEqual({ status: 'PUBLISHED', google: { url: 'https://g.page/r/koshary/review' } });
    const unhappy = await reviewed(r, { overall: 3, comment: 'Okay' });
    expect(unhappy.response.outcome).toEqual({ status: 'PENDING', google: null });

    // Editing applies the rule again.
    await submit(happy.token, { overall: 2, comment: 'Changed my mind' }).expect(200);
    expect((await t.prisma.review.findUniqueOrThrow({ where: { id: happy.reviewId } })).status).toBe('PENDING');
    await submit(happy.token, { overall: 5 }).expect(200);
    expect((await t.prisma.review.findUniqueOrThrow({ where: { id: happy.reviewId } })).status).toBe('PUBLISHED');

    await settings(r.token, { publishMode: 'MANUAL' }).expect(200);
    expect((await reviewed(r, { overall: 5 })).response.outcome).toEqual({ status: 'PENDING', google: { url: 'https://g.page/r/koshary/review' } });

    await settings(r.token, { publishMode: 'NEVER', googlePrompt: false }).expect(200);
    const never = await reviewed(r, { overall: 5 });
    expect(never.response.outcome).toEqual({ status: 'NOT_PUBLIC', google: null });
    expect(errorCode(await http().post(`/v1/reviews/${never.reviewId}/publish`).set(auth(r.token)).expect(409))).toBe('REVIEW_PUBLISHING_OFF');
    expect(errorCode(await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(404))).toBe('REVIEWS_NOT_PUBLIC');
    expect((await http().get(`/v1/public/restaurants/${r.subdomain}/menu`).expect(200)).body.restaurant.reviews).toMatchObject({ page: false });
  });
});

describe('contact phone on edit', () => {
  it('keeps the stored phone when an edit leaves it out, and forgets it when cleared or consent is withdrawn', async () => {
    const r = await reviewing({ editWindowHours: 2 });
    const placed = await completed(r);
    const editKey = 'browser-key-phone-0123456789';
    const phone = '01012345678';
    expect((await submit(placed.token, { overall: 2, comment: 'Late and cold', contactPhone: phone, contactConsent: true, editKey }).expect(200)).body.review.hasContact).toBe(true);
    // The diner never sees the number again; leaving it out keeps it.
    expect((await submit(placed.token, { overall: 3, comment: 'Late, but they called', contactConsent: true, editKey }).expect(200)).body.review.hasContact).toBe(true);
    const stored = await t.prisma.review.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(stored).toMatchObject({ contactPhone: phone, contactConsent: true, overall: 3 });
    // An empty value removes it, and so does withdrawing consent.
    expect((await submit(placed.token, { overall: 3, comment: 'Late, but they called', contactPhone: '', contactConsent: true, editKey }).expect(200)).body.review.hasContact).toBe(false);
    await submit(placed.token, { overall: 3, comment: 'Late, but they called', contactPhone: phone, contactConsent: true, editKey }).expect(200);
    expect((await submit(placed.token, { overall: 3, comment: 'Late, but they called', contactConsent: false, editKey }).expect(200)).body.review.hasContact).toBe(false);
    expect((await t.prisma.review.findFirstOrThrow({ where: { orderId: placed.orderId } })).contactPhone).toBeNull();
  });
});
