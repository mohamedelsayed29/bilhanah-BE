import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

// Shared set-up for the inventory end-to-end tests: a two-branch restaurant (Downtown, the main
// branch, and Nasr City) with koshary in two sizes and a lemonade, and a stocked kitchen.

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function fixtures(app: () => TestApp) {
  const http = () => request(app().app.getHttpServer());

  async function chain(email = 'owner@koshary.test', subdomain = 'koshary') {
    const token = await signUpOwner(app(), email);
    const created = await http().post('/v1/restaurants').set(auth(token))
      .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
    const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
    const koshary = await http().post('/v1/menu/items').set(auth(token))
      .send({ categoryId: category.body.id, nameAr: 'كشري', variants: [{ nameAr: 'صغير', pricePiastres: 3500 }, { nameAr: 'كبير', pricePiastres: 5000 }] }).expect(201);
    const lemonade = await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'ليمون نعناع', variants: [{ pricePiastres: 2000 }] }).expect(201);
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ orderingEnabled: true }).expect(200);
    const nasr = await http().post('/v1/branches').set(auth(token)).send({ name: 'Nasr City', slug: 'nasr-city', phone: '0222220000', city: 'Cairo', address: '5 Abbas El Akkad St' }).expect(201);
    await http().patch(`/v1/branches/${nasr.body.id}`).set(auth(token)).send({ orderingEnabled: true }).expect(200);
    return {
      token,
      subdomain,
      restaurantId: created.body.id as string,
      mainId: created.body.mainBranchId as string,
      nasrId: nasr.body.id as string,
      koshary: { id: koshary.body.id as string, small: koshary.body.variants[0].id as string, large: koshary.body.variants[1].id as string },
      lemonade: { id: lemonade.body.id as string, variant: lemonade.body.variants[0].id as string },
    };
  }
  type Chain = Awaited<ReturnType<typeof chain>>;

  const ingredient = async (token: string, body: Record<string, unknown>) => (await http().post('/v1/inventory/ingredients').set(auth(token)).send(body).expect(201)).body;

  /**
   * Ingredients (rice with kg and 25 kg sack units, lentils, tomato, oil, lemons, a prepared tomato
   * sauce), a supplier, inventory on, recipes for every size, and two sacks of rice received at the
   * main branch at EGP 750 a sack (3 piastres a gram).
   */
  async function stocked(email?: string, subdomain?: string) {
    const r = await chain(email, subdomain);
    const supplier = (await http().post('/v1/inventory/suppliers').set(auth(r.token)).send({ name: 'Gomla Market', phone: '01000000001' }).expect(201)).body;
    const rice = await ingredient(r.token, {
      nameAr: 'رز', nameEn: 'Rice', category: 'بقالة', dimension: 'MASS', standardCost: 2.5, preferredSupplierId: supplier.id,
      units: [{ nameAr: 'كيلو', factor: 1000 }, { nameAr: 'شيكارة 25 كيلو', factor: 25_000 }],
    });
    const lentils = await ingredient(r.token, { nameAr: 'عدس', category: 'بقالة', dimension: 'MASS', standardCost: 6, units: [{ nameAr: 'كيلو', factor: 1000 }] });
    const tomato = await ingredient(r.token, { nameAr: 'طماطم', category: 'خضار', dimension: 'MASS', standardCost: 1.5 });
    const oil = await ingredient(r.token, { nameAr: 'زيت', category: 'بقالة', dimension: 'VOLUME', standardCost: 9 });
    const lemons = await ingredient(r.token, { nameAr: 'ليمون', category: 'خضار', dimension: 'COUNT', standardCost: 200 });
    const sauce = await ingredient(r.token, { nameAr: 'صلصة طماطم', kind: 'PREPARED', dimension: 'MASS' });
    await http().put(`/v1/inventory/ingredients/${sauce.id}/recipe`).set(auth(r.token))
      .send({ yieldQuantity: 1000, lines: [{ ingredientId: tomato.id, quantity: 1200 }, { ingredientId: oil.id, quantity: 50 }] }).expect(200);
    await http().put('/v1/inventory/settings').set(auth(r.token)).send({ enabled: true, autoSoldOut: false }).expect(200);
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.small}`).set(auth(r.token))
      .send({ lines: [{ ingredientId: rice.id, quantity: 150 }, { ingredientId: lentils.id, quantity: 50 }, { ingredientId: sauce.id, quantity: 100 }] }).expect(200);
    await http().put(`/v1/inventory/recipes/variants/${r.koshary.large}`).set(auth(r.token))
      .send({ lines: [{ ingredientId: rice.id, quantity: 250, wastePercent: 10 }, { ingredientId: lentils.id, quantity: 80 }, { ingredientId: sauce.id, quantity: 150 }] }).expect(200);
    await http().put(`/v1/inventory/recipes/variants/${r.lemonade.variant}`).set(auth(r.token)).send({ lines: [{ ingredientId: lemons.id, quantity: 1 }] }).expect(200);
    const purchase = await http().post('/v1/inventory/purchases').set(auth(r.token))
      .send({ branchId: r.mainId, supplierId: supplier.id, invoiceNumber: 'INV-1', receive: true, lines: [{ ingredientId: rice.id, unitId: rice.units[1].id, quantity: 2, unitPrice: 75_000 }] }).expect(201);
    return { ...r, supplier, purchase: purchase.body, ids: { rice: rice.id as string, lentils: lentils.id as string, tomato: tomato.id as string, oil: oil.id as string, lemons: lemons.id as string, sauce: sauce.id as string }, rice };
  }

  /** Places an order through the public API; returns its id. */
  async function place(r: Chain, items: { menuItemId: string; variantId: string; quantity: number }[], branch?: string) {
    const key = randomUUID();
    await http().post(`/v1/public/restaurants/${r.subdomain}/orders`).set('Idempotency-Key', key)
      .send({ type: 'PICKUP', customerName: 'Mona', customerPhone: '01098765432', items, ...(branch && { branch }) }).expect(201);
    return (await app().prisma.order.findFirstOrThrow({ where: { restaurantId: r.restaurantId, idempotencyKey: key } })).id;
  }

  const setStatus = (token: string, orderId: string, status: string) => http().patch(`/v1/orders/${orderId}/status`).set(auth(token)).send({ status, ...(status === 'CANCELLED' || status === 'REJECTED' ? { reason: 'Out of stock' } : {}) });

  async function staff(ownerToken: string, role: 'KITCHEN' | 'MANAGER' | 'CASHIER' | 'WAITER', email: string, extra: Record<string, unknown> = {}) {
    const created = await http().post('/v1/kitchen-accounts').set(auth(ownerToken)).send({ fullName: `${role} ${email}`, email, password: 'staff-password', role, ...extra }).expect(201);
    const login = await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200);
    return { id: created.body.id as string, token: login.body.accessToken as string };
  }

  /** Stock rows of a branch by ingredient id. */
  async function stock(token: string, branchId: string) {
    const body = (await http().get(`/v1/inventory/stock?branchId=${branchId}`).set(auth(token)).expect(200)).body;
    return Object.fromEntries(body.rows.map((row: { ingredientId: string }) => [row.ingredientId, row])) as Record<string, { onHand: number; avgCost: number | null; value: number | null; status: string; reorderPoint: number | null }>;
  }

  const movements = (orderId: string) => app().prisma.stockMovement.findMany({ where: { orderId }, orderBy: [{ type: 'asc' }, { ingredientId: 'asc' }] });

  return { http, chain, stocked, ingredient, place, setStatus, staff, stock, movements };
}
