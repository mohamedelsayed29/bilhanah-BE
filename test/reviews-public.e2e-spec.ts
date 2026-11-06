import { auth, fixtures } from './reviews-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

// What diners see: the public reviews page and its honest summary, dish badges on the menu (and
// their freshness), unverified feedback, and the branch's Google review link.

let t: TestApp;
const { http, reviewing, settings, completed, submit, reviewed, staff } = fixtures(() => t);

const PHONE = '01055556666';
const page = (subdomain: string, query = '') => http().get(`/v1/public/restaurants/${subdomain}/reviews${query}`);
const menu = async (subdomain: string, branch?: string) => (await http().get(`/v1/public/restaurants/${subdomain}/menu${branch ? `?branch=${branch}` : ''}`).expect(200)).body;
const itemRating = (body: { categories: { items: { id: string; rating: unknown }[] }[] }, id: string) => body.categories.flatMap((category) => category.items).find((item) => item.id === id)!.rating;
const feedback = (subdomain: string, body: Record<string, unknown>, ip = '203.0.113.7') => http().post(`/v1/public/restaurants/${subdomain}/feedback`).set('X-Forwarded-For', ip).send(body);

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('public reviews page', () => {
  it('lists published reviews with the reply, and a summary computed from every published review', async () => {
    const r = await reviewing({ publishMinStars: 3 });
    expect((await page(r.subdomain).expect(404)).body.error.code).toBe('REVIEWS_NOT_PUBLIC');
    await settings(r.token, { showOnMenu: true }).expect(200);

    const five = await reviewed(r, { overall: 5, ratings: { food: 5, service: 4 }, tags: ['DELICIOUS'], comment: 'أحسن كشري في وسط البلد', name: 'Mona Ahmed', contactPhone: PHONE, contactConsent: true });
    await reviewed(r, { overall: 3, ratings: { food: 3 }, comment: 'عادي', name: 'عبد الرحمن محمد' });
    const low = await reviewed(r, { overall: 2, comment: 'Cold and late', name: 'Omar' });
    const hidden = await reviewed(r, { overall: 4, comment: 'spam spam', name: 'Spammer' });
    const nasr = await reviewed(r, { overall: 4, name: 'Sara' }, { branch: 'nasr-city' });
    await http().post(`/v1/reviews/${hidden.reviewId}/hide`).set(auth(r.token)).send({ reason: 'Advertising another place' }).expect(200);
    await http().put(`/v1/reviews/${five.reviewId}/reply`).set(auth(r.token)).send({ text: 'شكرًا يا منى! نورتينا' }).expect(200);

    const body = (await page(r.subdomain).expect(200)).body;
    expect(body.summary).toEqual({
      average: 4, count: 3, distribution: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 }, verifiedCount: 3,
      subRatings: { food: 4, service: 4 }, policy: { mode: 'AUTO', minStars: 3 },
    });
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([nasr.reviewId, expect.any(String), five.reviewId]);
    expect(body.items.some((item: { id: string }) => item.id === low.reviewId || item.id === hidden.reviewId)).toBe(false);
    expect(body.items[2]).toMatchObject({
      overall: 5, ratings: { food: 5, service: 4 }, comment: 'أحسن كشري في وسط البلد', displayName: 'Mona A.', verified: true,
      branch: { slug: 'main', name: 'الفرع الرئيسي' }, tags: [{ code: 'DELICIOUS', nameEn: 'Delicious' }],
      dishes: [], photos: [], reply: { text: 'شكرًا يا منى! نورتينا', at: expect.any(String) },
    });
    expect(body.items[1].displayName).toBe('عبد الرحمن م.');
    expect(body).toMatchObject({ restaurant: { subdomain: 'koshary' }, branch: null, total: 3, page: 1, pageSize: 10, dishRatingScale: 'THUMBS' });
    // Contact details never leave through public routes.
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(JSON.stringify(body)).not.toContain('Mona Ahmed');

    // One branch: its summary and reviews only; unknown branches are unknown.
    const branchPage = (await page(r.subdomain, '?branch=nasr-city').expect(200)).body;
    expect(branchPage).toMatchObject({ branch: { slug: 'nasr-city' }, summary: { count: 1, average: 4 }, total: 1 });
    expect((await page(r.subdomain, '?branch=nowhere').expect(404)).body.error.code).toBe('BRANCH_NOT_FOUND');
    expect((await page(r.subdomain, '?pageSize=2&page=2').expect(200)).body.items).toHaveLength(1);
    await page('nowhere').expect(404);

    // Publishing a held review counts it; the page says how reviews are published.
    await http().post(`/v1/reviews/${low.reviewId}/publish`).set(auth(r.token)).expect(200);
    expect((await page(r.subdomain).expect(200)).body.summary).toMatchObject({ count: 4, average: 3.5, distribution: { '2': 1 } });
    await settings(r.token, { publishMode: 'MANUAL', displayName: 'ANONYMOUS' }).expect(200);
    const manual = (await page(r.subdomain).expect(200)).body;
    expect(manual.summary.policy).toEqual({ mode: 'MANUAL', minStars: 1 });
    expect(manual.items.every((item: { displayName: string | null }) => item.displayName === null)).toBe(true);
  });
});

describe('dish ratings on the public menu', () => {
  it('shows a dish’s rating from menuMinCount published ratings, and is never stale after a change', async () => {
    const r = await reviewing({ showOnMenu: true, menuMinCount: 2 });
    const rateKoshary = async (rating: number) => {
      const placed = await completed(r);
      await submit(placed.token, { overall: 5, dishes: [{ orderItemId: placed.itemIds[0], rating }] }).expect(200);
      return (await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } })).id;
    };
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toBeNull();
    await rateKoshary(5);
    // Below menuMinCount: nothing to show yet (and the menu is now cached).
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toBeNull();
    const second = await rateKoshary(1);
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toEqual({ average: 3, count: 2, positiveShare: 0.5 });
    // The branch's own menu shows the restaurant-wide rating too.
    expect(itemRating(await menu(r.subdomain, 'nasr-city'), r.koshary.id)).toEqual({ average: 3, count: 2, positiveShare: 0.5 });
    expect(itemRating(await menu(r.subdomain), r.lemonade.id)).toBeNull();

    // A third rating and a hidden review show at once.
    await rateKoshary(5);
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toEqual({ average: 3.7, count: 3, positiveShare: 0.6667 });
    await http().post(`/v1/reviews/${second}/hide`).set(auth(r.token)).send({ reason: 'Duplicate' }).expect(200);
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toEqual({ average: 5, count: 2, positiveShare: 1 });

    // Settings changes apply at once too.
    await settings(r.token, { menuMinCount: 3 }).expect(200);
    expect(itemRating(await menu(r.subdomain), r.koshary.id)).toBeNull();
    await settings(r.token, { menuMinCount: 1, showOnMenu: false }).expect(200);
    const off = await menu(r.subdomain);
    expect(itemRating(off, r.koshary.id)).toBeNull();
    expect(off.restaurant.reviews).toEqual({ page: false, feedback: false, dishRatingScale: 'THUMBS' });
  });

  it('counts only published reviews (MANUAL holds them until approved)', async () => {
    const r = await reviewing({ showOnMenu: true, menuMinCount: 1, publishMode: 'MANUAL' });
    const placed = await completed(r);
    await submit(placed.token, { overall: 5, dishes: [{ orderItemId: placed.itemIds[1], rating: 5 }] }).expect(200);
    expect(itemRating(await menu(r.subdomain), r.lemonade.id)).toBeNull();
    const review = await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } });
    await http().post(`/v1/reviews/${review.id}/publish`).set(auth(r.token)).expect(200);
    expect(itemRating(await menu(r.subdomain), r.lemonade.id)).toEqual({ average: 5, count: 1, positiveShare: 1 });
  });
});

describe('unverified feedback', () => {
  it('is refused unless the owner allows it; then it is labelled unverified, from the menu or a table', async () => {
    const r = await reviewing();
    expect((await feedback(r.subdomain, { overall: 4 }).expect(409)).body.error.code).toBe('REVIEW_FEEDBACK_UNAVAILABLE');
    await settings(r.token, { allowUnverified: true, showOnMenu: true }).expect(200);
    expect((await menu(r.subdomain)).restaurant.reviews).toEqual({ page: true, feedback: true, dishRatingScale: 'THUMBS' });

    const fromMenu = await feedback(r.subdomain, { overall: 5, comment: 'Lovely place', name: 'Hana Adel', language: 'en' }).expect(201);
    expect(fromMenu.body).toEqual({ outcome: { status: 'PUBLISHED', google: null } });
    const table = await http().post('/v1/tables').set(auth(r.token)).send({ label: 'T7', branchId: r.nasrId }).expect(201);
    await feedback(r.subdomain, { overall: 2, comment: 'Sticky table', tableCode: table.body.publicCode, contactPhone: PHONE, contactConsent: true }).expect(201);
    await feedback(r.subdomain, { overall: 4, branch: 'nasr-city' }).expect(201);

    const rows = await t.prisma.review.findMany({ where: { restaurantId: r.restaurantId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.source, row.verified, row.branchId, row.tableLabel, row.orderId])).toEqual([
      ['MENU', false, r.mainId, null, null],
      ['TABLE', false, r.nasrId, 'T7', null],
      ['MENU', false, r.nasrId, null, null],
    ]);
    expect(rows[1]).toMatchObject({ contactPhone: PHONE, followUpStatus: 'OPEN', editableUntil: rows[1]!.createdAt });
    const inbox = (await http().get('/v1/reviews?verified=false').set(auth(r.token)).expect(200)).body;
    expect(inbox.items.map((item: { source: string; verified: boolean }) => [item.source, item.verified])).toEqual([['MENU', false], ['TABLE', false], ['MENU', false]]);
    const publicPage = (await page(r.subdomain).expect(200)).body;
    expect(publicPage.items.every((item: { verified: boolean }) => item.verified === false)).toBe(true);
    expect(publicPage.summary).toMatchObject({ count: 3, verifiedCount: 0 });
    expect(JSON.stringify(publicPage)).not.toContain(PHONE);

    // Same validation as reviews; dishes and photos do not apply.
    expect((await feedback(r.subdomain, { overall: 1 }).expect(400)).body.error.code).toBe('REVIEW_COMMENT_REQUIRED');
    await feedback(r.subdomain, { overall: 5, dishes: [] }).expect(400);
    expect((await feedback(r.subdomain, { overall: 5, tableCode: 'nope1234' }).expect(404)).body.error.code).toBe('TABLE_NOT_FOUND');
    expect((await feedback(r.subdomain, { overall: 5, branch: 'nowhere' }).expect(404)).body.error.code).toBe('BRANCH_NOT_FOUND');
  });

  it('takes five per IP per restaurant a day, and quietly drops bots filling the honeypot', async () => {
    const r = await reviewing({ allowUnverified: true });
    for (let index = 0; index < 5; index++) await feedback(r.subdomain, { overall: 5 }).expect(201);
    expect((await feedback(r.subdomain, { overall: 5 }).expect(429)).body.error.code).toBe('RATE_LIMITED');
    // Another diner (another IP), or the same one at another restaurant, is not affected.
    await feedback(r.subdomain, { overall: 5 }, '203.0.113.8').expect(201);
    const other = await reviewing({ allowUnverified: true }, 'owner@grill.test', 'grill');
    await feedback(other.subdomain, { overall: 5 }).expect(201);
    // Invalid feedback does not use up the allowance.
    await feedback(r.subdomain, { overall: 1 }, '203.0.113.9').expect(400);
    for (let index = 0; index < 5; index++) await feedback(r.subdomain, { overall: 5 }, '203.0.113.9').expect(201);

    const before = await t.prisma.review.count();
    expect((await feedback(r.subdomain, { overall: 1, website: 'http://spam.example' }, '203.0.113.10').expect(201)).body).toEqual({ outcome: { status: 'PENDING', google: null } });
    expect(await t.prisma.review.count()).toBe(before);
  });
});

describe('branch Google review link', () => {
  it('is edited with the branch (owner or settings.operational) and shown to owners and diners', async () => {
    const r = await reviewing();
    const url = 'https://search.google.com/local/writereview?placeid=ChIJ123';
    const updated = await http().patch(`/v1/branches/${r.nasrId}`).set(auth(r.token)).send({ googleReviewUrl: url }).expect(200);
    expect(updated.body.googleReviewUrl).toBe(url);
    expect((await http().get('/v1/branches').set(auth(r.token)).expect(200)).body.branches.map((branch: { googleReviewUrl: string | null }) => branch.googleReviewUrl)).toEqual([null, url]);
    const publicView = (await menu(r.subdomain, 'nasr-city')).restaurant;
    expect(publicView.branch.googleReviewUrl).toBe(url);
    expect(publicView.branches.map((branch: { googleReviewUrl: string | null }) => branch.googleReviewUrl)).toEqual([null, url]);

    for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url']) await http().patch(`/v1/branches/${r.nasrId}`).set(auth(r.token)).send({ googleReviewUrl: bad }).expect(400);
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test', { branchId: r.nasrId });
    await http().patch(`/v1/branches/${r.nasrId}`).set(auth(manager.token)).send({ googleReviewUrl: '' }).expect(200);
    expect((await t.prisma.branch.findUniqueOrThrow({ where: { id: r.nasrId } })).googleReviewUrl).toBeNull();
    await http().patch(`/v1/branches/${r.mainId}`).set(auth(manager.token)).send({ googleReviewUrl: url }).expect(403);
    const cashier = await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await http().patch(`/v1/branches/${r.nasrId}`).set(auth(cashier.token)).send({ googleReviewUrl: url }).expect(403);

    // Happy diners at that branch are invited to Google.
    await http().patch(`/v1/branches/${r.nasrId}`).set(auth(r.token)).send({ googleReviewUrl: url }).expect(200);
    expect((await reviewed(r, { overall: 5 }, { branch: 'nasr-city' })).response.outcome.google).toEqual({ url });
    expect((await reviewed(r, { overall: 5 })).response.outcome.google).toBeNull();
  });
});
