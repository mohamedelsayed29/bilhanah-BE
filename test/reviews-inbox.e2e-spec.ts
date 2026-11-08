import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { auth, fixtures } from './reviews-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

// The restaurant's side: the inbox and a review's detail, replies, moderation, follow-ups, stats,
// the dish report, the CSV export, low-rating alerts, realtime events, permissions and tenant isolation.

let t: TestApp;
let baseUrl: string;
const { http, reviewing, settings, completed, submit, reviewed, staff } = fixtures(() => t);

const PHONE = '01077778888';
const inbox = (token: string, query = '') => http().get(`/v1/reviews${query}`).set(auth(token));
const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id);

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/owner`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Collects the review events a socket receives. */
function listen(socket: Socket) {
  const events: { name: string; review: { id: string; branchId: string; overall: number; contactPhone: string | null; lowRating: boolean } }[] = [];
  socket.onAny((name: string, payload: { review?: never }) => {
    if (name.startsWith('review.') && payload.review) events.push({ name, review: payload.review });
  });
  return events;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('reviews inbox', () => {
  it('lists every review newest first with filters, and shows one with its order, dishes, reply and history', async () => {
    const r = await reviewing({ publishMinStars: 4, subRatings: ['food', 'service', 'speed'] });
    const low = await reviewed(r, { overall: 1, ratings: { speed: 1 }, tags: ['SLOW', 'COLD_FOOD'], comment: 'ساعة إلا ربع والأكل وصل بارد', name: 'Karim Fathy', contactPhone: PHONE, contactConsent: true });
    const good = await reviewed(r, { overall: 5, tags: ['DELICIOUS'], name: 'Mona Ahmed' });
    const nasr = await reviewed(r, { overall: 4, comment: 'Nice and quick' }, { branch: 'nasr-city' });
    const placed = await t.prisma.order.findUniqueOrThrow({ where: { id: low.orderId } });

    const all = (await inbox(r.token).expect(200)).body;
    expect(all).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(ids(all)).toEqual([nasr.reviewId, good.reviewId, low.reviewId]);
    expect(all.items[2]).toMatchObject({
      branchId: r.mainId, orderId: low.orderId, orderNumber: placed.number, verified: true, source: 'ORDER', overall: 1, ratings: { speed: 1 },
      tags: [{ code: 'SLOW', sentiment: 'NEGATIVE' }, { code: 'COLD_FOOD', sentiment: 'NEGATIVE' }], comment: 'ساعة إلا ربع والأكل وصل بارد',
      authorName: 'Karim Fathy', displayName: 'Karim F.', hasContact: true, contactPhone: PHONE, status: 'PENDING', lowRating: true,
      followUp: { status: 'OPEN', assigneeId: null }, reply: null, hidden: null, dishCount: 0, edited: false,
    });

    const filter = async (query: string) => ids((await inbox(r.token, query).expect(200)).body);
    expect(await filter('?stars=1,2')).toEqual([low.reviewId]);
    expect(await filter('?status=PUBLISHED')).toEqual([nasr.reviewId, good.reviewId]);
    expect(await filter(`?branchId=${r.nasrId}`)).toEqual([nasr.reviewId]);
    expect(await filter('?hasComment=false')).toEqual([good.reviewId]);
    expect(await filter('?followUp=OPEN')).toEqual([low.reviewId]);
    expect(await filter('?followUp=NONE')).toEqual([nasr.reviewId, good.reviewId]);
    expect(await filter('?verified=false')).toEqual([]);
    expect(await filter(`?q=${encodeURIComponent('بارد')}`)).toEqual([low.reviewId]);
    expect(await filter('?q=quick')).toEqual([nasr.reviewId]);
    expect(await filter('?q=delicious')).toEqual([good.reviewId]);
    expect(await filter(`?q=%23${placed.number}`)).toContain(low.reviewId);
    // The restaurant's day (Africa/Cairo), not UTC's: they differ for two hours after midnight.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    expect(await filter(`?from=${today}&to=${today}`)).toHaveLength(3);
    expect(await filter('?from=2020-01-01&to=2020-01-31')).toEqual([]);
    expect(ids((await inbox(r.token, '?pageSize=2&page=2').expect(200)).body)).toEqual([low.reviewId]);
    for (const query of ['?stars=6', '?status=LOST', '?verified=maybe', '?branchId=nope', '?from=yesterday']) await inbox(r.token, query).expect(400);

    await submit(good.token, { overall: 5, tags: ['DELICIOUS'], dishes: [{ orderItemId: good.itemIds[0], rating: 5 }] }).expect(200);
    await http().put(`/v1/reviews/${good.reviewId}/reply`).set(auth(r.token)).send({ text: 'Thank you, Mona!' }).expect(200);
    const detail = (await http().get(`/v1/reviews/${good.reviewId}`).set(auth(r.token)).expect(200)).body;
    expect(detail).toMatchObject({
      edited: true,
      order: { id: good.orderId, type: 'PICKUP', subtotalPiastres: 12_000, items: [{ nameAr: 'كشري', variantNameAr: 'كبير', quantity: 2, lineTotalPiastres: 10_000 }, { nameAr: 'ليمون نعناع', quantity: 1, lineTotalPiastres: 2000 }] },
      dishes: [{ orderItemId: good.itemIds[0], menuItemId: r.koshary.id, nameAr: 'كشري', rating: 5 }],
      reply: { text: 'Thank you, Mona!', byName: 'Test Owner' },
      photos: [],
    });
    expect(detail.history.map((event: { kind: string }) => event.kind)).toEqual(['CREATED', 'EDITED', 'REPLIED']);
    await http().get(`/v1/reviews/${crypto.randomUUID()}`).set(auth(r.token)).expect(404);
    await http().get('/v1/reviews/not-a-uuid').set(auth(r.token)).expect(400);
  });
});

describe('replies and moderation', () => {
  it('keeps one editable public reply, publishes and hides with an audited reason', async () => {
    const r = await reviewing({ publishMode: 'MANUAL', showOnMenu: true });
    const review = await reviewed(r, { overall: 3, comment: 'Average' });
    const reply = (text: string) => http().put(`/v1/reviews/${review.reviewId}/reply`).set(auth(r.token)).send({ text });

    const first = (await reply('شكرًا على رأيك').expect(200)).body.reply;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await reply('شكرًا على رأيك، هنحسّن').expect(200)).body.reply;
    expect(second).toMatchObject({ text: 'شكرًا على رأيك، هنحسّن', at: first.at });
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.at));
    await reply('').expect(400);
    await reply('x'.repeat(1001)).expect(400);

    await http().post(`/v1/reviews/${review.reviewId}/publish`).set(auth(r.token)).expect(200);
    let publicPage = (await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(200)).body;
    expect(publicPage.items[0]).toMatchObject({ id: review.reviewId, reply: { text: 'شكرًا على رأيك، هنحسّن' } });
    await http().delete(`/v1/reviews/${review.reviewId}/reply`).set(auth(r.token)).expect(200);
    publicPage = (await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(200)).body;
    expect(publicPage.items[0].reply).toBeNull();

    // Hiding needs a reason; it is kept and audited, and the restaurant still sees the review.
    await http().post(`/v1/reviews/${review.reviewId}/hide`).set(auth(r.token)).send({}).expect(400);
    await http().post(`/v1/reviews/${review.reviewId}/hide`).set(auth(r.token)).send({ reason: '' }).expect(400);
    const hidden = (await http().post(`/v1/reviews/${review.reviewId}/hide`).set(auth(r.token)).send({ reason: 'Mentions a staff member by full name' }).expect(200)).body;
    expect(hidden).toMatchObject({ status: 'HIDDEN', hidden: { reason: 'Mentions a staff member by full name', byName: 'Test Owner' } });
    expect((await http().get(`/v1/public/restaurants/${r.subdomain}/reviews`).expect(200)).body.items).toEqual([]);
    const audits = await t.prisma.auditLog.findMany({ where: { targetId: review.reviewId }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((audit) => audit.action)).toEqual(['review.published', 'review.hidden']);
    expect(audits[1]!.metadata).toMatchObject({ reason: 'Mentions a staff member by full name', from: 'PUBLISHED' });
    // The diner's edit keeps it hidden.
    await submit(review.token, { overall: 5 }).expect(200);
    expect((await t.prisma.review.findUniqueOrThrow({ where: { id: review.reviewId } })).status).toBe('HIDDEN');
    // Publishing again lifts the reason.
    expect((await http().post(`/v1/reviews/${review.reviewId}/publish`).set(auth(r.token)).expect(200)).body).toMatchObject({ status: 'PUBLISHED', hidden: null });
    expect((await http().get(`/v1/reviews/${review.reviewId}`).set(auth(r.token)).expect(200)).body.history.map((event: { kind: string }) => event.kind))
      .toEqual(['CREATED', 'REPLIED', 'REPLIED', 'PUBLISHED', 'REPLY_REMOVED', 'HIDDEN', 'EDITED', 'PUBLISHED']);
  });
});

describe('follow-ups', () => {
  it('opens for unhappy diners and moves along with internal notes, an assignee checked against the restaurant and branch, and history', async () => {
    const r = await reviewing();
    const review = await reviewed(r, { overall: 2, comment: 'Wrong order', contactPhone: PHONE, contactConsent: true });
    const happy = await reviewed(r, { overall: 5 });
    expect((await t.prisma.review.findUniqueOrThrow({ where: { id: happy.reviewId } })).followUpStatus).toBeNull();
    const followUp = (body: Record<string, unknown>, token = r.token, id = review.reviewId) => http().patch(`/v1/reviews/${id}/follow-up`).set(auth(token)).send(body);

    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    const nasrManager = await staff(r.token, 'MANAGER', 'nasr@koshary.test', { branchId: r.nasrId });
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    const responder = await staff(r.token, 'WAITER', 'responder@koshary.test', { permissions: ['reviews.view', 'reviews.respond'] });
    const other = await reviewing({}, 'owner@grill.test', 'grill');
    const outsider = await staff(other.token, 'MANAGER', 'manager@grill.test');

    const assignees = (await http().get('/v1/reviews/assignees').set(auth(r.token)).expect(200)).body;
    expect(assignees.map((account: { fullName: string }) => account.fullName).sort()).toEqual(['MANAGER manager@koshary.test', 'MANAGER nasr@koshary.test', 'Test Owner', 'WAITER responder@koshary.test'].sort());
    const atMain = (await http().get(`/v1/reviews/assignees?branchId=${r.mainId}`).set(auth(r.token)).expect(200)).body;
    expect(atMain.some((account: { id: string }) => account.id === nasrManager.id)).toBe(false);

    for (const assigneeId of [outsider.id, nasrManager.id, waiter.id, crypto.randomUUID()]) {
      expect((await followUp({ status: 'CONTACTED', assigneeId }).expect(400)).body.error.code).toBe('REVIEW_ASSIGNEE_INVALID');
    }
    await followUp({ status: 'WAITING' }).expect(400);
    const contacted = (await followUp({ status: 'CONTACTED', note: 'كلمته واعتذرنا، هنبعتله الطلب تاني', assigneeId: responder.id }).expect(200)).body;
    expect(contacted.followUp).toMatchObject({ status: 'CONTACTED', assigneeId: responder.id, assigneeName: 'WAITER responder@koshary.test' });
    // The assignee (reviews.respond) moves it on; the assignee stays when not sent.
    const resolved = (await followUp({ status: 'RESOLVED', note: 'Sent a free meal' }, responder.token).expect(200)).body;
    expect(resolved.followUp).toMatchObject({ status: 'RESOLVED', assigneeId: responder.id });
    expect(resolved.contactPhone).toBe(PHONE);
    const cleared = (await followUp({ status: 'RESOLVED', assigneeId: null }, manager.token).expect(200)).body;
    expect(cleared.followUp).toMatchObject({ assigneeId: null, assigneeName: null });
    expect(cleared.history.filter((event: { kind: string }) => event.kind === 'FOLLOW_UP')).toEqual([
      expect.objectContaining({ followUpStatus: 'CONTACTED', note: 'كلمته واعتذرنا، هنبعتله الطلب تاني', assigneeName: 'WAITER responder@koshary.test', actorName: 'Test Owner' }),
      expect.objectContaining({ followUpStatus: 'RESOLVED', note: 'Sent a free meal', assigneeName: 'WAITER responder@koshary.test', actorName: 'WAITER responder@koshary.test' }),
      expect.objectContaining({ followUpStatus: 'RESOLVED', note: null, assigneeName: null, actorName: 'MANAGER manager@koshary.test' }),
    ]);
    // Without reviews.respond: no follow-ups, no replies.
    await followUp({ status: 'OPEN' }, waiter.token).expect(403);
    // The branch's own manager cannot act on another branch's review.
    expect((await followUp({ status: 'OPEN' }, nasrManager.token).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    await followUp({ status: 'OPEN' }, outsider.token).expect(404);
  });
});

describe('stats, dishes and export', () => {
  it('summarises every review of the period, ranks dishes and exports CSV (phones only for those who may see them)', async () => {
    const r = await reviewing({ publishMinStars: 4 });
    const rate = async (overall: number, kosharyRating: number, extra: Record<string, unknown> = {}, orderExtra: Record<string, unknown> = {}) => {
      const placed = await completed(r, orderExtra);
      await submit(placed.token, { overall, dishes: [{ orderItemId: placed.itemIds[0], rating: kosharyRating }, { orderItemId: placed.itemIds[1], rating: 5 }], ...(overall < 3 && { comment: 'مش حلو' }), ...extra }).expect(200);
      return (await t.prisma.review.findUniqueOrThrow({ where: { orderId: placed.orderId } })).id;
    };
    const first = await rate(5, 5, { tags: ['DELICIOUS', 'FAST'], ratings: { food: 5 } });
    await rate(4, 5, { tags: ['DELICIOUS'], comment: 'الكشري ممتاز', name: 'Hana, "the critic"' });
    const unhappy = await rate(2, 1, { tags: ['COLD_FOOD'], contactPhone: PHONE, contactConsent: true, ratings: { food: 2, service: 1 } });
    await rate(1, 1, { comment: '=HYPERLINK("http://evil")' }, { branch: 'nasr-city' });
    await t.prisma.review.update({ where: { id: first }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await http().put(`/v1/reviews/${first}/reply`).set(auth(r.token)).send({ text: 'Thanks!' }).expect(200);
    await http().patch(`/v1/reviews/${unhappy}/follow-up`).set(auth(r.token)).send({ status: 'CONTACTED' }).expect(200);

    const stats = (await http().get('/v1/reviews/stats?days=7').set(auth(r.token)).expect(200)).body;
    expect(stats).toMatchObject({
      days: 7, count: 4, average: 3, distribution: { '1': 1, '2': 1, '3': 0, '4': 1, '5': 1 },
      subRatings: { food: { average: 3.5, count: 2 }, service: { average: 1, count: 1 } },
      replyRate: 0.25, unhappy: 2, unhappyFollowedUpShare: 0.5, verifiedShare: 1, pending: 2, openFollowUps: 2,
    });
    expect(stats.medianReplyMinutes).toBeGreaterThanOrEqual(119);
    expect(stats.series).toHaveLength(7);
    expect(stats.series.at(-1)).toMatchObject({ count: expect.any(Number) });
    expect(stats.series.reduce((sum: number, day: { count: number }) => sum + day.count, 0)).toBe(4);
    expect(stats.tags.map((tag: { code: string; count: number }) => [tag.code, tag.count])).toEqual([['DELICIOUS', 2], ['COLD_FOOD', 1], ['FAST', 1]]);
    expect(stats.dishRanking.map((dish: { nameAr: string; average: number; count: number; upShare: number; downShare: number }) => [dish.nameAr, dish.average, dish.count, dish.upShare, dish.downShare])).toEqual([
      ['ليمون نعناع', 5, 4, 1, 0],
      ['كشري', 3, 4, 0.5, 0.5],
    ]);
    const branchStats = (await http().get(`/v1/reviews/stats?branchId=${r.nasrId}`).set(auth(r.token)).expect(200)).body;
    expect(branchStats).toMatchObject({ days: 30, count: 1, average: 1, pending: 1 });
    await http().get('/v1/reviews/stats?days=0').set(auth(r.token)).expect(400);
    await http().get('/v1/reviews/stats?days=367').set(auth(r.token)).expect(400);

    const dishes = (await http().get('/v1/reviews/dishes').set(auth(r.token)).expect(200)).body;
    expect(dishes).toMatchObject({ days: 30, dishRatingScale: 'THUMBS' });
    const koshary = dishes.dishes.find((dish: { menuItemId: string }) => dish.menuItemId === r.koshary.id);
    expect(koshary).toMatchObject({ average: 3, count: 4, upShare: 0.5 });
    expect(koshary.recentComments.map((comment: { comment: string }) => comment.comment)).toEqual(['=HYPERLINK("http://evil")', 'مش حلو', 'الكشري ممتاز']);

    const csv = await http().get('/v1/reviews/export').set(auth(r.token)).expect(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="reviews-koshary-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('date,branch,order,verified,source,overall,food,service,value,speed,cleanliness,atmosphere,tags,comment,name,contact phone,status,reply,follow-up,assignee');
    expect(lines).toHaveLength(5);
    expect(csv.text).toContain(PHONE);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.text).toContain('"Hana, ""the critic"""');
    const filtered = await http().get('/v1/reviews/export?stars=1').set(auth(r.token)).expect(200);
    expect(filtered.text.replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(2);

    // Someone who reads reviews but does not follow diners up never sees their phone numbers.
    const reader = await staff(r.token, 'WAITER', 'reader@koshary.test', { permissions: ['reviews.view'] });
    const theirs = await http().get('/v1/reviews/export').set(auth(reader.token)).expect(200);
    expect(theirs.text.split('\r\n')[0]).not.toContain('contact phone');
    expect(theirs.text).not.toContain(PHONE);
    const theirInbox = (await inbox(reader.token, '?stars=2').expect(200)).body.items[0];
    expect(theirInbox).toMatchObject({ hasContact: true, contactPhone: null });
    expect((await http().get(`/v1/reviews/${unhappy}`).set(auth(reader.token)).expect(200)).body.contactPhone).toBeNull();
    await http().put(`/v1/reviews/${unhappy}/reply`).set(auth(reader.token)).send({ text: 'Sorry' }).expect(403);
    await http().post(`/v1/reviews/${unhappy}/publish`).set(auth(reader.token)).expect(403);
    await http().get('/v1/reviews/assignees').set(auth(reader.token)).expect(403);
  });
});

describe('low-rating alerts', () => {
  it('emails the owner and the staff who follow reviews up at that branch, in their language, once per review', async () => {
    const r = await reviewing();
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test', { branchId: r.mainId });
    await t.prisma.user.update({ where: { id: manager.id }, data: { preferredLanguage: 'en' } });
    await staff(r.token, 'MANAGER', 'nasr@koshary.test', { branchId: r.nasrId });
    await staff(r.token, 'CASHIER', 'cashier@koshary.test');
    await staff(r.token, 'WAITER', 'responder@koshary.test', { permissions: ['reviews.view', 'reviews.respond'] });
    const alerts = () => t.mailer.sent.filter((message) => /\d\/5/.test(message.subject));
    t.mailer.sent.length = 0;

    await reviewed(r, { overall: 3 });
    expect(alerts()).toEqual([]);
    const low = await reviewed(r, { overall: 2, comment: 'الأكل وصل بارد', contactPhone: PHONE, contactConsent: true });
    expect(alerts().map((message) => message.to).sort()).toEqual(['manager@koshary.test', 'owner@koshary.test', 'responder@koshary.test']);
    const owner = alerts().find((message) => message.to === 'owner@koshary.test')!;
    expect(owner.subject).toBe('تقييم 2/5 في الفرع الرئيسي');
    expect(owner.text).toContain('الأكل وصل بارد');
    expect(owner.text).toContain(`http://dashboard.test/reviews/${low.reviewId}`);
    expect(owner.text).not.toContain(PHONE);
    expect(alerts().find((message) => message.to === 'manager@koshary.test')!.subject).toBe('2/5 review at الفرع الرئيسي');

    // Editing, even lower, does not alert again.
    await submit(low.token, { overall: 1, comment: 'Worse' }).expect(200);
    expect(alerts()).toHaveLength(3);
    expect((await t.prisma.review.findUniqueOrThrow({ where: { id: low.reviewId } })).alertedAt).not.toBeNull();
    // A review that drops below the threshold on edit alerts then.
    const edited = await reviewed(r, { overall: 4 });
    await submit(edited.token, { overall: 1, comment: 'Got sick' }).expect(200);
    expect(alerts()).toHaveLength(6);
    // The threshold is the owner's.
    await settings(r.token, { alertBelowStars: 0 }).expect(200);
    await reviewed(r, { overall: 1, comment: 'Bad' });
    expect(alerts()).toHaveLength(6);
  });
});

describe('realtime review events', () => {
  it('reach only sockets whose account holds reviews.view, in their branch', async () => {
    const r = await reviewing();
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    const grantedKitchen = await staff(r.token, 'KITCHEN', 'kitchen2@koshary.test', { permissions: ['reviews.view'] });
    const nasrManager = await staff(r.token, 'MANAGER', 'nasr@koshary.test', { branchId: r.nasrId });
    const sockets = await Promise.all([r.token, kitchen.token, grantedKitchen.token, nasrManager.token].map(connect));
    const [owner, plain, granted, nasr] = sockets.map(listen);
    try {
      const main = await reviewed(r, { overall: 2, comment: 'Late', contactPhone: PHONE, contactConsent: true });
      await reviewed(r, { overall: 5 }, { branch: 'nasr-city' });
      await http().put(`/v1/reviews/${main.reviewId}/reply`).set(auth(r.token)).send({ text: 'Sorry!' }).expect(200);
      await settle();
      expect(owner!.map((event) => [event.name, event.review.overall])).toEqual([['review.created', 2], ['review.created', 5], ['review.updated', 2]]);
      expect(owner![0]!.review).toMatchObject({ id: main.reviewId, lowRating: true, contactPhone: null });
      expect(granted!.map((event) => event.name)).toEqual(['review.created', 'review.created', 'review.updated']);
      expect(nasr!.map((event) => [event.name, event.review.branchId])).toEqual([['review.created', r.nasrId]]);
      expect(plain).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
    }
  });
});

describe('permissions and tenant isolation', () => {
  it('keeps other restaurants’ reviews unknown and branch staff to their branch', async () => {
    const r = await reviewing();
    const mainReview = await reviewed(r, { overall: 4 });
    const nasrReview = await reviewed(r, { overall: 3 }, { branch: 'nasr-city' });
    const other = await reviewing({}, 'owner@grill.test', 'grill');
    const foreign = await reviewed(other, { overall: 5 });

    // Another restaurant's review and branches look unknown.
    await http().get(`/v1/reviews/${foreign.reviewId}`).set(auth(r.token)).expect(404);
    await http().put(`/v1/reviews/${foreign.reviewId}/reply`).set(auth(r.token)).send({ text: 'Hi' }).expect(404);
    await http().post(`/v1/reviews/${foreign.reviewId}/hide`).set(auth(r.token)).send({ reason: 'Not ours' }).expect(404);
    await http().get(`/v1/reviews/${foreign.reviewId}/photos/${crypto.randomUUID()}`).set(auth(r.token)).expect(404);
    expect((await inbox(r.token, `?branchId=${other.mainId}`).expect(404)).body.error.code).toBe('BRANCH_NOT_FOUND');
    expect(ids((await inbox(other.token).expect(200)).body)).toEqual([foreign.reviewId]);

    // A manager tied to Nasr City sees only its reviews.
    const nasrManager = await staff(r.token, 'MANAGER', 'nasr@koshary.test', { branchId: r.nasrId });
    expect(ids((await inbox(nasrManager.token).expect(200)).body)).toEqual([nasrReview.reviewId]);
    expect((await inbox(nasrManager.token, `?branchId=${r.mainId}`).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    expect((await http().get(`/v1/reviews/${mainReview.reviewId}`).set(auth(nasrManager.token)).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    await http().post(`/v1/reviews/${mainReview.reviewId}/hide`).set(auth(nasrManager.token)).send({ reason: 'Not my branch' }).expect(403);
    await http().get(`/v1/reviews/${nasrReview.reviewId}`).set(auth(nasrManager.token)).expect(200);
    expect((await http().get('/v1/reviews/stats').set(auth(nasrManager.token)).expect(200)).body.count).toBe(1);
    expect((await http().get('/v1/reviews/export').set(auth(nasrManager.token)).expect(200)).text.trim().split('\r\n')).toHaveLength(2);
    await http().post(`/v1/reviews/${nasrReview.reviewId}/hide`).set(auth(nasrManager.token)).send({ reason: 'Duplicate review' }).expect(200);

    // Roles without the permissions are refused; grants open exactly what they name.
    const kitchen = await staff(r.token, 'KITCHEN', 'kitchen@koshary.test');
    for (const path of ['/v1/reviews', '/v1/reviews/stats', '/v1/reviews/export', `/v1/reviews/${mainReview.reviewId}`]) await http().get(path).set(auth(kitchen.token)).expect(403);
    const moderator = await staff(r.token, 'CASHIER', 'moderator@koshary.test', { permissions: ['reviews.view', 'reviews.moderate'] });
    await http().post(`/v1/reviews/${mainReview.reviewId}/hide`).set(auth(moderator.token)).send({ reason: 'Testing grants' }).expect(200);
    await http().put(`/v1/reviews/${mainReview.reviewId}/reply`).set(auth(moderator.token)).send({ text: 'Hi' }).expect(403);
    await settings(moderator.token, { enabled: false }).expect(403);
    await http().get('/v1/reviews').expect(401);
  });
});
