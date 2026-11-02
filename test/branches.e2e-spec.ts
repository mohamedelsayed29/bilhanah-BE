import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let baseUrl: string;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const DOWNTOWN = { name: 'Downtown', slug: 'downtown', phone: '0225550000', city: 'Cairo', address: '16 Maarouf St' };
const NASR = { name: 'Nasr City', slug: 'nasr-city', phone: '0222220000', city: 'Cairo', address: '5 Abbas El Akkad St' };

type Dish = { id: string; variant: string; large: string };

/** An owner with ordering on, a two-size dish, and a second branch (Nasr City) taking orders too. */
async function chain(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  const created = await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: DOWNTOWN.city, address: DOWNTOWN.address, subdomain })
    .expect(201);
  const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
  const item = await http()
    .post('/v1/menu/items')
    .set(auth(token))
    .send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ nameAr: 'صغير', pricePiastres: 3500 }, { nameAr: 'كبير', pricePiastres: 5000 }] })
    .expect(201);
  await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const nasr = await http().post('/v1/branches').set(auth(token)).send(NASR).expect(201);
  await http().patch(`/v1/branches/${nasr.body.id}`).set(auth(token)).send({ orderingEnabled: true }).expect(200);
  const dish: Dish = { id: item.body.id, variant: item.body.variants[0].id, large: item.body.variants[1].id };
  return { token, restaurantId: created.body.id as string, mainId: created.body.mainBranchId as string, nasrId: nasr.body.id as string, dish };
}

const placeOrder = (dish: Dish, extra: Record<string, unknown> = {}, subdomain = 'koshary') =>
  http()
    .post(`/v1/public/restaurants/${subdomain}/orders`)
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items: [{ menuItemId: dish.id, variantId: dish.variant, quantity: 1 }], ...extra });

/** A staff account of the chain's owner, signed in; returns its token and id. */
async function staff(ownerToken: string, role: 'KITCHEN' | 'MANAGER', branchId: string | null, email = `${role.toLowerCase()}@koshary.test`) {
  const account = await http()
    .post('/v1/kitchen-accounts')
    .set(auth(ownerToken))
    .send({ fullName: `${role} account`, email, password: 'staff-password', role, branchId })
    .expect(201);
  const session = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200);
  expect(session.body.user.role).toBe(role);
  return { id: account.body.id as string, token: session.body.accessToken as string };
}

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

describe('branches', () => {
  it('every restaurant starts with an active main branch carrying its address', async () => {
    const token = await signUpOwner(t, 'solo@koshary.test');
    const created = await http()
      .post('/v1/restaurants')
      .set(auth(token))
      .send({ name: 'Solo', contactName: 'Tarek', phone: '01012345678', city: 'Giza', address: '1 Pyramids Rd', subdomain: 'solo' })
      .expect(201);
    expect(created.body).toMatchObject({ branchCount: 1, mainBranchId: expect.any(String) });

    const list = await http().get('/v1/branches').set(auth(token)).expect(200);
    expect(list.body).toMatchObject({ limit: 10, used: 1 });
    expect(list.body.branches).toEqual([
      expect.objectContaining({ id: created.body.mainBranchId, slug: 'main', isMain: true, isActive: true, city: 'Giza', address: '1 Pyramids Rd', publicUrl: 'https://solo.bilhanah.test' }),
    ]);

    // With one branch, the restaurant's contact details stay in step with it.
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ address: '2 Pyramids Rd' }).expect(200);
    expect((await http().get('/v1/public/restaurants/solo').expect(200)).body).toMatchObject({ address: '2 Pyramids Rd', branches: [expect.objectContaining({ slug: 'main' })] });
  });

  it('creates branches within the plan allowance, with unique addresses', async () => {
    const { token, nasrId } = await chain();
    const list = await http().get('/v1/branches').set(auth(token)).expect(200);
    expect(list.body.used).toBe(2);
    expect(list.body.branches.map((branch: { slug: string }) => branch.slug)).toEqual(['main', 'nasr-city']);
    expect(list.body.branches[1]).toMatchObject({ id: nasrId, isMain: false, publicUrl: 'https://koshary.bilhanah.test/?b=nasr-city' });

    const duplicate = await http().post('/v1/branches').set(auth(token)).send({ ...NASR, name: 'Another' }).expect(409);
    expect(duplicate.body.error.code).toBe('BRANCH_SLUG_TAKEN');
    const badSlug = await http().post('/v1/branches').set(auth(token)).send({ ...NASR, slug: 'Nasr City!' }).expect(400);
    expect(badSlug.body.error.details[0].path).toBe('slug');
  });

  it('a Menu plan includes one branch', async () => {
    await t.prisma.trialSettings.update({ where: { id: 1 }, data: { planCode: 'MENU' } });
    const token = await signUpOwner(t, 'small@koshary.test');
    await http()
      .post('/v1/restaurants')
      .set(auth(token))
      .send({ name: 'Small', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '1 Street', subdomain: 'small' })
      .expect(201);
    const refused = await http().post('/v1/branches').set(auth(token)).send(NASR).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'BRANCH_LIMIT_REACHED', details: { limit: 1 } });
  });

  it('copies tables into a new branch with new QR codes', async () => {
    const { token, mainId } = await chain();
    await http().post('/v1/tables/range').set(auth(token)).send({ from: 1, to: 3, prefix: 'T' }).expect(201);
    const copy = await http().post('/v1/branches').set(auth(token)).send({ ...NASR, slug: 'maadi', name: 'Maadi', copyTablesFrom: mainId }).expect(201);
    expect(copy.body.tableCount).toBe(3);
    const [main, maadi] = await Promise.all([
      http().get(`/v1/tables?branchId=${mainId}`).set(auth(token)).expect(200),
      http().get(`/v1/tables?branchId=${copy.body.id}`).set(auth(token)).expect(200),
    ]);
    expect(maadi.body.map((table: { label: string }) => table.label)).toEqual(['T 1', 'T 2', 'T 3']);
    const mainCodes = new Set(main.body.map((table: { publicCode: string }) => table.publicCode));
    expect(maadi.body.some((table: { publicCode: string }) => mainCodes.has(table.publicCode))).toBe(false);
  });
});

describe('diners and branches', () => {
  it('each branch shows its own address, hours and ordering, and unknown or archived branches are not found', async () => {
    const { token, nasrId } = await chain();
    const hours = { sat: [{ opens: '09:00', closes: '17:00' }], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] };
    await http().patch(`/v1/branches/${nasrId}`).set(auth(token)).send({ openingHours: hours, ordersPaused: true }).expect(200);

    const main = await http().get('/v1/public/restaurants/koshary').expect(200);
    expect(main.body).toMatchObject({ address: '16 Maarouf St', branch: { slug: 'main' }, ordering: { accepting: true } });
    expect(main.body.branches.map((branch: { slug: string }) => branch.slug)).toEqual(['main', 'nasr-city']);

    const nasr = await http().get('/v1/public/restaurants/koshary/menu?branch=nasr-city').expect(200);
    expect(nasr.body.restaurant).toMatchObject({
      address: '5 Abbas El Akkad St',
      phone: '0222220000',
      openingHours: hours,
      ordering: { accepting: false },
      branch: { slug: 'nasr-city', name: 'Nasr City', acceptingOrders: false },
    });

    expect((await http().get('/v1/public/restaurants/koshary?branch=nowhere').expect(404)).body.error.code).toBe('BRANCH_NOT_FOUND');
    await http().patch(`/v1/branches/${nasrId}`).set(auth(token)).send({ isActive: false }).expect(200);
    await http().get('/v1/public/restaurants/koshary?branch=nasr-city').expect(404);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.branches).toHaveLength(1);
  });

  it('branch prices, hidden dishes and sold-out marks reach the menu and the bill, without touching other branches', async () => {
    const { token, nasrId, dish } = await chain();
    await http()
      .put(`/v1/branches/${nasrId}/menu/items/${dish.id}`)
      .set(auth(token))
      .send({ prices: [{ variantId: dish.variant, pricePiastres: 4000 }] })
      .expect(200);

    const menuAt = async (branch?: string) =>
      (await http().get(`/v1/public/restaurants/koshary/menu${branch ? `?branch=${branch}` : ''}`).expect(200)).body.categories[0]?.items[0];
    expect((await menuAt('nasr-city')).variants.map((variant: { pricePiastres: number }) => variant.pricePiastres)).toEqual([4000, 5000]);
    expect((await menuAt()).variants[0].pricePiastres).toBe(3500);

    const nasrOrder = await placeOrder(dish, { branch: 'nasr-city' }).expect(201);
    expect(nasrOrder.body.order).toMatchObject({ subtotalPiastres: 4000, branch: { slug: 'nasr-city', name: 'Nasr City', phone: '0222220000' }, restaurant: { phone: '0222220000' } });
    expect((await placeOrder(dish).expect(201)).body.order.subtotalPiastres).toBe(3500);

    // Sold out at Nasr City only.
    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(token)).send({ available: false }).expect(200);
    expect((await menuAt('nasr-city')).isAvailable).toBe(false);
    const soldOut = await placeOrder(dish, { branch: 'nasr-city' }).expect(409);
    expect(soldOut.body.error).toMatchObject({ code: 'ITEMS_UNAVAILABLE', details: { menuItemIds: [dish.id] } });
    await placeOrder(dish).expect(201);

    // Hidden at Nasr City: gone from its menu (and its only category with it).
    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(token)).send({ available: null, hidden: true }).expect(200);
    expect((await http().get('/v1/public/restaurants/koshary/menu?branch=nasr-city').expect(200)).body.categories).toEqual([]);

    const branchMenu = await http().get(`/v1/branches/${nasrId}/menu`).set(auth(token)).expect(200);
    expect(branchMenu.body.categories[0].items[0]).toMatchObject({
      override: { available: null, hidden: true, prices: { [dish.variant]: 4000 } },
      effective: { visible: false, available: true },
    });
    const reset = await http().post(`/v1/branches/${nasrId}/menu/reset`).set(auth(token)).expect(200);
    expect(reset.body.removed).toBe(2);
    expect((await menuAt('nasr-city')).variants[0].pricePiastres).toBe(3500);
  });

  it('a branch price survives editing the dish’s sizes', async () => {
    const { token, nasrId, dish } = await chain();
    await http()
      .put(`/v1/branches/${nasrId}/menu/items/${dish.id}`)
      .set(auth(token))
      .send({ prices: [{ variantId: dish.large, pricePiastres: 6000 }] })
      .expect(200);
    await http()
      .patch(`/v1/menu/items/${dish.id}`)
      .set(auth(token))
      .send({ variants: [{ nameAr: 'صغير', pricePiastres: 3600 }, { nameAr: 'كبير جدًا', pricePiastres: 5200 }] })
      .expect(200);
    const item = (await http().get('/v1/public/restaurants/koshary/menu?branch=nasr-city').expect(200)).body.categories[0].items[0];
    expect(item.variants.map((variant: { pricePiastres: number }) => variant.pricePiastres)).toEqual([3600, 6000]);

    const foreign = await http()
      .put(`/v1/branches/${nasrId}/menu/items/${dish.id}`)
      .set(auth(token))
      .send({ prices: [{ variantId: randomUUID(), pricePiastres: 1 }] })
      .expect(400);
    expect(foreign.body.error.code).toBe('VARIANT_MISMATCH');
  });

  it('numbers orders per branch, applies each branch’s switches, and lets the table QR decide the branch', async () => {
    const { token, nasrId, dish } = await chain();
    expect((await placeOrder(dish).expect(201)).body.order.number).toBe(1);
    expect((await placeOrder(dish, { branch: 'nasr-city' }).expect(201)).body.order.number).toBe(1);
    expect((await placeOrder(dish, { branch: 'nasr-city' }).expect(201)).body.order.number).toBe(2);

    const table = await http().post('/v1/tables').set(auth(token)).send({ branchId: nasrId, label: 'Table 7' }).expect(201);
    expect(table.body.branchId).toBe(nasrId);
    expect((await http().get(`/v1/public/restaurants/koshary/tables/${table.body.publicCode}`).expect(200)).body).toEqual({ label: 'Table 7', branch: 'nasr-city' });
    const dineIn = await placeOrder(dish, { type: 'DINE_IN', tableCode: table.body.publicCode, customerPhone: undefined }).expect(201);
    expect(dineIn.body.order).toMatchObject({ number: 3, tableLabel: 'Table 7', branch: { slug: 'nasr-city' } });

    await http().patch(`/v1/branches/${nasrId}`).set(auth(token)).send({ acceptsPickup: false }).expect(200);
    expect((await placeOrder(dish, { branch: 'nasr-city' }).expect(400)).body.error.code).toBe('ORDER_TYPE_UNAVAILABLE');
    await http().patch(`/v1/branches/${nasrId}`).set(auth(token)).send({ orderingEnabled: false }).expect(200);
    expect((await placeOrder(dish, { branch: 'nasr-city' }).expect(409)).body.error.code).toBe('ORDERING_UNAVAILABLE');
    await placeOrder(dish).expect(201);

    const board = await http().get('/v1/orders').set(auth(token)).expect(200);
    expect(board.body.total).toBe(5);
    const nasrBoard = await http().get(`/v1/orders?branchId=${nasrId}`).set(auth(token)).expect(200);
    expect(nasrBoard.body.items.map((order: { branchName: string }) => order.branchName)).toEqual(['Nasr City', 'Nasr City', 'Nasr City']);
    const floor = await http().get(`/v1/orders/floor?branchId=${nasrId}`).set(auth(token)).expect(200);
    expect(floor.body).toEqual([expect.objectContaining({ label: 'Table 7', occupied: true })]);
    expect((await http().get('/v1/orders/floor').set(auth(token)).expect(200)).body).toEqual([]);
  });
});

describe('branch staff', () => {
  it('a branch manager runs only their branch', async () => {
    const { token, mainId, nasrId, dish } = await chain();
    const mainOrder = await placeOrder(dish).expect(201);
    const nasrOrder = await placeOrder(dish, { branch: 'nasr-city' }).expect(201);
    const manager = await staff(token, 'MANAGER', nasrId);

    const board = await http().get('/v1/orders').set(auth(manager.token)).expect(200);
    expect(board.body.items.map((order: { branchId: string }) => order.branchId)).toEqual([nasrId]);
    const mainOrderId = (await http().get('/v1/orders').set(auth(token)).expect(200)).body.items.find((order: { branchId: string }) => order.branchId === mainId).id;
    await http().get(`/v1/orders/${mainOrderId}`).set(auth(manager.token)).expect(404);
    expect((await http().get(`/v1/orders?branchId=${mainId}`).set(auth(manager.token)).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    expect(mainOrder.body.order.number).toBe(nasrOrder.body.order.number);

    // Their branch's switches, hours and menu overrides, yes; renaming, archiving or other branches, no.
    await http().patch(`/v1/branches/${nasrId}`).set(auth(manager.token)).send({ ordersPaused: true, phone: '0222221111' }).expect(200);
    const rename = await http().patch(`/v1/branches/${nasrId}`).set(auth(manager.token)).send({ name: 'Mine now' }).expect(403);
    expect(rename.body.error.details.fields).toEqual(['name']);
    expect((await http().patch(`/v1/branches/${mainId}`).set(auth(manager.token)).send({ ordersPaused: true }).expect(403)).body.error.code).toBe('BRANCH_FORBIDDEN');
    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(manager.token)).send({ prices: [{ variantId: dish.variant, pricePiastres: 3900 }] }).expect(200);
    await http().post('/v1/branches').set(auth(manager.token)).send({ ...NASR, slug: 'other' }).expect(403);
    await http().get('/v1/kitchen-accounts').set(auth(manager.token)).expect(403);
    await http().patch('/v1/restaurants/mine').set(auth(manager.token)).send({ name: 'Hijacked' }).expect(403);

    const branches = await http().get('/v1/branches').set(auth(manager.token)).expect(200);
    expect(branches.body.branches.map((branch: { id: string }) => branch.id)).toEqual([nasrId]);

    // Tables: created at their branch whatever they send, and only theirs listed.
    await http().post('/v1/tables').set(auth(token)).send({ label: 'Main 1' }).expect(201);
    const created = await http().post('/v1/tables').set(auth(manager.token)).send({ label: 'Nasr 1' }).expect(201);
    expect(created.body.branchId).toBe(nasrId);
    expect((await http().get('/v1/tables').set(auth(manager.token)).expect(200)).body.map((table: { label: string }) => table.label)).toEqual(['Nasr 1']);

    const stats = await http().get(`/v1/restaurants/mine/stats?days=7`).set(auth(manager.token)).expect(200);
    expect(stats.body).toMatchObject({ branchId: nasrId, totals: { orders: 1 } });
    await http().get('/v1/restaurants/mine/stats/branches').set(auth(manager.token)).expect(403);

    const context = await http().get('/v1/kitchen/context').set(auth(manager.token)).expect(200);
    expect(context.body).toMatchObject({ role: 'MANAGER', branch: { id: nasrId, name: 'Nasr City' }, ordering: { paused: true } });
  });

  it('a branch kitchen sees its branch live, and may only mark dishes sold out', async () => {
    const { token, nasrId, dish } = await chain();
    const kitchen = await staff(token, 'KITCHEN', nasrId);
    const allBranches = await staff(token, 'KITCHEN', null, 'all@koshary.test');

    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(kitchen.token)).send({ available: false }).expect(200);
    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(kitchen.token)).send({ hidden: true }).expect(403);
    await http().patch(`/v1/branches/${nasrId}`).set(auth(kitchen.token)).send({ ordersPaused: true }).expect(403);
    await http().put(`/v1/branches/${nasrId}/menu/items/${dish.id}`).set(auth(kitchen.token)).send({ available: null }).expect(200);

    const [branchSocket, allSocket, ownerSocket] = await Promise.all([connect(kitchen.token), connect(allBranches.token), connect(token)]);
    const seen = { branch: [] as string[], all: [] as string[], owner: [] as string[] };
    branchSocket.on('order.created', (event: { order: { branchName: string } }) => seen.branch.push(event.order.branchName));
    allSocket.on('order.created', (event: { order: { branchName: string } }) => seen.all.push(event.order.branchName));
    ownerSocket.on('order.created', (event: { order: { branchName: string } }) => seen.owner.push(event.order.branchName));
    try {
      await placeOrder(dish).expect(201);
      await placeOrder(dish, { branch: 'nasr-city' }).expect(201);
      await expect.poll(() => seen.owner.length).toBe(2);
      await expect.poll(() => seen.all.length).toBe(2);
      await expect.poll(() => seen.branch).toEqual(['Nasr City']);
    } finally {
      for (const socket of [branchSocket, allSocket, ownerSocket]) socket.close();
    }
  });

  it('moving a staff account to another branch signs it out', async () => {
    const { token, mainId, nasrId } = await chain();
    const kitchen = await staff(token, 'KITCHEN', nasrId);
    const moved = await http().patch(`/v1/kitchen-accounts/${kitchen.id}`).set(auth(token)).send({ branchId: mainId }).expect(200);
    expect(moved.body).toMatchObject({ branchId: mainId, branchName: 'الفرع الرئيسي', role: 'KITCHEN' });
    await http().get('/v1/orders').set(auth(kitchen.token)).expect(401);

    const list = await http().get('/v1/kitchen-accounts').set(auth(token)).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: kitchen.id, branchId: mainId })]);
    await http().post('/v1/kitchen-accounts').set(auth(token)).send({ fullName: 'Ghost', email: 'ghost@koshary.test', password: 'staff-password', branchId: randomUUID() }).expect(404);
  });
});

describe('archiving, deleting and the main branch', () => {
  it('keeps branches with history, protects the main branch, and moves the main role', async () => {
    const { token, mainId, nasrId, dish } = await chain();
    expect((await http().patch(`/v1/branches/${mainId}`).set(auth(token)).send({ isActive: false }).expect(409)).body.error.code).toBe('MAIN_BRANCH_LOCKED');
    expect((await http().delete(`/v1/branches/${mainId}`).set(auth(token)).expect(409)).body.error.code).toBe('MAIN_BRANCH_LOCKED');

    await placeOrder(dish, { branch: 'nasr-city' }).expect(201);
    expect((await http().delete(`/v1/branches/${nasrId}`).set(auth(token)).expect(409)).body.error.code).toBe('BRANCH_HAS_ORDERS');

    const switched = await http().post(`/v1/branches/${nasrId}/main`).set(auth(token)).expect(200);
    expect(switched.body.branches.map((branch: { slug: string; isMain: boolean }) => [branch.slug, branch.isMain])).toEqual([
      ['nasr-city', true],
      ['main', false],
    ]);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.branch.slug).toBe('nasr-city');
    expect((await http().get('/v1/restaurants/mine').set(auth(token)).expect(200)).body.mainBranchId).toBe(nasrId);

    await http().patch(`/v1/branches/${mainId}`).set(auth(token)).send({ isActive: false }).expect(200);
    expect((await placeOrder(dish, { branch: 'main' }).expect(404)).body.error.code).toBe('BRANCH_NOT_FOUND');

    const fresh = await http().post('/v1/branches').set(auth(token)).send({ ...NASR, slug: 'empty', name: 'Empty' }).expect(201);
    await http().delete(`/v1/branches/${fresh.body.id}`).set(auth(token)).expect(204);
    expect((await http().get('/v1/branches').set(auth(token)).expect(200)).body).toMatchObject({ used: 1, branches: [{ slug: 'nasr-city' }, { slug: 'main', isActive: false }] });
  });

  it('compares branches over a period', async () => {
    const { token, dish } = await chain();
    await placeOrder(dish).expect(201);
    await placeOrder(dish, { branch: 'nasr-city', items: [{ menuItemId: dish.id, variantId: dish.large, quantity: 2 }] }).expect(201);
    const comparison = await http().get('/v1/restaurants/mine/stats/branches?days=7').set(auth(token)).expect(200);
    expect(comparison.body).toMatchObject({
      days: 7,
      branches: [
        { slug: 'main', orders: 1, revenuePiastres: 3500, averageOrderPiastres: 3500, pickup: 1, dineIn: 0, medianPrepMinutes: null },
        { slug: 'nasr-city', orders: 1, revenuePiastres: 10000 },
      ],
    });
    expect(comparison.body.branches[0].revenueShare + comparison.body.branches[1].revenueShare).toBeCloseTo(1);
  });

  it('isolates tenants: another owner’s branches look unknown', async () => {
    const a = await chain('a@koshary.test', 'koshary-a');
    const b = await chain('b@koshary.test', 'koshary-b');
    await http().get(`/v1/branches/${a.nasrId}`).set(auth(b.token)).expect(404);
    await http().patch(`/v1/branches/${a.nasrId}`).set(auth(b.token)).send({ ordersPaused: true }).expect(404);
    await http().get(`/v1/branches/${a.nasrId}/menu`).set(auth(b.token)).expect(404);
    await http().get(`/v1/orders?branchId=${a.nasrId}`).set(auth(b.token)).expect(404);
    await http().post('/v1/tables').set(auth(b.token)).send({ branchId: a.nasrId, label: 'Sneaky' }).expect(404);
    await http().post('/v1/kitchen-accounts').set(auth(b.token)).send({ fullName: 'Spy', email: 'spy@koshary.test', password: 'staff-password', branchId: a.nasrId }).expect(404);
    // Another restaurant's dishes cannot be ordered at a branch with the same slug.
    await placeOrder(a.dish, { branch: 'nasr-city' }, 'koshary-b').expect(409);
  });
});
