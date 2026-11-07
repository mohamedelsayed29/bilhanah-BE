import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Menu = { token: string; restaurantId: string; subdomain: string; koshary: { id: string; large: string }; tea: { id: string; price: string } };

/** Koshary (large 55.50) and tea (15.00), ordering on, and a program: 1 point per 10 EGP. */
async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary', settings: Record<string, unknown> = {}): Promise<Menu> {
  const token = await signUpOwner(t, email);
  const created = await http().post('/v1/restaurants').set(auth(token))
    .send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const koshary = await http().post('/v1/menu/items').set(auth(token))
    .send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ nameAr: 'صغير', pricePiastres: 3500 }, { nameAr: 'كبير', pricePiastres: 5550 }] }).expect(201);
  const tea = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'شاي', variants: [{ pricePiastres: 1500 }] }).expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  await saveSettings(token, settings);
  return { token, restaurantId: created.body.id, subdomain, koshary: { id: koshary.body.id, large: koshary.body.variants[1].id }, tea: { id: tea.body.id, price: tea.body.variants[0].id } };
}

const SETTINGS = {
  enabled: true, nameAr: 'نقاط كشري', nameEn: null, pointsPerUnit: 1, spendUnitPiastres: 1000, earnOn: 'COMPLETED', orderTypes: ['DINE_IN', 'PICKUP'],
  minOrderPiastres: 0, minRedeemPoints: 0, maxDiscountPercent: 100, expiryDays: null,
  cancelReturnsRedeemed: true, refundReversesEarned: true, refundReturnsRedeemed: true, tiersEnabled: false,
};
const saveSettings = (token: string, overrides: Record<string, unknown> = {}) => http().put('/v1/loyalty/settings').set(auth(token)).send({ ...SETTINGS, ...overrides }).expect(200);

/** Two large koshary and a tea: 126.00 EGP, 12 points. */
function order(menu: Menu, body: Record<string, unknown> = {}, key = randomUUID()) {
  return http().post(`/v1/public/restaurants/${menu.subdomain}/orders`).set('Idempotency-Key', key).send({
    type: 'PICKUP',
    customerName: 'Mona',
    customerPhone: '010 9876 5432',
    items: [{ menuItemId: menu.koshary.id, variantId: menu.koshary.large, quantity: 2 }, { menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 1 }],
    ...body,
  });
}

async function complete(token: string, id: string) {
  for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) await http().patch(`/v1/orders/${id}/status`).set(auth(token)).send({ status }).expect(200);
}

const me = (menu: Menu, pass: string) => http().post(`/v1/public/restaurants/${menu.subdomain}/loyalty/me`).send({ pass });
const reward = (menu: Menu, body: Record<string, unknown>) => http().post('/v1/loyalty/rewards').set(auth(menu.token)).send(body).expect(201);

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('earning points', () => {
  it('awards points once, only when the order reaches the completion state, and records them in the ledger', async () => {
    const menu = await restaurant();
    const program = (await http().get(`/v1/public/restaurants/koshary/loyalty`).expect(200)).body;
    expect(program).toMatchObject({ enabled: true, pointsPerUnit: 1, spendUnitPiastres: 1000 });

    const placed = await order(menu).expect(201);
    // The first order creates the membership; its checkout gets the member card.
    const pass = placed.body.loyaltyPass as string;
    expect(pass).toEqual(expect.any(String));
    expect(placed.body.order.loyalty).toEqual({ pointsToEarn: 12, earned: false, pointsSpent: 0, rewardName: null, discountPiastres: 0 });
    // A retry returns the same card; another order with the same phone does not get one.
    const key = randomUUID();
    const second = await order(menu, {}, key).expect(201);
    expect(second.body.loyaltyPass).toBeUndefined();
    expect((await order(menu, {}, key).expect(201)).body.loyaltyPass).toBeUndefined();

    const before = (await me(menu, pass).expect(200)).body;
    expect(before.member).toMatchObject({ balance: 0, name: 'Mona', phone: '•••• 5432' });
    expect(before.pendingPoints).toBe(24);

    const orderId = (await http().get('/v1/orders?view=active').set(auth(menu.token)).expect(200)).body.items[0].id as string;
    await http().patch(`/v1/orders/${orderId}/status`).set(auth(menu.token)).send({ status: 'ACCEPTED' }).expect(200);
    await http().patch(`/v1/orders/${orderId}/status`).set(auth(menu.token)).send({ status: 'READY' }).expect(200);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(0);
    await http().patch(`/v1/orders/${orderId}/status`).set(auth(menu.token)).send({ status: 'COMPLETED' }).expect(200);
    // Completing again is refused; paying afterwards does not award twice.
    await http().patch(`/v1/orders/${orderId}/status`).set(auth(menu.token)).send({ status: 'COMPLETED' }).expect(409);
    await http().patch(`/v1/orders/${orderId}/payment`).set(auth(menu.token)).send({ paid: true, method: 'CARD' }).expect(200);

    const after = (await me(menu, pass).expect(200)).body;
    expect(after.member).toMatchObject({ balance: 12, lifetimePoints: 12 });
    expect(after.history).toHaveLength(1);
    expect(after.history[0]).toMatchObject({ kind: 'EARN', points: 12, balanceAfter: 12, order: { id: orderId } });
    expect(await t.prisma.loyaltyTransaction.count({ where: { orderId, kind: 'EARN' } })).toBe(1);
  });

  it('waits for payment when the program earns on paid orders, and skips order types it does not cover', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { earnOn: 'PAID', orderTypes: ['PICKUP'] });
    const placed = await order(menu).expect(201);
    const pass = placed.body.loyaltyPass as string;
    const id = (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id;
    await complete(menu.token, id);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(0);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(menu.token)).send({ paid: true, method: 'CARD' }).expect(200);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(12);

    // Dine-in is not part of this program: no points, no membership change.
    const dineIn = await order(menu, { type: 'DINE_IN', tableLabel: 'T1' }).expect(201);
    expect(dineIn.body.order.loyalty).toBeNull();
  });

  it('shows the points before ordering, with a tier multiplier', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { tiersEnabled: true });
    await http().put('/v1/loyalty/tiers').set(auth(menu.token)).send({ tiers: [{ nameAr: 'فضي', minLifetimePoints: 0, earnMultiplier: 100 }, { nameAr: 'ذهبي', minLifetimePoints: 10, earnMultiplier: 200 }] }).expect(200);
    const items = [{ menuItemId: menu.koshary.id, variantId: menu.koshary.large, quantity: 2 }, { menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 1 }];
    const anonymous = (await http().post('/v1/public/restaurants/koshary/orders/quote').send({ type: 'PICKUP', items }).expect(200)).body;
    expect(anonymous).toMatchObject({ subtotalPiastres: 12600, totalPiastres: 12600, pointsToEarn: 12, balance: null });

    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    await complete(menu.token, (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id);
    // 12 lifetime points reach gold: twice the points.
    const gold = (await http().post('/v1/public/restaurants/koshary/orders/quote').send({ type: 'PICKUP', items, pass }).expect(200)).body;
    expect(gold).toMatchObject({ pointsToEarn: 24, balance: 12 });
    expect((await me(menu, pass).expect(200)).body.member.tier).toMatchObject({ nameAr: 'ذهبي' });
  });
});

describe('redeeming rewards', () => {
  async function memberWith(menu: Menu, points: number) {
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    const memberId = (await t.prisma.loyaltyMember.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id;
    await http().post(`/v1/loyalty/members/${memberId}/adjustments`).set(auth(menu.token)).send({ points, reason: 'Opening balance' }).expect(201);
    return { pass, memberId };
  }

  it('applies a reward at checkout, validated on the server, and never beyond the balance', async () => {
    const menu = await restaurant();
    const fixed = (await reward(menu, { type: 'FIXED_DISCOUNT', nameAr: 'خصم 20', pointsCost: 50, amountPiastres: 2000 })).body;
    const { pass, memberId } = await memberWith(menu, 60);

    const quote = (await http().post('/v1/public/restaurants/koshary/orders/quote').send({ type: 'PICKUP', items: [{ menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 2 }], pass, rewardId: fixed.id }).expect(200)).body;
    expect(quote).toMatchObject({ subtotalPiastres: 3000, discountPiastres: 2000, totalPiastres: 1000, pointsToEarn: 1, balance: 60, reward: { available: true } });

    const placed = await order(menu, { items: [{ menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 2 }], loyalty: { pass, rewardId: fixed.id } }).expect(201);
    expect(placed.body.order).toMatchObject({ subtotalPiastres: 3000, discountPiastres: 2000, totalPiastres: 1000, loyalty: { pointsSpent: 50, rewardName: 'خصم 20' } });
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(10);
    // Reports take the discount off net sales.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const report = (await http().get(`/v1/reports?from=${day}&to=${day}`).set(auth(menu.token)).expect(200)).body;
    expect(report.summary).toMatchObject({ discounts: 2000 });
    expect(report.summary.net).toBe(report.summary.gross - 2000);

    // 10 points left: the reward is refused, and nothing is ordered.
    const refused = await order(menu, { loyalty: { pass, rewardId: fixed.id } }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'LOYALTY_REWARD_INELIGIBLE', details: { reason: 'NOT_ENOUGH_POINTS' } });
    // A reward without the card, or with a forged one, is refused too.
    await order(menu, { loyalty: { rewardId: fixed.id } }).expect(400);
    expect((await order(menu, { loyalty: { pass: `${pass.slice(0, -2)}xx`, rewardId: fixed.id } }).expect(403)).body.error.code).toBe('LOYALTY_PASS_INVALID');
    // An adjustment cannot take the balance below zero either.
    expect((await http().post(`/v1/loyalty/members/${memberId}/adjustments`).set(auth(menu.token)).send({ points: -11, reason: 'Correction' }).expect(409)).body.error.code).toBe('LOYALTY_BALANCE_TOO_LOW');
  });

  it('two checkouts spending the same points at once: only one goes through', async () => {
    const menu = await restaurant();
    const fixed = (await reward(menu, { type: 'FIXED_DISCOUNT', nameAr: 'خصم', pointsCost: 50, amountPiastres: 1000 })).body;
    const { pass } = await memberWith(menu, 50);
    const results = await Promise.all([1, 2, 3].map(() => order(menu, { loyalty: { pass, rewardId: fixed.id } })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(0);
  });

  it('gives a free product or add-on only when it is in the order, and caps percentages', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { maxDiscountPercent: 50 });
    const freeTea = (await reward(menu, { type: 'FREE_ADDON', nameAr: 'شاي مجاني', pointsCost: 10, menuItemId: menu.tea.id })).body;
    const freeKoshary = (await reward(menu, { type: 'FREE_PRODUCT', nameAr: 'كشري مجاني', pointsCost: 10, menuItemId: menu.koshary.id, variantId: menu.koshary.large })).body;
    const percent = (await reward(menu, { type: 'PERCENT_DISCOUNT', nameAr: '80%', pointsCost: 10, percent: 80, maxDiscountPiastres: 100_000 })).body;
    const { pass } = await memberWith(menu, 100);
    const quote = (items: unknown[], rewardId: string) => http().post('/v1/public/restaurants/koshary/orders/quote').send({ type: 'PICKUP', items, pass, rewardId }).expect(200).then((response) => response.body);
    const teaOnly = [{ menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 1 }];
    const both = [{ menuItemId: menu.koshary.id, variantId: menu.koshary.large, quantity: 1 }, ...teaOnly];

    expect((await quote(teaOnly, freeTea.id)).reward).toMatchObject({ available: false, reason: 'ADDON_NEEDS_ORDER' });
    expect(await quote(both, freeTea.id)).toMatchObject({ discountPiastres: 1500 });
    expect((await quote(teaOnly, freeKoshary.id)).reward).toMatchObject({ available: false, reason: 'ITEM_NOT_IN_ORDER' });
    // A free large koshary is worth 55.50 but the program caps rewards at half the bill (70.50 / 2).
    expect(await quote(both, freeKoshary.id)).toMatchObject({ discountPiastres: 3525 });
    expect(await quote(both, percent.id)).toMatchObject({ discountPiastres: 3525 });
  });

  it('honours limits: the minimum to redeem, uses per member, and the order minimum', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { minRedeemPoints: 40 });
    const once = (await reward(menu, { type: 'FIXED_DISCOUNT', nameAr: 'مرة واحدة', pointsCost: 5, amountPiastres: 500, maxPerMember: 1, minOrderPiastres: 2000 })).body;
    const { pass, memberId } = await memberWith(menu, 30);
    const tea = [{ menuItemId: menu.tea.id, variantId: menu.tea.price, quantity: 2 }];
    expect((await order(menu, { items: tea, loyalty: { pass, rewardId: once.id } }).expect(409)).body.error.details.reason).toBe('BELOW_MIN_REDEEM');
    await http().post(`/v1/loyalty/members/${memberId}/adjustments`).set(auth(menu.token)).send({ points: 20, reason: 'Birthday' }).expect(201);
    expect((await order(menu, { items: tea.map((line) => ({ ...line, quantity: 1 })), loyalty: { pass, rewardId: once.id } }).expect(409)).body.error.details.reason).toBe('BELOW_MIN_ORDER');
    await order(menu, { items: tea, loyalty: { pass, rewardId: once.id } }).expect(201);
    expect((await order(menu, { items: tea, loyalty: { pass, rewardId: once.id } }).expect(409)).body.error.details.reason).toBe('LIMIT_REACHED');
  });
});

describe('reversal rules', () => {
  it('returns spent points when an order is cancelled, and reverses earned points on a refund', async () => {
    const menu = await restaurant();
    const fixed = (await reward(menu, { type: 'FIXED_DISCOUNT', nameAr: 'خصم', pointsCost: 10, amountPiastres: 1000 })).body;
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    const first = (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id;
    await complete(menu.token, first);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(12);

    // Spent on an order that is then cancelled: the 10 points come back.
    const placed = (await order(menu, { loyalty: { pass, rewardId: fixed.id } }).expect(201)).body;
    const second = (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId, loyaltyRewardId: fixed.id } })).id;
    expect(placed.order.loyalty.pointsToEarn).toBe(11);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(2);
    await http().patch(`/v1/orders/${second}/status`).set(auth(menu.token)).send({ status: 'REJECTED', reason: 'Closed' }).expect(200);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(12);

    // A paid, completed order refunded: its 12 points are taken back.
    await http().patch(`/v1/orders/${first}/payment`).set(auth(menu.token)).send({ paid: true, method: 'CARD' }).expect(200);
    await http().patch(`/v1/orders/${first}/payment`).set(auth(menu.token)).send({ paid: false }).expect(200);
    const view = (await me(menu, pass).expect(200)).body;
    expect(view.member.balance).toBe(0);
    expect(view.history.map((entry: { kind: string; points: number }) => [entry.kind, entry.points])).toEqual([['EARN_REVERSAL', -12], ['REDEEM_RETURN', 10], ['REDEEM', -10], ['EARN', 12]]);
    // Paid again (the refund was a mistake): the points come back, once.
    await http().patch(`/v1/orders/${first}/payment`).set(auth(menu.token)).send({ paid: true, method: 'CARD' }).expect(200);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(12);
  });

  it('keeps earned points on a refund when the program says so', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { refundReversesEarned: false });
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    const id = (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id;
    await complete(menu.token, id);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(menu.token)).send({ paid: true, method: 'CARD' }).expect(200);
    await http().patch(`/v1/orders/${id}/payment`).set(auth(menu.token)).send({ paid: false }).expect(200);
    expect((await me(menu, pass).expect(200)).body.member.balance).toBe(12);
  });
});

describe('the program', () => {
  it('is off until the owner enables it, and the service switch turns it off for diners', async () => {
    const token = await signUpOwner(t, 'owner@koshary.test');
    await http().post('/v1/restaurants').set(auth(token)).send({ name: 'R koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
    expect((await http().get('/v1/loyalty/settings').set(auth(token)).expect(200)).body).toMatchObject({ enabled: false, updatedAt: null });
    expect((await http().get('/v1/public/restaurants/koshary/loyalty').expect(200)).body).toEqual({ enabled: false });
    await saveSettings(token);
    expect((await http().get('/v1/public/restaurants/koshary/loyalty').expect(200)).body.enabled).toBe(true);
    await http().put('/v1/restaurants/mine/services/LOYALTY').set(auth(token)).send({ enabled: false }).expect(200);
    expect((await http().get('/v1/public/restaurants/koshary/loyalty').expect(200)).body).toEqual({ enabled: false });
    expect((await http().get('/v1/loyalty/settings').set(auth(token)).expect(409)).body.error.code).toBe('LOYALTY_UNAVAILABLE');
    // Ordering cannot be switched off while loyalty needs it.
    await http().put('/v1/restaurants/mine/services/LOYALTY').set(auth(token)).send({ enabled: true }).expect(200);
    expect((await http().put('/v1/restaurants/mine/services/QR_ORDERING').set(auth(token)).send({ enabled: false }).expect(409)).body.error.code).toBe('SERVICE_DEPENDENTS');
    const audit = await t.prisma.auditLog.findMany({ where: { action: { startsWith: 'loyalty.' } } });
    expect(audit.map((entry) => entry.action)).toContain('loyalty.enabled');
  });

  it('keeps every restaurant’s members, cards and rewards apart', async () => {
    const a = await restaurant('owner@a.test', 'resta');
    const b = await restaurant('owner@b.test', 'restb');
    const rewardA = (await reward(a, { type: 'FIXED_DISCOUNT', nameAr: 'A', pointsCost: 1, amountPiastres: 100 })).body;
    const passA = (await order(a).expect(201)).body.loyaltyPass as string;
    // The same phone at another restaurant is another membership.
    const passB = (await order(b).expect(201)).body.loyaltyPass as string;
    expect(passB).not.toBe(passA);
    expect((await me(b, passA).expect(403)).body.error.code).toBe('LOYALTY_PASS_INVALID');
    const memberA = (await t.prisma.loyaltyMember.findFirstOrThrow({ where: { restaurantId: a.restaurantId } })).id;
    await http().get(`/v1/loyalty/members/${memberA}`).set(auth(b.token)).expect(404);
    await http().post(`/v1/loyalty/members/${memberA}/adjustments`).set(auth(b.token)).send({ points: 5, reason: 'Nope' }).expect(404);
    await http().put(`/v1/loyalty/rewards/${rewardA.id}`).set(auth(b.token)).send({ type: 'FIXED_DISCOUNT', nameAr: 'X', pointsCost: 1, amountPiastres: 100 }).expect(404);
    expect((await order(b, { loyalty: { pass: passB, rewardId: rewardA.id } }).expect(409)).body.error.details.reason).toBe('INACTIVE');
    expect((await http().get('/v1/loyalty/members').set(auth(b.token)).expect(200)).body.total).toBe(1);
  });

  it('lets staff look members up and adjust points only with the permissions, and issues a new card', async () => {
    const menu = await restaurant();
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    const memberId = (await t.prisma.loyaltyMember.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id;
    await http().post('/v1/kitchen-accounts').set(auth(menu.token)).send({ fullName: 'Cashier One', email: 'cashier@koshary.test', password: 'staff-password', role: 'CASHIER' }).expect(201);
    const cashier = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'cashier@koshary.test', password: 'staff-password' }).expect(200)).body.accessToken as string;
    await http().get('/v1/loyalty/members').set(auth(cashier)).expect(403);

    const found = (await http().get('/v1/loyalty/members?q=5432').set(auth(menu.token)).expect(200)).body;
    expect(found.items[0]).toMatchObject({ id: memberId, phone: '01098765432', balance: 0 });
    const adjusted = (await http().post(`/v1/loyalty/members/${memberId}/adjustments`).set(auth(menu.token)).send({ points: 25, reason: 'Welcome gift' }).expect(201)).body;
    expect(adjusted.history[0]).toMatchObject({ kind: 'ADJUST', points: 25, reason: 'Welcome gift', actorName: expect.any(String) });

    const card = (await http().post(`/v1/loyalty/members/${memberId}/card`).set(auth(menu.token)).expect(201)).body;
    expect(card.url).toContain('/loyalty#card=');
    // The old card stops working; the new one shows the balance.
    await me(menu, pass).expect(403);
    expect((await me(menu, card.pass).expect(200)).body.member.balance).toBe(25);
  });

  it('expires balances after the inactivity period', async () => {
    const menu = await restaurant('owner@koshary.test', 'koshary', { expiryDays: 30 });
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    const member = await t.prisma.loyaltyMember.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } });
    await http().post(`/v1/loyalty/members/${member.id}/adjustments`).set(auth(menu.token)).send({ points: 40, reason: 'Gift' }).expect(201);
    expect((await me(menu, pass).expect(200)).body.member.expiresAt).not.toBeNull();
    await t.prisma.loyaltyMember.update({ where: { id: member.id }, data: { lastActivityAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
    const view = (await me(menu, pass).expect(200)).body;
    expect(view.member.balance).toBe(0);
    expect(view.history[0]).toMatchObject({ kind: 'EXPIRE', points: -40 });
  });

  it('reports analytics: repeat customers, redemption and returning revenue', async () => {
    const menu = await restaurant();
    const fixed = (await reward(menu, { type: 'FIXED_DISCOUNT', nameAr: 'خصم', pointsCost: 12, amountPiastres: 1000 })).body;
    const pass = (await order(menu).expect(201)).body.loyaltyPass as string;
    await complete(menu.token, (await t.prisma.order.findFirstOrThrow({ where: { restaurantId: menu.restaurantId } })).id);
    await order(menu, { loyalty: { pass, rewardId: fixed.id } }).expect(201);
    await order(menu, { customerName: 'Ali', customerPhone: '01111111111' }).expect(201);
    for (const row of await t.prisma.order.findMany({ where: { restaurantId: menu.restaurantId, status: 'PLACED' } })) await complete(menu.token, row.id);

    const stats = (await http().get('/v1/loyalty/analytics?days=30').set(auth(menu.token)).expect(200)).body;
    expect(stats).toMatchObject({
      members: 2, newMembers: 2, customers: 2, returningCustomers: 1, repeatCustomerRate: 0.5,
      pointsRedeemed: 12, rewardsRedeemed: 1, discountPiastres: 1000, returningRevenuePiastres: 11600,
    });
    // 12 + 11 + 12 points earned.
    expect(stats.pointsIssued).toBe(35);
    expect(stats.redemptionRate).toBeCloseTo(12 / 35);
    expect(stats.topRewards[0]).toMatchObject({ name: 'خصم', redemptions: 1 });
  });
});
