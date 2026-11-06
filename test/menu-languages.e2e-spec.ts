import request from 'supertest';
import { createTestApp, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ownerWithRestaurant(email = 'owner@koshary.test', subdomain = 'koshary'): Promise<string> {
  const token = await signUpOwner(t, email);
  await http()
    .post('/v1/restaurants')
    .set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain })
    .expect(201);
  return token;
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

describe('menu languages', () => {
  it('lets the owner offer extra languages, in order, and shows them to diners', async () => {
    const token = await ownerWithRestaurant();
    expect((await http().get('/v1/restaurants/mine').set(auth(token)).expect(200)).body.menuLanguages).toEqual([]);

    const updated = await http().patch('/v1/restaurants/mine').set(auth(token)).send({ menuLanguages: ['ru', 'fr'] }).expect(200);
    expect(updated.body.menuLanguages).toEqual(['ru', 'fr']);
    expect((await http().get('/v1/public/restaurants/koshary').expect(200)).body.menuLanguages).toEqual(['ru', 'fr']);

    const unknown = await http().patch('/v1/restaurants/mine').set(auth(token)).send({ menuLanguages: ['fr', 'klingon'] }).expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_FAILED');
    await http().patch('/v1/restaurants/mine').set(auth(token)).send({ menuLanguages: [] }).expect(200);
  });

  it('stores translations of categories, dishes and sizes, and serves them on the public menu', async () => {
    const token = await ownerWithRestaurant();
    const category = await http()
      .post('/v1/menu/categories')
      .set(auth(token))
      .send({ nameAr: 'رئيسي', nameEn: 'Mains', translations: { fr: { name: 'Plats' }, de: { name: '' } } })
      .expect(201);
    expect(category.body.translations).toEqual({ fr: { name: 'Plats' } });

    const created = await http()
      .post('/v1/menu/items')
      .set(auth(token))
      .send({
        categoryId: category.body.id,
        nameAr: 'كشري',
        nameEn: 'Koshary',
        descriptionAr: 'عدس ورز ومكرونة',
        translations: { fr: { name: 'Kochari', description: 'Lentilles, riz et pâtes' }, it: { name: 'Koshari' } },
        variants: [
          { nameAr: 'صغير', nameEn: 'Small', translations: { fr: { name: 'Petit' } }, pricePiastres: 3500, calories: 520, portionValue: 350, portionUnit: 'GRAM', serves: 1 },
          { nameAr: 'عائلي', nameEn: 'Family', pricePiastres: 12000, calories: 2100, portionValue: 1400, portionUnit: 'GRAM', serves: 4 },
        ],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      translations: { fr: { name: 'Kochari', description: 'Lentilles, riz et pâtes' }, it: { name: 'Koshari' } },
      variants: [
        { translations: { fr: { name: 'Petit' } }, calories: 520, portionValue: 350, portionUnit: 'GRAM', serves: 1 },
        { translations: {}, calories: 2100, portionValue: 1400, portionUnit: 'GRAM', serves: 4 },
      ],
    });

    const publicMenu = await http().get('/v1/public/restaurants/koshary/menu').expect(200);
    expect(publicMenu.body.categories[0]).toMatchObject({ translations: { fr: { name: 'Plats' } } });
    expect(publicMenu.body.categories[0].items[0]).toMatchObject({
      translations: { fr: { name: 'Kochari' } },
      variants: [{ calories: 520, portionUnit: 'GRAM', serves: 1, translations: { fr: { name: 'Petit' } } }, { serves: 4 }],
    });
  });

  it('edits translations and nutrition, keeping each size’s id (and its branch prices)', async () => {
    const token = await ownerWithRestaurant();
    const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'مشروبات' }).expect(201);
    const created = await http()
      .post('/v1/menu/items')
      .set(auth(token))
      .send({ categoryId: category.body.id, nameAr: 'عصير مانجو', variants: [{ pricePiastres: 4000 }] })
      .expect(201);
    expect(created.body.variants[0]).toMatchObject({ calories: null, portionValue: null, portionUnit: null, serves: null, translations: {} });

    const edited = await http()
      .patch(`/v1/menu/items/${created.body.id}`)
      .set(auth(token))
      .send({ translations: { de: { name: 'Mangosaft' } }, variants: [{ pricePiastres: 4000, calories: 180, portionValue: 330, portionUnit: 'ML' }] })
      .expect(200);
    expect(edited.body.variants[0].id).toBe(created.body.variants[0].id);
    expect(edited.body).toMatchObject({ translations: { de: { name: 'Mangosaft' } }, variants: [{ calories: 180, portionValue: 330, portionUnit: 'ML', serves: null }] });

    // Removing a translation and the nutrition.
    const cleared = await http()
      .patch(`/v1/menu/items/${created.body.id}`)
      .set(auth(token))
      .send({ translations: { de: { name: '' } }, variants: [{ pricePiastres: 4000, calories: null, portionValue: null, portionUnit: null }] })
      .expect(200);
    expect(cleared.body).toMatchObject({ translations: {}, variants: [{ calories: null, portionValue: null, portionUnit: null }] });

    await http().patch(`/v1/menu/categories/${category.body.id}`).set(auth(token)).send({ translations: { tr: { name: 'İçecekler' } } }).expect(204);
    expect((await http().get('/v1/menu').set(auth(token)).expect(200)).body.categories[0].translations).toEqual({ tr: { name: 'İçecekler' } });
  });

  it('refuses incomplete portions, out-of-range values and unknown languages', async () => {
    const token = await ownerWithRestaurant();
    const category = await http().post('/v1/menu/categories').set(auth(token)).send({ nameAr: 'رئيسي' }).expect(201);
    const send = (body: Record<string, unknown>) => http().post('/v1/menu/items').set(auth(token)).send({ categoryId: category.body.id, nameAr: 'كشري', ...body });

    const halfPortion = await send({ variants: [{ pricePiastres: 3500, portionValue: 350 }] }).expect(400);
    expect(halfPortion.body.error.details).toContainEqual(expect.objectContaining({ path: 'variants.0.portionUnit' }));
    await send({ variants: [{ pricePiastres: 3500, calories: 20000 }] }).expect(400);
    await send({ variants: [{ pricePiastres: 3500, serves: 99 }] }).expect(400);
    await send({ translations: { xx: { name: 'nope' } }, variants: [{ pricePiastres: 3500 }] }).expect(400);
    expect(await t.prisma.menuItem.count()).toBe(0);
  });
});
