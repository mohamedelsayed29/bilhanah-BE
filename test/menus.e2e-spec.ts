import sharp from 'sharp';
import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const photo = (width = 900, height = 600, color = '#c0392b') =>
  sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();

async function ownerWithRestaurant(email: string, subdomain: string): Promise<string> {
  const token = await signUpOwner(t, email);
  await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  return token;
}

function upload(token: string, kind: 'ITEM' | 'LOGO' | 'COVER', file: Buffer, filename = 'photo.jpg') {
  return http().post(`/v1/media?kind=${kind}`).set(auth(token)).attach('file', file, filename);
}

async function category(token: string, nameAr: string, extra: Record<string, unknown> = {}) {
  const response = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr, ...extra }).expect(201);
  return response.body.id as string;
}

async function item(token: string, categoryId: string, nameAr: string, extra: Record<string, unknown> = {}) {
  const response = await http()
    .post('/v1/menu/items')
    .set(auth(token))
    .send({ categoryId, nameAr, variants: [{ pricePiastres: 4500 }], ...extra })
    .expect(201);
  return response.body.id as string;
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

describe('image upload', () => {
  it('stores WebP renditions and serves them to any origin', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    const response = await upload(token, 'ITEM', await photo(900, 600)).expect(201);

    expect(response.body).toMatchObject({ width: 900, height: 600 });
    expect(response.body.sources.map((s: { width: number }) => s.width)).toEqual([320, 640, 900]);
    expect(response.body.url).toBe(response.body.sources.at(-1).url);

    const served = await http().get(new URL(response.body.sources[0].url).pathname).expect(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(served.headers['cache-control']).toContain('immutable');
  });

  it('rejects files that are not JPEG, PNG or WebP, whatever their name', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const response = await upload(token, 'ITEM', svg, 'photo.jpg').expect(400);
    expect(response.body.error.code).toBe('UNSUPPORTED_IMAGE');
    await upload(token, 'ITEM', Buffer.from('not an image'), 'photo.png').expect(400);
  });

  it('rejects images that are too small or too large', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');

    const small = await upload(token, 'ITEM', await photo(120, 120)).expect(400);
    expect(small.body.error.code).toBe('IMAGE_TOO_SMALL');

    const huge = Buffer.concat([await photo(), Buffer.alloc(5 * 1024 * 1024)]);
    const tooLarge = await upload(token, 'ITEM', huge).expect(413);
    expect(tooLarge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires a signed-in owner with a restaurant', async () => {
    await upload('nope', 'ITEM', await photo()).expect(401);
    const token = await signUpOwner(t, 'new@koshary.test');
    const response = await upload(token, 'ITEM', await photo()).expect(404);
    expect(response.body.error.code).toBe('RESTAURANT_NOT_FOUND');
  });

  it('requires a valid kind', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await http().post('/v1/media?kind=AVATAR').set(auth(token)).attach('file', await photo(), 'a.jpg').expect(400);
  });
});

describe('menu editing', () => {
  it('builds a menu with sizes, photos and sold-out items', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const mains = await category(token, 'أطباق رئيسية', { nameEn: 'Mains' });
    const image = (await upload(token, 'ITEM', await photo()).expect(201)).body;

    const created = await http()
      .post('/v1/menu/items')
      .set(auth(token))
      .send({
        categoryId: mains,
        nameAr: 'كشري',
        nameEn: 'Koshary',
        descriptionAr: 'رز وعدس ومكرونة',
        descriptionEn: '',
        imageId: image.id,
        variants: [
          { nameAr: 'صغير', nameEn: 'Small', pricePiastres: 3500 },
          { nameAr: 'كبير', nameEn: 'Large', pricePiastres: 5500 },
        ],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      nameEn: 'Koshary',
      descriptionEn: null,
      isAvailable: true,
      image: { id: image.id },
      variants: [
        { nameEn: 'Small', pricePiastres: 3500 },
        { nameEn: 'Large', pricePiastres: 5500 },
      ],
    });

    const soldOut = await http().patch(`/v1/menu/items/${created.body.id}`).set(auth(token)).send({ isAvailable: false }).expect(200);
    expect(soldOut.body.isAvailable).toBe(false);
    expect(soldOut.body.variants).toHaveLength(2);

    const menu = await http().get('/v1/menu').set(auth(token)).expect(200);
    expect(menu.body.categories).toHaveLength(1);
    expect(menu.body.categories[0]).toMatchObject({ nameEn: 'Mains', items: [{ nameAr: 'كشري', isAvailable: false }] });
  });

  it('replaces sizes and validates prices', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const mains = await category(token, 'رئيسي');
    const id = await item(token, mains, 'فول');

    const updated = await http()
      .patch(`/v1/menu/items/${id}`)
      .set(auth(token))
      .send({ variants: [{ nameAr: 'ساندويتش', pricePiastres: 1000 }, { nameAr: 'طبق', pricePiastres: 2500 }] })
      .expect(200);
    expect(updated.body.variants.map((v: { pricePiastres: number }) => v.pricePiastres)).toEqual([1000, 2500]);

    const unnamed = await http()
      .post('/v1/menu/items')
      .set(auth(token))
      .send({ categoryId: mains, nameAr: 'طعمية', variants: [{ pricePiastres: 500 }, { pricePiastres: 900 }] })
      .expect(400);
    expect(unnamed.body.error.code).toBe('VALIDATION_FAILED');

    for (const pricePiastres of [-1, 1.5, 10_000_001]) {
      await http()
        .post('/v1/menu/items')
        .set(auth(token))
        .send({ categoryId: mains, nameAr: 'طعمية', variants: [{ pricePiastres }] })
        .expect(400);
    }
    await http().post('/v1/menu/items').set(auth(token)).send({ categoryId: mains, nameAr: 'طعمية', variants: [] }).expect(400);
  });

  it('reorders categories and items, and moves items between categories', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const [a, b, c] = [await category(token, 'أ'), await category(token, 'ب'), await category(token, 'ج')];
    const [x, y] = [await item(token, a, 'س'), await item(token, a, 'ص')];
    const z = await item(token, b, 'ع');

    await http().put('/v1/menu/categories/order').set(auth(token)).send({ ids: [c, a, b] }).expect(204);
    await http().put(`/v1/menu/categories/${a}/items/order`).set(auth(token)).send({ ids: [y, x] }).expect(204);
    await http().patch(`/v1/menu/items/${x}`).set(auth(token)).send({ categoryId: b }).expect(200);

    const menu = (await http().get('/v1/menu').set(auth(token)).expect(200)).body;
    expect(menu.categories.map((cat: { id: string }) => cat.id)).toEqual([c, a, b]);
    const itemsOf = (id: string) =>
      menu.categories.find((cat: { id: string }) => cat.id === id).items.map((i: { id: string }) => i.id);
    expect(itemsOf(a)).toEqual([y]);
    expect(itemsOf(b)).toEqual([z, x]);
  });

  it('requires a new order to list every entry exactly once', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const [a, b] = [await category(token, 'أ'), await category(token, 'ب')];

    const missing = await http().put('/v1/menu/categories/order').set(auth(token)).send({ ids: [a] }).expect(400);
    expect(missing.body.error.code).toBe('ORDER_MISMATCH');
    await http().put('/v1/menu/categories/order').set(auth(token)).send({ ids: [a, b, a] }).expect(400);
  });

  it('deletes a category together with its items', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const mains = await category(token, 'رئيسي');
    await item(token, mains, 'فول');

    await http().delete(`/v1/menu/categories/${mains}`).set(auth(token)).expect(204);
    expect(await t.prisma.menuItem.count()).toBe(0);
    await http().delete(`/v1/menu/categories/${mains}`).set(auth(token)).expect(404);
  });

  it('limits the number of categories', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const restaurant = await t.prisma.restaurant.findUniqueOrThrow({ where: { subdomain: 'koshary' } });
    await t.prisma.category.createMany({
      data: Array.from({ length: 50 }, (_, sortOrder) => ({ restaurantId: restaurant.id, nameAr: `قسم ${sortOrder}`, sortOrder })),
    });

    const response = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'زيادة' }).expect(400);
    expect(response.body.error).toMatchObject({ code: 'MENU_LIMIT_REACHED', details: { limit: 50 } });
  });

  it("never touches another restaurant's menu or images", async () => {
    const ownerA = await ownerWithRestaurant('a@koshary.test', 'restaurant-a');
    const ownerB = await ownerWithRestaurant('b@koshary.test', 'restaurant-b');
    const categoryA = await category(ownerA, 'أ');
    const itemA = await item(ownerA, categoryA, 'س');
    const imageA = (await upload(ownerA, 'ITEM', await photo()).expect(201)).body.id;
    const categoryB = await category(ownerB, 'ب');

    await http().patch(`/v1/menu/categories/${categoryA}`).set(auth(ownerB)).send({ nameAr: 'x' }).expect(404);
    await http().delete(`/v1/menu/categories/${categoryA}`).set(auth(ownerB)).expect(404);
    await http().patch(`/v1/menu/items/${itemA}`).set(auth(ownerB)).send({ nameAr: 'x' }).expect(404);
    await http().delete(`/v1/menu/items/${itemA}`).set(auth(ownerB)).expect(404);
    await http().put(`/v1/menu/categories/${categoryA}/items/order`).set(auth(ownerB)).send({ ids: [itemA] }).expect(404);
    const foreignCategory = await http()
      .post('/v1/menu/items')
      .set(auth(ownerB))
      .send({ categoryId: categoryA, nameAr: 'x', variants: [{ pricePiastres: 100 }] })
      .expect(404);
    expect(foreignCategory.body.error.code).toBe('CATEGORY_NOT_FOUND');
    const foreignImage = await http()
      .post('/v1/menu/items')
      .set(auth(ownerB))
      .send({ categoryId: categoryB, nameAr: 'x', imageId: imageA, variants: [{ pricePiastres: 100 }] })
      .expect(404);
    expect(foreignImage.body.error.code).toBe('MEDIA_NOT_FOUND');
    await http().patch('/v1/restaurants/mine').set(auth(ownerB)).send({ logoId: imageA }).expect(404);

    const menuA = (await http().get('/v1/menu').set(auth(ownerA)).expect(200)).body;
    expect(menuA.categories[0].items[0].nameAr).toBe('س');
  });

  it('rejects malformed ids', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await http().patch('/v1/menu/items/not-a-uuid').set(auth(token)).send({ nameAr: 'x' }).expect(400);
  });
});

describe('branding', () => {
  it('sets a logo, cover, color and opening hours', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const logo = (await upload(token, 'LOGO', await photo(600, 600)).expect(201)).body;
    const cover = (await upload(token, 'COVER', await photo(2400, 1000)).expect(201)).body;
    const itemImage = (await upload(token, 'ITEM', await photo()).expect(201)).body;
    const hours = {
      sat: [{ opens: '09:00', closes: '01:00' }],
      sun: [],
      mon: [{ opens: '12:00', closes: '16:00' }, { opens: '18:00', closes: '23:30' }],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
    };

    // An item photo cannot be used as the logo.
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ logoId: itemImage.id }).expect(404);

    const updated = await http()
      .patch('/v1/restaurants/mine')
      .set(auth(token))
      .send({ logoId: logo.id, coverId: cover.id, brandColor: '#0F5C4C', openingHours: hours })
      .expect(200);
    expect(updated.body).toMatchObject({ logo: { id: logo.id }, cover: { id: cover.id }, brandColor: '#0f5c4c', openingHours: hours });
    expect(cover.sources.map((s: { width: number }) => s.width)).toEqual([640, 1280, 1920]);

    const cleared = await http()
      .patch('/v1/restaurants/mine')
      .set(auth(token))
      .send({ logoId: null, openingHours: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ logo: null, openingHours: null, cover: { id: cover.id } });

    // The menu's look: classic by default; the owner's choice reaches diners.
    expect(cleared.body.menuTheme).toBe('classic');
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ menuTheme: 'arabesque' }).expect(200);
    const restaurant = (await http().get('/v1/restaurants/mine').set(auth(token)).expect(200)).body;
    expect(restaurant.menuTheme).toBe('arabesque');
    expect((await http().get(`/v1/public/restaurants/${restaurant.subdomain}/menu`).expect(200)).body.restaurant.menuTheme).toBe('arabesque');
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ menuTheme: 'neon-disco' }).expect(400);
  });

  it('validates colors and hours', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ brandColor: 'green' }).expect(400);
    await http()
      .patch('/v1/restaurants/mine')
      .set(auth(token))
      .send({ openingHours: { sat: [{ opens: '25:00', closes: '10:00' }] } })
      .expect(400);
  });
});

describe('public menu', () => {
  it('shows visible items in order, including sold-out ones, and hides empty categories', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const mains = await category(token, 'رئيسي', { nameEn: 'Mains' });
    const hidden = await category(token, 'مخفي', { isVisible: false });
    await category(token, 'فاضي');
    await item(token, hidden, 'سري');
    const koshary = await item(token, mains, 'كشري');
    await item(token, mains, 'تجريبي', { isVisible: false });
    await item(token, mains, 'رز بلبن', { isAvailable: false });

    const response = await http().get('/v1/public/restaurants/koshary/menu').expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.body.restaurant).toMatchObject({ availability: 'AVAILABLE', name: 'Koshary Abou Tarek', timezone: 'Africa/Cairo' });
    expect(response.body.categories).toHaveLength(1);
    const [only] = response.body.categories;
    expect(only.nameEn).toBe('Mains');
    expect(only.items.map((i: { nameAr: string; isAvailable: boolean }) => [i.nameAr, i.isAvailable])).toEqual([
      ['كشري', true],
      ['رز بلبن', false],
    ]);
    expect(only.items[0].id).toBe(koshary);
    expect(only.items[0]).not.toHaveProperty('isVisible');
  });

  it('reflects every edit immediately despite caching', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    const mains = await category(token, 'رئيسي');
    const id = await item(token, mains, 'كشري');
    const priceOf = async () =>
      (await http().get('/v1/public/restaurants/koshary/menu').expect(200)).body.categories[0].items[0].variants[0].pricePiastres;

    expect(await priceOf()).toBe(4500);
    expect(await priceOf()).toBe(4500); // served from the cache
    await http().patch(`/v1/menu/items/${id}`).set(auth(token)).send({ variants: [{ pricePiastres: 5000 }] }).expect(200);
    expect(await priceOf()).toBe(5000);
  });

  it('pauses the menu when the subscription has lapsed', async () => {
    const token = await ownerWithRestaurant('owner@koshary.test', 'koshary');
    await item(token, await category(token, 'رئيسي'), 'كشري');
    await t.prisma.entitlement.updateMany({
      data: { startsAt: new Date(Date.now() - 31 * DAY_MS), endsAt: new Date(Date.now() - DAY_MS) },
    });

    const response = await http().get('/v1/public/restaurants/koshary/menu').expect(200);
    expect(response.body).toEqual({
      restaurant: { availability: 'TEMPORARILY_UNAVAILABLE', subdomain: 'koshary', name: 'Koshary Abou Tarek', defaultLanguage: 'ar' },
      categories: [],
      recommendations: [],
    });
    // The owner can still prepare the menu.
    await category(token, 'حلويات');
  });

  it('returns 404 for unknown restaurants', async () => {
    await http().get('/v1/public/restaurants/nobody/menu').expect(404);
  });
});

describe('website endpoints', () => {
  it('lists plans with their features', async () => {
    const response = await http().get('/v1/public/plans').expect(200);
    expect(response.body.map((p: { code: string; priceMonthlyPiastres: number }) => [p.code, p.priceMonthlyPiastres])).toEqual([
      ['MENU', 20000],
      ['ORDERS', 35000],
      ['ADVANCED', 50000],
    ]);
    expect(response.body[2].features).toEqual({ menu: true, ordering: true, readyAlerts: true, branches: 10 });
  });

  it('forwards contact messages and drops bot submissions', async () => {
    const message = { name: 'Mona', email: 'mona@example.test', topic: 'nfc', message: 'I would like 20 NFC stands.' };

    const response = await http().post('/v1/public/contact').set('Origin', 'https://bilhanah.com').send(message).expect(202);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    const sent = t.mailer.lastTo('hello@bilhanah.test');
    expect(sent).toMatchObject({ replyTo: 'mona@example.test', subject: '[Contact · nfc] Mona' });

    t.mailer.sent.length = 0;
    await http().post('/v1/public/contact').send({ ...message, website: 'http://spam.test' }).expect(202);
    expect(t.mailer.sent).toHaveLength(0);

    await http().post('/v1/public/contact').send({ ...message, message: 'hi' }).expect(400);
  });
});
