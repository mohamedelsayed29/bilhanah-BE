import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const details = {
  name: 'Abou Tarek',
  contactName: 'Tarek Youssef',
  phone: '010 1234 5678',
  city: 'Cairo',
  address: '16 Maarouf St, Downtown',
};

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function createRestaurant(token: string, body: Record<string, unknown>) {
  return http().post('/v1/restaurants').set(auth(token)).send({ ...details, ...body });
}

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('onboarding', () => {
  it('creates the restaurant, starts a 30-day Advanced trial and publishes its address', async () => {
    const token = await signUpOwner(t, 'owner@aboutarek.test');

    await http().get('/v1/restaurants/mine').set(auth(token)).expect(404);
    const before = await http().get('/v1/restaurants/subdomain-availability?name=Abou-Tarek').set(auth(token)).expect(200);
    expect(before.body).toEqual({ subdomain: 'abou-tarek', available: true });

    const startedAt = Date.now();
    const created = await createRestaurant(token, { subdomain: ' Abou-Tarek ' }).expect(201);
    expect(created.body).toMatchObject({
      name: 'Abou Tarek',
      subdomain: 'abou-tarek',
      publicUrl: 'https://abou-tarek.bilhanah.test',
      phone: '01012345678',
      defaultLanguage: 'ar',
      timezone: 'Africa/Cairo',
      websiteUrl: null,
      access: {
        status: 'TRIAL',
        planCode: 'ADVANCED',
        features: { menu: true, ordering: true, readyAlerts: true },
      },
    });
    const trialMs = Date.parse(created.body.access.trialEndsAt) - startedAt;
    expect(Math.abs(trialMs - 30 * DAY_MS)).toBeLessThan(60_000);
    expect(created.body.access.currentPeriodEndsAt).toBe(created.body.access.trialEndsAt);

    const after = await http().get('/v1/restaurants/subdomain-availability?name=abou-tarek').set(auth(token)).expect(200);
    expect(after.body).toEqual({ subdomain: 'abou-tarek', available: false, reason: 'TAKEN' });

    const mine = await http().get('/v1/restaurants/mine').set(auth(token)).expect(200);
    expect(mine.body.id).toBe(created.body.id);

    const publicView = await http().get('/v1/public/restaurants/abou-tarek').expect(200);
    expect(publicView.body).toMatchObject({ availability: 'AVAILABLE', name: 'Abou Tarek', phone: '01012345678' });
    expect(publicView.headers['cache-control']).toBe('no-store');
  });

  it('allows only one restaurant per account', async () => {
    const token = await signUpOwner(t, 'owner@aboutarek.test');
    await createRestaurant(token, { subdomain: 'abou-tarek' }).expect(201);
    const second = await createRestaurant(token, { subdomain: 'abou-tarek-2' }).expect(409);
    expect(second.body.error.code).toBe('RESTAURANT_ALREADY_EXISTS');
  });

  it.each([
    ['admin', 'RESERVED'],
    ['www', 'RESERVED'],
    ['ab', 'INVALID'],
    ['abou--tarek', 'INVALID'],
    ['-abou', 'INVALID'],
    ['كشري', 'INVALID'],
  ])('rejects the subdomain %s (%s)', async (subdomain, reason) => {
    const token = await signUpOwner(t, 'owner@aboutarek.test');

    const check = await http()
      .get('/v1/restaurants/subdomain-availability')
      .query({ name: subdomain })
      .set(auth(token))
      .expect(200);
    expect(check.body).toMatchObject({ available: false, reason });

    const created = await createRestaurant(token, { subdomain }).expect(400);
    expect(created.body.error.code).toBe('VALIDATION_FAILED');
    expect(created.body.error.details).toContainEqual(expect.objectContaining({ path: 'subdomain', reason }));
  });

  it('gives a contested subdomain to exactly one of two simultaneous owners', async () => {
    const first = await signUpOwner(t, 'first@koshary.test');
    const second = await signUpOwner(t, 'second@koshary.test');

    const results = await Promise.all([
      createRestaurant(first, { subdomain: 'koshary' }),
      createRestaurant(second, { subdomain: 'koshary' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.code).toBe('SUBDOMAIN_TAKEN');
    expect(await t.prisma.restaurant.count({ where: { subdomain: 'koshary' } })).toBe(1);
  });

  it('creates one restaurant when the same owner submits twice at once', async () => {
    const token = await signUpOwner(t, 'owner@koshary.test');
    const results = await Promise.all([
      createRestaurant(token, { subdomain: 'koshary-one' }),
      createRestaurant(token, { subdomain: 'koshary-two' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.code).toBe('RESTAURANT_ALREADY_EXISTS');
    expect(await t.prisma.entitlement.count()).toBe(1);
  });

  it('requires an authenticated owner', async () => {
    await http().post('/v1/restaurants').send({ ...details, subdomain: 'koshary' }).expect(401);
    await http().get('/v1/restaurants/mine').expect(401);
  });
});

describe('trial settings', () => {
  it('uses the current global duration for new trials only', async () => {
    const early = await signUpOwner(t, 'early@koshary.test');
    const earlyRestaurant = await createRestaurant(early, { subdomain: 'early' }).expect(201);

    await t.prisma.trialSettings.update({ where: { id: 1 }, data: { durationDays: 7, planCode: 'MENU' } });

    const late = await signUpOwner(t, 'late@koshary.test');
    const lateRestaurant = await createRestaurant(late, { subdomain: 'late' }).expect(201);
    expect(lateRestaurant.body.access).toMatchObject({ status: 'TRIAL', planCode: 'MENU' });
    const lateMs = Date.parse(lateRestaurant.body.access.trialEndsAt) - Date.now();
    expect(Math.abs(lateMs - 7 * DAY_MS)).toBeLessThan(60_000);

    const earlyNow = await http().get('/v1/restaurants/mine').set(auth(early)).expect(200);
    expect(earlyNow.body.access).toEqual(earlyRestaurant.body.access);
  });

  it('creates the restaurant without access when trials are disabled', async () => {
    await t.prisma.trialSettings.update({ where: { id: 1 }, data: { enabled: false } });
    const token = await signUpOwner(t, 'owner@koshary.test');
    const created = await createRestaurant(token, { subdomain: 'koshary' }).expect(201);
    expect(created.body.access).toMatchObject({ status: 'INACTIVE', planCode: null, trialEndsAt: null });

    const publicView = await http().get('/v1/public/restaurants/koshary').expect(200);
    expect(publicView.body.availability).toBe('TEMPORARILY_UNAVAILABLE');
  });

  it('the database refuses a second trial for one restaurant', async () => {
    const token = await signUpOwner(t, 'owner@koshary.test');
    const { body } = await createRestaurant(token, { subdomain: 'koshary' }).expect(201);
    await expect(
      t.prisma.entitlement.create({
        data: { restaurantId: body.id, kind: 'TRIAL', planCode: 'ADVANCED', startsAt: new Date(), endsAt: new Date(Date.now() + DAY_MS) },
      }),
    ).rejects.toThrow();
  });
});

describe('settings and tenant isolation', () => {
  it('each owner only reads and changes their own restaurant', async () => {
    const ownerA = await signUpOwner(t, 'a@koshary.test');
    const ownerB = await signUpOwner(t, 'b@koshary.test');
    const a = await createRestaurant(ownerA, { subdomain: 'restaurant-a', name: 'Restaurant A' }).expect(201);
    const b = await createRestaurant(ownerB, { subdomain: 'restaurant-b', name: 'Restaurant B' }).expect(201);

    const mineB = await http().get('/v1/restaurants/mine').set(auth(ownerB)).expect(200);
    expect(mineB.body.id).toBe(b.body.id);

    await http().patch('/v1/restaurants/mine').set(auth(ownerB)).send({ name: 'Renamed B' }).expect(200);
    const mineA = await http().get('/v1/restaurants/mine').set(auth(ownerA)).expect(200);
    expect(mineA.body).toMatchObject({ id: a.body.id, name: 'Restaurant A' });
  });

  it('updates details, clears links and keeps the subdomain permanent', async () => {
    const token = await signUpOwner(t, 'owner@koshary.test');
    await createRestaurant(token, { subdomain: 'koshary', instagramUrl: 'https://instagram.com/koshary' }).expect(201);

    const updated = await http()
      .patch('/v1/restaurants/mine')
      .set(auth(token))
      .send({ city: 'Giza', instagramUrl: null, defaultLanguage: 'en' })
      .expect(200);
    expect(updated.body).toMatchObject({ city: 'Giza', instagramUrl: null, defaultLanguage: 'en', name: 'Abou Tarek' });

    const rename = await http().patch('/v1/restaurants/mine').set(auth(token)).send({ subdomain: 'new-name' }).expect(400);
    expect(rename.body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.prisma.restaurant.findFirstOrThrow()).subdomain).toBe('koshary');
  });
});

describe('public access and expiry', () => {
  it('returns 404 for unknown or malformed addresses', async () => {
    const unknown = await http().get('/v1/public/restaurants/nobody-here').expect(404);
    expect(unknown.body.error.code).toBe('RESTAURANT_NOT_FOUND');
    await http().get('/v1/public/restaurants/no--pe').expect(404);
  });

  it('shows the same neutral page for expired and suspended restaurants', async () => {
    const expiredOwner = await signUpOwner(t, 'expired@koshary.test');
    const suspendedOwner = await signUpOwner(t, 'suspended@koshary.test');
    const expired = await createRestaurant(expiredOwner, { subdomain: 'expired' }).expect(201);
    await createRestaurant(suspendedOwner, { subdomain: 'suspended' }).expect(201);

    await t.prisma.entitlement.updateMany({
      where: { restaurantId: expired.body.id },
      data: { startsAt: new Date(Date.now() - 31 * DAY_MS), endsAt: new Date(Date.now() - DAY_MS) },
    });
    await t.prisma.restaurant.update({ where: { subdomain: 'suspended' }, data: { status: 'SUSPENDED' } });

    const expiredView = await http().get('/v1/public/restaurants/expired').expect(200);
    const suspendedView = await http().get('/v1/public/restaurants/suspended').expect(200);
    for (const view of [expiredView.body, suspendedView.body]) {
      expect(Object.keys(view).sort()).toEqual(['availability', 'defaultLanguage', 'name', 'subdomain']);
      expect(view.availability).toBe('TEMPORARILY_UNAVAILABLE');
    }

    // The owner keeps access to their records and sees why.
    const expiredMine = await http().get('/v1/restaurants/mine').set(auth(expiredOwner)).expect(200);
    expect(expiredMine.body.access).toMatchObject({ status: 'INACTIVE', planCode: null });
    expect(expiredMine.body.access.trialEndsAt).toEqual(expect.any(String));

    const suspendedMine = await http().get('/v1/restaurants/mine').set(auth(suspendedOwner)).expect(200);
    expect(suspendedMine.body.access.status).toBe('SUSPENDED');
    const blocked = await http().patch('/v1/restaurants/mine').set(auth(suspendedOwner)).send({ city: 'Giza' }).expect(403);
    expect(blocked.body.error.code).toBe('RESTAURANT_SUSPENDED');
  });
});
