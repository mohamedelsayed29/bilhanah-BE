import request from 'supertest';
import { createAdmin } from '../src/commands/create-admin.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { ADMIN_PASSWORD, createTestApp, currentCode, DASHBOARD_ORIGIN, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ownerWithRestaurant(email: string, subdomain: string, name = 'Koshary Abou Tarek') {
  const token = await signUpOwner(t, email);
  const response = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  return { token, id: response.body.id as string };
}

const adminLogin = (body: Record<string, unknown>) =>
  http().post('/v1/auth/admin/login').set('Origin', DASHBOARD_ORIGIN).send(body);

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('administrator sign-in', () => {
  it('requires the password and a fresh authenticator code', async () => {
    const { secret } = await signInAdmin(t);

    const wrongCode = await adminLogin({ email: 'admin@bilhanah.test', password: ADMIN_PASSWORD, code: '000000' }).expect(401);
    expect(wrongCode.body.error.code).toBe('INVALID_CREDENTIALS');
    const wrongPassword = await adminLogin({ email: 'admin@bilhanah.test', password: 'not-the-password', code: currentCode(secret, 1) }).expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    // signInAdmin used the current step; the next one still works once, then is spent.
    const next = currentCode(secret, 1);
    const ok = await adminLogin({ email: 'admin@bilhanah.test', password: ADMIN_PASSWORD, code: next }).expect(200);
    expect(ok.body.user.role).toBe('ADMIN');
    await adminLogin({ email: 'admin@bilhanah.test', password: ADMIN_PASSWORD, code: next }).expect(401);
  });

  it('ends administrator sessions after 12 hours', async () => {
    await signInAdmin(t);
    const [session] = await t.prisma.session.findMany();
    expect(session!.expiresAt.getTime() - session!.createdAt.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it('keeps owners and administrators on their own sign-in', async () => {
    const { secret } = await signInAdmin(t);
    await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'admin@bilhanah.test', password: ADMIN_PASSWORD }).expect(401);

    await signUpOwner(t, 'owner@koshary.test');
    await adminLogin({ email: 'owner@koshary.test', password: 'correct-horse-battery', code: currentCode(secret) }).expect(401);
  });

  it('gives the admin console its own session cookie, separate from restaurant sessions', async () => {
    const { secret } = await signInAdmin(t);
    const login = await adminLogin({ email: 'admin@bilhanah.test', password: ADMIN_PASSWORD, code: currentCode(secret, 1) }).expect(200);
    const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    const admin = cookies.find((value) => value.startsWith('bh_admin_refresh='))!;
    expect(admin).toContain('Path=/v1/auth/admin');
    expect(cookies.some((value) => value.startsWith('bh_refresh='))).toBe(false);
    const pair = admin.split(';')[0]!;

    // The admin console refreshes it; a restaurant dashboard cannot use an administrator session.
    const refreshed = await http().post('/v1/auth/admin/refresh').set('Origin', DASHBOARD_ORIGIN).set('Cookie', pair).expect(200);
    expect(refreshed.body.user.role).toBe('ADMIN');
    const next = ([] as string[]).concat(refreshed.headers['set-cookie'] ?? []).find((value) => value.startsWith('bh_admin_refresh='))!.split(';')[0]!;
    await http().post('/v1/auth/refresh').set('Origin', DASHBOARD_ORIGIN).set('Cookie', next.replace('bh_admin_refresh', 'bh_refresh')).expect(401);

    // And an owner's session never renews in the admin console.
    await signUpOwner(t, 'owner@koshary.test');
    const owner = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'owner@koshary.test', password: 'correct-horse-battery' }).expect(200);
    const ownerPair = ([] as string[]).concat(owner.headers['set-cookie'] ?? []).find((value) => value.startsWith('bh_refresh='))!.split(';')[0]!;
    await http().post('/v1/auth/admin/refresh').set('Origin', DASHBOARD_ORIGIN).set('Cookie', ownerPair.replace('bh_refresh', 'bh_admin_refresh')).expect(401);

    await http().post('/v1/auth/admin/logout').set('Origin', DASHBOARD_ORIGIN).set('Cookie', next).expect(204);
  });

  it('explains when an administrator has no authenticator', async () => {
    const passwords = t.app.get(PasswordService);
    await createAdmin(t.prisma, (value) => passwords.hash(value), { email: 'old@bilhanah.test', fullName: 'Old Admin', password: ADMIN_PASSWORD });
    const response = await adminLogin({ email: 'old@bilhanah.test', password: ADMIN_PASSWORD, code: '123456' }).expect(403);
    expect(response.body.error.code).toBe('MFA_NOT_SET_UP');
  });

  it('stores the authenticator secret encrypted', async () => {
    const { secret } = await signInAdmin(t);
    const admin = await t.prisma.user.findUniqueOrThrow({ where: { email: 'admin@bilhanah.test' } });
    expect(admin.totpSecret).toMatch(/^v1\./);
    expect(admin.totpSecret).not.toContain(secret);
  });
});

describe('administration API', () => {
  it('is closed to owners and to anonymous callers', async () => {
    const owner = await signUpOwner(t, 'owner@koshary.test');
    const forbidden = await http().get('/v1/admin/overview').set(auth(owner)).expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    await http().get('/v1/admin/overview').expect(401);
    // ...and owner routes are closed to administrators.
    const { token } = await signInAdmin(t);
    await http().get('/v1/billing').set(auth(token)).expect(403);
  });

  it('summarizes restaurants, revenue and the payment queue', async () => {
    const { token } = await signInAdmin(t);
    const paid = await ownerWithRestaurant('paid@koshary.test', 'paid');
    const expired = await ownerWithRestaurant('expired@koshary.test', 'expired');
    await ownerWithRestaurant('trial@koshary.test', 'trial');
    const now = Date.now();
    await t.prisma.entitlement.updateMany({
      where: { restaurantId: { in: [paid.id, expired.id] } },
      data: { startsAt: new Date(now - 40 * DAY_MS), endsAt: new Date(now - 10 * DAY_MS) },
    });
    await t.prisma.entitlement.create({
      data: { restaurantId: paid.id, kind: 'PAID', planCode: 'ORDERS', startsAt: new Date(now - DAY_MS), endsAt: new Date(now + 5 * DAY_MS) },
    });

    const overview = await http().get('/v1/admin/overview').set(auth(token)).expect(200);
    expect(overview.body).toMatchObject({
      restaurants: { total: 3, TRIAL: 1, PAID: 1, INACTIVE: 1, SUSPENDED: 0 },
      pendingPayments: 0,
      monthlyRecurringPiastres: 35000,
      expiringSoon: 1,
      newRestaurantsLast30Days: 3,
    });
  });

  it('finds restaurants by name, subdomain or owner email, and filters by access', async () => {
    const { token } = await signInAdmin(t);
    await ownerWithRestaurant('tarek@koshary.test', 'abou-tarek', 'Koshary Abou Tarek');
    const other = await ownerWithRestaurant('mona@felfela.test', 'felfela', 'Felfela');
    await t.prisma.entitlement.updateMany({
      where: { restaurantId: other.id },
      data: { startsAt: new Date(Date.now() - 40 * DAY_MS), endsAt: new Date(Date.now() - DAY_MS) },
    });

    const byName = await http().get('/v1/admin/restaurants?query=koshary').set(auth(token)).expect(200);
    expect(byName.body).toMatchObject({ total: 1, items: [{ subdomain: 'abou-tarek', ownerEmail: 'tarek@koshary.test' }] });
    const byEmail = await http().get('/v1/admin/restaurants?query=MONA@').set(auth(token)).expect(200);
    expect(byEmail.body.items.map((r: { subdomain: string }) => r.subdomain)).toEqual(['felfela']);
    // Digits in a non-phone query must not match phone numbers (both restaurants' phones contain a 1).
    const bySubdomain = await http().get('/v1/admin/restaurants?query=abou-tarek1').set(auth(token)).expect(200);
    expect(bySubdomain.body.total).toBe(0);
    const byPhone = await http().get('/v1/admin/restaurants?query=010 1234').set(auth(token)).expect(200);
    expect(byPhone.body.total).toBe(2);
    const inactive = await http().get('/v1/admin/restaurants?access=INACTIVE').set(auth(token)).expect(200);
    expect(inactive.body.items.map((r: { subdomain: string }) => r.subdomain)).toEqual(['felfela']);
    const page = await http().get('/v1/admin/restaurants?pageSize=1&page=2').set(auth(token)).expect(200);
    expect(page.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page.body.items).toHaveLength(1);

    const detail = await http().get(`/v1/admin/restaurants/${other.id}`).set(auth(token)).expect(200);
    expect(detail.body).toMatchObject({ name: 'Felfela', status: 'ACTIVE', ownerStatus: 'ACTIVE', menu: { categories: 0, items: 0 } });
    expect(detail.body.entitlements).toHaveLength(1);
  });

  it('suspends and restores a restaurant, and audits both', async () => {
    const { token } = await signInAdmin(t);
    const { id, token: owner } = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    await http().post(`/v1/admin/restaurants/${id}/suspend`).set(auth(token)).send({ reason: 'Chargeback dispute' }).expect(204);
    const again = await http().post(`/v1/admin/restaurants/${id}/suspend`).set(auth(token)).send({ reason: 'Again' }).expect(409);
    expect(again.body.error.code).toBe('ALREADY_SUSPENDED');
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('TEMPORARILY_UNAVAILABLE');
    await http().post('/v1/menu/categories').set(auth(owner)).send({ nameAr: 'رئيسي' }).expect(403);

    await http().post(`/v1/admin/restaurants/${id}/unsuspend`).set(auth(token)).expect(204);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('AVAILABLE');

    const audit = await http().get('/v1/admin/audit').set(auth(token)).expect(200);
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toEqual(['restaurant.unsuspend', 'restaurant.suspend']);
    expect(audit.body.items[1]).toMatchObject({ targetId: id, metadata: { reason: 'Chargeback dispute' }, actor: { email: 'admin@bilhanah.test' } });
    // Entries name the restaurant they concern, and say they came from the console.
    expect(audit.body.items[1]).toMatchObject({ scope: 'platform', restaurant: { id, name: 'Koshary Abou Tarek' } });

    // A restaurant's own staff change is a restaurant entry; the scope filter splits the two.
    await http().post('/v1/kitchen-accounts').set(auth(owner))
      .send({ fullName: 'Sami', email: 'sami@koshary.test', password: 'staff-password', role: 'WAITER' }).expect(201);
    const restaurants = (await http().get('/v1/admin/audit?scope=restaurant').set(auth(token)).expect(200)).body;
    expect(restaurants.items.map((entry: { action: string }) => entry.action)).toEqual(['staff.created']);
    expect(restaurants.items[0]).toMatchObject({ scope: 'restaurant', restaurant: { id, name: 'Koshary Abou Tarek' }, metadata: { targetName: 'Sami' } });
    const platform = (await http().get('/v1/admin/audit?scope=platform').set(auth(token)).expect(200)).body;
    expect(platform.items.map((entry: { action: string }) => entry.action)).toEqual(['restaurant.unsuspend', 'restaurant.suspend']);
    expect((await http().get('/v1/admin/audit').set(auth(token)).expect(200)).body.total).toBe(3);
  });

  it('grants a paid period by hand, after any current coverage', async () => {
    const { token } = await signInAdmin(t);
    const { id, token: owner } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const trialEnd = (await t.prisma.entitlement.findFirstOrThrow({ where: { restaurantId: id } })).endsAt;

    const granted = await http()
      .post(`/v1/admin/restaurants/${id}/entitlements`)
      .set(auth(token))
      .send({ planCode: 'MENU', months: 2, note: 'Paid in cash at the office' })
      .expect(201);
    expect(granted.body).toMatchObject({ kind: 'PAID', planCode: 'MENU', grantedBy: 'Platform Admin', note: 'Paid in cash at the office' });
    expect(granted.body.startsAt).toBe(trialEnd.toISOString());

    // Still in the trial today.
    expect((await http().get('/v1/restaurants/mine').set(auth(owner)).expect(200)).body.access.status).toBe('TRIAL');
    await http().post(`/v1/admin/restaurants/${id}/entitlements`).set(auth(token)).send({ planCode: 'MENU', months: 0, note: 'x' }).expect(400);
  });

  it('edits payment details, trial defaults and plan prices', async () => {
    const { token } = await signInAdmin(t);

    const payment = await http()
      .put('/v1/admin/settings/payment')
      .set(auth(token))
      .send({ instapayAddress: 'bilhanah@instapay', vodafoneCashNumber: '01012345678', notesAr: '' })
      .expect(200);
    expect(payment.body.payment).toMatchObject({ instapayAddress: 'bilhanah@instapay', vodafoneCashNumber: '01012345678', notesAr: null });

    await http().put('/v1/admin/settings/trial').set(auth(token)).send({ durationDays: 14, planCode: 'ORDERS' }).expect(200);
    const { token: owner } = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    expect((await http().get('/v1/restaurants/mine').set(auth(owner)).expect(200)).body.access.planCode).toBe('ORDERS');

    const prices = await http().put('/v1/admin/plans/MENU').set(auth(token)).send({ priceMonthlyPiastres: 25000 }).expect(200);
    expect(prices.body.plans[0]).toEqual({ code: 'MENU', priceMonthlyPiastres: 25000 });
    expect((await http().get('/v1/public/plans').expect(200)).body[0].priceMonthlyPiastres).toBe(25000);
    await http().put('/v1/admin/plans/GOLD').set(auth(token)).send({ priceMonthlyPiastres: 1 }).expect(400);

    const audit = await http().get('/v1/admin/audit').set(auth(token)).expect(200);
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toEqual(['plan.price', 'settings.trial', 'settings.payment']);
    expect(audit.body.items[0].metadata).toEqual({ from: 20000, to: 25000 });
  });
});
