import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type ServiceView = { key: string; enabled: boolean; inPlan: boolean; missing: string[]; dependents: string[]; changedAt: string | null };
const service = (setup: { services: ServiceView[] }, key: string) => setup.services.find((entry) => entry.key === key)!;

async function restaurant(email: string, subdomain: string) {
  const token = await signUpOwner(t, email);
  const created = await http().post('/v1/restaurants').set(auth(token))
    .send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  return { token, id: created.body.id as string, created: created.body };
}

async function staff(owner: string, email: string, role: 'MANAGER' | 'CASHIER', permissions: string[] = []) {
  await http().post('/v1/kitchen-accounts').set(auth(owner)).send({ fullName: `${role} One`, email, password: 'staff-password', role, permissions }).expect(201);
  return (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200)).body.accessToken as string;
}

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => { await t.reset(); });

describe('flexible onboarding', () => {
  it('lets a restaurant keep its own QR menu: setup saved without the digital menu, and nothing else depends on it', async () => {
    const { token, created } = await restaurant('owner@koshary.test', 'koshary');
    // A new restaurant has not chosen yet; everything is on until it does.
    expect(created.setup).toMatchObject({ menuSource: 'BILHANAH', completedAt: null });
    expect(Object.values(created.setup.services).every(Boolean)).toBe(true);

    const saved = (await http().put('/v1/restaurants/mine/setup').set(auth(token))
      .send({ menuSource: 'EXTERNAL', externalMenuUrl: 'https://menu.example.com/koshary', externalPosName: 'Foodics', services: ['INVENTORY', 'CASH_DRAWER', 'ATTENDANCE'] }).expect(200)).body;
    expect(saved).toMatchObject({ menuSource: 'EXTERNAL', externalMenuUrl: 'https://menu.example.com/koshary', externalPosName: 'Foodics' });
    expect(saved.completedAt).not.toBeNull();
    expect(saved.services.filter((entry: ServiceView) => entry.enabled).map((entry: ServiceView) => entry.key)).toEqual(['INVENTORY', 'CASH_DRAWER', 'ATTENDANCE']);

    const mine = (await http().get('/v1/restaurants/mine').set(auth(token)).expect(200)).body;
    expect(mine.setup.services).toMatchObject({ DIGITAL_MENU: false, QR_ORDERING: false, REVIEWS: false, INVENTORY: true });
    // The plan still includes them; the restaurant simply has them off.
    expect(mine.access.planFeatures).toMatchObject({ menu: true, ordering: true, reviews: true });
    expect(mine.access.features).toMatchObject({ menu: false, ordering: false, reviews: false, inventory: true, readyAlerts: false });

    // Its Bilhanah menu is not shown to diners, and the services it kept work.
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('TEMPORARILY_UNAVAILABLE');
    await http().get('/v1/inventory/settings').set(auth(token)).expect(200);
    await http().get('/v1/cash/me').set(auth(token)).expect(200);
    await http().get('/v1/reviews/settings').set(auth(token)).expect(409);

    // Reports name their source: Bilhanah orders only, with the restaurant's own menu and POS.
    const stats = (await http().get('/v1/restaurants/mine/stats?days=7').set(auth(token)).expect(200)).body;
    expect(stats.dataSource).toEqual({ orders: 'BILHANAH', menuSource: 'EXTERNAL', externalPosName: 'Foodics' });
    expect(stats.ordering).toBe(false);
  });

  it('refuses a setup whose services miss what they need, and a URL that is not a web address', async () => {
    const { token } = await restaurant('owner@koshary.test', 'koshary');
    const refused = await http().put('/v1/restaurants/mine/setup').set(auth(token)).send({ menuSource: 'NONE', services: ['QR_ORDERING'] }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'SERVICE_REQUIREMENTS', details: { service: 'QR_ORDERING', missing: ['DIGITAL_MENU'] } });
    await http().put('/v1/restaurants/mine/setup').set(auth(token)).send({ menuSource: 'EXTERNAL', externalMenuUrl: 'javascript:alert(1)' }).expect(400);
    await http().put('/v1/restaurants/mine/setup').set(auth(token)).send({ menuSource: 'SOMETHING' }).expect(400);
    // Nothing was saved.
    expect((await http().get('/v1/restaurants/mine/setup').set(auth(token)).expect(200)).body.completedAt).toBeNull();
  });

  it('skips choosing: the setup is done and every service stays on', async () => {
    const { token } = await restaurant('owner@koshary.test', 'koshary');
    const saved = (await http().put('/v1/restaurants/mine/setup').set(auth(token)).send({ menuSource: 'BILHANAH' }).expect(200)).body;
    expect(saved.completedAt).not.toBeNull();
    expect(saved.services.every((entry: ServiceView) => entry.enabled && entry.changedAt === null)).toBe(true);
  });
});

describe('restaurant services', () => {
  it('switches services after onboarding, keeps their data, and enforces requirements both ways', async () => {
    const { token } = await restaurant('owner@koshary.test', 'koshary');
    const category = (await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'مشويات' }).expect(201)).body;

    // The digital menu cannot go while ordering and reviews need it.
    const blocked = await http().put('/v1/restaurants/mine/services/DIGITAL_MENU').set(auth(token)).send({ enabled: false }).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'SERVICE_DEPENDENTS', details: { dependents: ['QR_ORDERING', 'REVIEWS'] } });

    await http().put('/v1/restaurants/mine/services/QR_ORDERING').set(auth(token)).send({ enabled: false }).expect(200);
    await http().put('/v1/restaurants/mine/services/REVIEWS').set(auth(token)).send({ enabled: false }).expect(200);
    const off = (await http().put('/v1/restaurants/mine/services/DIGITAL_MENU').set(auth(token)).send({ enabled: false }).expect(200)).body;
    expect(service(off, 'DIGITAL_MENU')).toMatchObject({ enabled: false, dependents: [] });
    expect(service(off, 'QR_ORDERING')).toMatchObject({ enabled: false, missing: ['DIGITAL_MENU'] });

    // Ordering cannot come back before the menu it needs.
    const needs = await http().put('/v1/restaurants/mine/services/QR_ORDERING').set(auth(token)).send({ enabled: true }).expect(409);
    expect(needs.body.error).toMatchObject({ code: 'SERVICE_REQUIREMENTS', details: { missing: ['DIGITAL_MENU'] } });

    // Switched back on, the menu is exactly as it was.
    await http().put('/v1/restaurants/mine/services/DIGITAL_MENU').set(auth(token)).send({ enabled: true }).expect(200);
    const on = (await http().put('/v1/restaurants/mine/services/QR_ORDERING').set(auth(token)).send({ enabled: true }).expect(200)).body;
    expect(service(on, 'QR_ORDERING')).toMatchObject({ enabled: true, missing: [] });
    const categories = (await http().get('/v1/menu').set(auth(token)).expect(200)).body;
    expect(JSON.stringify(categories)).toContain(category.id);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.availability).toBe('AVAILABLE');

    // Every switch is recorded; the same switch twice changes nothing.
    await http().put('/v1/restaurants/mine/services/QR_ORDERING').set(auth(token)).send({ enabled: true }).expect(200);
    const audit = await t.prisma.auditLog.findMany({ where: { targetType: 'restaurant-service' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((row) => `${row.action}:${row.targetId}`)).toEqual([
      'service.disabled:QR_ORDERING', 'service.disabled:REVIEWS', 'service.disabled:DIGITAL_MENU', 'service.enabled:DIGITAL_MENU', 'service.enabled:QR_ORDERING',
    ]);
    await http().put('/v1/restaurants/mine/services/NOPE').set(auth(token)).send({ enabled: true }).expect(400);
  });

  it('cannot switch on a service the plan does not include, and switched-off services refuse their routes', async () => {
    const { token, id } = await restaurant('owner@koshary.test', 'koshary');
    await http().put('/v1/restaurants/mine/services/INVENTORY').set(auth(token)).send({ enabled: false }).expect(200);
    await http().get('/v1/inventory/settings').set(auth(token)).expect(409);

    await t.prisma.entitlement.updateMany({ where: { restaurantId: id }, data: { planCode: 'MENU' } });
    const setup = (await http().get('/v1/restaurants/mine/setup').set(auth(token)).expect(200)).body;
    expect(service(setup, 'INVENTORY')).toMatchObject({ enabled: false, inPlan: false });
    expect(service(setup, 'CASH_DRAWER').inPlan).toBe(true);
    const refused = await http().put('/v1/restaurants/mine/services/INVENTORY').set(auth(token)).send({ enabled: true }).expect(409);
    expect(refused.body.error.code).toBe('SERVICE_NOT_IN_PLAN');

    // Services every plan includes switch freely; their routes follow at once.
    await http().put('/v1/restaurants/mine/services/ATTENDANCE').set(auth(token)).send({ enabled: false }).expect(200);
    expect((await http().get('/v1/attendance/policies').set(auth(token)).expect(409)).body.error).toMatchObject({ code: 'SERVICE_INACTIVE', details: { service: 'ATTENDANCE' } });
    await http().put('/v1/restaurants/mine/services/CASH_DRAWER').set(auth(token)).send({ enabled: false }).expect(200);
    await http().get('/v1/cash/me').set(auth(token)).expect(409);
  });

  it('is the owner’s alone, per restaurant: staff see the services but cannot switch them, and other restaurants are untouched', async () => {
    const a = await restaurant('owner-a@koshary.test', 'koshary');
    const b = await restaurant('owner-b@felfela.test', 'felfela');
    const manager = await staff(a.token, 'manager@koshary.test', 'MANAGER');

    await http().put('/v1/restaurants/mine/services/CASH_DRAWER').set(auth(a.token)).send({ enabled: false }).expect(200);
    await http().put('/v1/restaurants/mine/services/CASH_DRAWER').set(auth(manager)).send({ enabled: true }).expect(403);
    await http().put('/v1/restaurants/mine/setup').set(auth(manager)).send({ menuSource: 'NONE' }).expect(403);

    const context = (await http().get('/v1/kitchen/context').set(auth(manager)).expect(200)).body;
    expect(context.services).toMatchObject({ CASH_DRAWER: false, DIGITAL_MENU: true });
    await http().get('/v1/cash/me').set(auth(manager)).expect(409);

    expect((await http().get('/v1/restaurants/mine').set(auth(b.token)).expect(200)).body.setup.services.CASH_DRAWER).toBe(true);
    await http().get('/v1/cash/me').set(auth(b.token)).expect(200);
  });
});
