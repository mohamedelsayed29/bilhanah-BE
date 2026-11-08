#!/usr/bin/env node
// Fills a local stack (npm run dev) with a demo restaurant and menu, through the real API.
//
//   npm run seed:demo            # creates it if missing
//   npm run seed:demo -- --reset # replaces the demo menu
//
// Owner: demo-owner@bilhanah.local / demo-password-1 · Restaurant: koshary-demo
// Kitchen screen: demo-kitchen@bilhanah.local / demo-kitchen-1
// Cashier PIN on a registered POS device (/pos-login): 1234
// Development only: confirms the account through Mailpit.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '') + '/v1';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const ORIGIN = process.env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5174';
const EMAIL = 'demo-owner@bilhanah.local';
const PASSWORD = 'demo-password-1';
const SUBDOMAIN = 'koshary-demo';
const KITCHEN_EMAIL = 'demo-kitchen@bilhanah.local';
const KITCHEN_PASSWORD = 'demo-kitchen-1';
const CASHIER_EMAIL = 'demo-cashier@bilhanah.local';
const CASHIER_PASSWORD = 'demo-cashier-1';
const CASHIER_PIN = '1234';
const MEDIA = resolve(import.meta.dirname, 'demo-media');
const reset = process.argv.includes('--reset');

let token = '';

async function api(method, path, body, { expect = [200, 201, 202, 204], form } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!expect.includes(response.status)) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(data?.error ?? data)}`);
  }
  return { status: response.status, data };
}

async function latestToken() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${EMAIL}`)}`).then((r) => r.json());
    const latest = search.messages?.[0];
    if (latest) {
      const message = await fetch(`${MAILPIT}/api/v1/message/${latest.ID}`).then((r) => r.json());
      const match = /#token=([A-Za-z0-9_-]+)/.exec(message.Text);
      if (match) return match[1];
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('No email reached Mailpit. Is the worker running (npm run dev)?');
}

async function signIn() {
  const login = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, { expect: [200, 401, 403] });
  if (login.status === 200) return login.data.accessToken;
  if (login.data?.error?.code === 'INVALID_CREDENTIALS') {
    console.log('Creating the demo owner…');
    await api('POST', '/auth/register', { email: EMAIL, password: PASSWORD, fullName: 'Demo Owner', preferredLanguage: 'en' });
  } else {
    await api('POST', '/auth/resend-verification', { email: EMAIL });
  }
  await new Promise((done) => setTimeout(done, 1000));
  await api('POST', '/auth/verify-email', { token: await latestToken() });
  return (await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).data.accessToken;
}

async function upload(kind, file) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(resolve(MEDIA, file))], { type: 'image/jpeg' }), file);
  return (await api('POST', `/media?kind=${kind}`, undefined, { form })).data.id;
}

const EGP = (pounds) => Math.round(pounds * 100);

const MENU = [
  {
    nameAr: 'الأطباق الرئيسية',
    nameEn: 'Mains',
    items: [
      { nameAr: 'كشري أبو طارق', nameEn: 'Signature koshary', descriptionAr: 'رز وعدس ومكرونة وصلصة طماطم حارة وبصل مقرمش', descriptionEn: 'Rice, lentils and pasta with spicy tomato sauce and crispy onions', image: 'hero-live-food.jpg', variants: [{ nameAr: 'صغير', nameEn: 'Small', price: 35 }, { nameAr: 'وسط', nameEn: 'Medium', price: 50 }, { nameAr: 'كبير', nameEn: 'Large', price: 65 }] },
      { nameAr: 'برجر البيت', nameEn: 'House burger', descriptionAr: 'لحم مشوي، شيدر وصوص البيت', descriptionEn: 'Grilled beef, cheddar and house sauce', image: 'burger.jpg', variants: [{ nameAr: 'عادي', nameEn: 'Regular', price: 185 }, { nameAr: 'دبل', nameEn: 'Double', price: 245 }] },
      { nameAr: 'باستا بيستو', nameEn: 'Pesto pasta', descriptionAr: 'ريحان طازة، بارميزان وطماطم', descriptionEn: 'Fresh basil, parmesan and tomatoes', image: 'pasta.jpg', variants: [{ price: 155 }] },
      { nameAr: 'فتة لحمة', nameEn: 'Beef fatta', descriptionAr: 'عيش محمص ورز بالخل والتوم ولحمة ضاني', descriptionEn: 'Toasted bread, garlic-vinegar rice and lamb', variants: [{ price: 210 }], isAvailable: false },
    ],
  },
  {
    nameAr: 'سلطات وخفيف',
    nameEn: 'Salads & light',
    items: [
      { nameAr: 'سلطة الحديقة', nameEn: 'Garden salad', descriptionAr: 'خضار ملون، صوص ليمون وزيت زيتون', descriptionEn: 'Colorful greens, lemon and olive oil', image: 'salad.jpg', variants: [{ price: 95 }] },
      { nameAr: 'طحينة', descriptionAr: 'بالليمون والكمون', variants: [{ price: 20 }] },
    ],
  },
  {
    nameAr: 'مشروبات',
    nameEn: 'Drinks',
    items: [
      { nameAr: 'ليمون نعناع', nameEn: 'Lemon mint', variants: [{ price: 45 }] },
      { nameAr: 'كركديه', nameEn: 'Hibiscus', descriptionAr: 'ساقع أو سخن', descriptionEn: 'Iced or hot', variants: [{ nameAr: 'كوباية', nameEn: 'Glass', price: 30 }, { nameAr: 'دورق', nameEn: 'Jug', price: 85 }] },
    ],
  },
];

token = await signIn();
const mine = await api('GET', '/restaurants/mine', undefined, { expect: [200, 404] });
if (mine.status === 404) {
  console.log('Creating the demo restaurant…');
  await api('POST', '/restaurants', {
    name: 'Koshary Demo', contactName: 'Demo Owner', phone: '010 1234 5678', city: 'Cairo', address: '12 Tahrir Street',
    subdomain: SUBDOMAIN, defaultLanguage: 'ar', whatsappNumber: '01012345678', instagramUrl: 'https://instagram.com/bilhanah',
  });
}

const menu = (await api('GET', '/menu')).data;
if (menu.categories.length && !reset) {
  console.log('The demo menu already exists (use --reset to rebuild it).');
} else {
  for (const category of menu.categories) await api('DELETE', `/menu/categories/${category.id}`);
  console.log('Uploading photos and building the menu…');
  const [logoId, coverId] = await Promise.all([upload('LOGO', 'hero-live-menu.jpg'), upload('COVER', 'ready.jpg')]);
  const all = (pattern) => Object.fromEntries(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, pattern(day)]));
  await api('PATCH', '/restaurants/mine', {
    name: 'كشري أبو طارق',
    defaultLanguage: 'ar',
    whatsappNumber: '01012345678',
    instagramUrl: 'https://instagram.com/bilhanah',
    logoId,
    coverId,
    brandColor: '#b4432f',
    openingHours: all((day) => (day === 'fri' ? [{ opens: '13:00', closes: '02:00' }] : [{ opens: '10:00', closes: '01:00' }])),
  });
  for (const category of MENU) {
    const { id: categoryId } = (await api('POST', '/menu/categories', { nameAr: category.nameAr, nameEn: category.nameEn })).data;
    for (const { image, variants, ...item } of category.items) {
      await api('POST', '/menu/items', {
        ...item,
        categoryId,
        imageId: image ? await upload('ITEM', image) : undefined,
        variants: variants.map(({ price, ...names }) => ({ ...names, pricePiastres: EGP(price) })),
      });
    }
  }
}

const kitchens = (await api('GET', '/kitchen-accounts')).data;
if (!kitchens.some((account) => account.email === KITCHEN_EMAIL)) {
  console.log('Creating the demo kitchen account…');
  await api('POST', '/kitchen-accounts', { fullName: 'المطبخ', email: KITCHEN_EMAIL, password: KITCHEN_PASSWORD });
}
// A cashier for the cash-shift screens (with refunds and adjustments, so every drawer action shows).
if (!kitchens.some((account) => account.email === CASHIER_EMAIL)) {
  console.log('Creating the demo cashier account…');
  await api('POST', '/kitchen-accounts', {
    fullName: 'كاشير تجريبي', email: CASHIER_EMAIL, password: CASHIER_PASSWORD, role: 'CASHIER', permissions: ['payments.refund', 'cash.adjust'],
  });
}

// The cashier's POS PIN, for quick sign-in on a registered device.
const cashierAccount = (await api('GET', '/kitchen-accounts')).data.find((account) => account.email === CASHIER_EMAIL);
if (cashierAccount && !cashierAccount.hasPin) {
  console.log('Setting the demo cashier PIN…');
  await api('PUT', `/kitchen-accounts/${cashierAccount.id}/pin`, { pin: CASHIER_PIN });
}

// French and Russian on top of Arabic and English, and calories and portions
// per size. Filled in only where missing, so an owner's own edits are kept.
const DEMO_LANGUAGES = ['fr', 'ru'];
const CATEGORY_TRANSLATIONS = {
  'الأطباق الرئيسية': { fr: { name: 'Plats principaux' }, ru: { name: 'Основные блюда' } },
  'سلطات وخفيف': { fr: { name: 'Salades et en-cas' }, ru: { name: 'Салаты и закуски' } },
  'مشروبات': { fr: { name: 'Boissons' }, ru: { name: 'Напитки' } },
};
/** Per dish: translations, and per size [kcal, portion amount, unit, serves]. */
const DISH_DETAILS = {
  'كشري أبو طارق': { translations: { fr: { name: 'Kochari maison', description: 'Riz, lentilles et pâtes, sauce tomate épicée et oignons croustillants' }, ru: { name: 'Фирменный кошари', description: 'Рис, чечевица и паста с острым томатным соусом и хрустящим луком' } }, sizes: [[520, 350, 'GRAM', 1], [740, 500, 'GRAM', 1], [980, 700, 'GRAM', 2]], sizeNames: [{ fr: { name: 'Petit' }, ru: { name: 'Маленький' } }, { fr: { name: 'Moyen' }, ru: { name: 'Средний' } }, { fr: { name: 'Grand' }, ru: { name: 'Большой' } }] },
  'برجر البيت': { translations: { fr: { name: 'Burger maison', description: 'Bœuf grillé, cheddar et sauce maison' }, ru: { name: 'Домашний бургер', description: 'Говядина на гриле, чеддер и фирменный соус' } }, sizes: [[680, 250, 'GRAM', 1], [1050, 380, 'GRAM', 1]], sizeNames: [{ fr: { name: 'Simple' }, ru: { name: 'Обычный' } }, { fr: { name: 'Double' }, ru: { name: 'Двойной' } }] },
  'باستا بيستو': { translations: { fr: { name: 'Pâtes au pesto', description: 'Basilic frais, parmesan et tomates' }, ru: { name: 'Паста песто', description: 'Свежий базилик, пармезан и помидоры' } }, sizes: [[610, 320, 'GRAM', 1]] },
  'فتة لحمة': { translations: { fr: { name: 'Fatta à l’agneau', description: 'Pain grillé, riz à l’ail et au vinaigre, agneau' }, ru: { name: 'Фатта с бараниной', description: 'Поджаренный хлеб, рис с чесноком и уксусом, баранина' } }, sizes: [[1150, 600, 'GRAM', 2]] },
  'سلطة الحديقة': { translations: { fr: { name: 'Salade du jardin', description: 'Légumes colorés, citron et huile d’olive' }, ru: { name: 'Садовый салат', description: 'Свежие овощи, лимон и оливковое масло' } }, sizes: [[180, 250, 'GRAM', 1]] },
  'طحينة': { translations: { fr: { name: 'Tahina', description: 'Au citron et au cumin' }, ru: { name: 'Тахина', description: 'С лимоном и тмином' } }, sizes: [[120, 60, 'GRAM', null]] },
  'ليمون نعناع': { translations: { fr: { name: 'Citron à la menthe' }, ru: { name: 'Лимон с мятой' } }, sizes: [[140, 330, 'ML', 1]] },
  'كركديه': { translations: { fr: { name: 'Karkadé', description: 'Glacé ou chaud' }, ru: { name: 'Каркаде', description: 'Холодный или горячий' } }, sizes: [[90, 250, 'ML', 1], [320, 1000, 'ML', 4]], sizeNames: [{ fr: { name: 'Verre' }, ru: { name: 'Стакан' } }, { fr: { name: 'Carafe' }, ru: { name: 'Кувшин' } }] },
};
{
  const owned = (await api('GET', '/restaurants/mine')).data;
  if (!owned.menuLanguages?.length) await api('PATCH', '/restaurants/mine', { menuLanguages: DEMO_LANGUAGES });
  const { categories } = (await api('GET', '/menu')).data;
  let enriched = 0;
  for (const category of categories) {
    const names = CATEGORY_TRANSLATIONS[category.nameAr];
    if (names && !Object.keys(category.translations ?? {}).length) await api('PATCH', `/menu/categories/${category.id}`, { translations: names });
    for (const dish of category.items) {
      const details = DISH_DETAILS[dish.nameAr];
      if (!details || dish.variants.some((variant) => variant.calories !== null) || dish.variants.length !== details.sizes.length) continue;
      await api('PATCH', `/menu/items/${dish.id}`, {
        translations: Object.keys(dish.translations ?? {}).length ? dish.translations : details.translations,
        variants: dish.variants.map((variant, index) => {
          const [calories, portionValue, portionUnit, serves] = details.sizes[index];
          return {
            nameAr: variant.nameAr,
            nameEn: variant.nameEn,
            translations: Object.keys(variant.translations ?? {}).length ? variant.translations : (details.sizeNames?.[index] ?? {}),
            pricePiastres: variant.pricePiastres,
            calories,
            portionValue,
            portionUnit,
            serves,
          };
        }),
      });
      enriched++;
    }
  }
  if (enriched) console.log(`Added translations, calories and portions to ${enriched} demo dishes.`);
}

// A second branch, so multi-branch screens have something to show: its own
// tables (copied from the main branch), ordering on, and one dish priced differently.
const branchList = (await api('GET', '/branches')).data;
const main = branchList.branches.find((branch) => branch.isMain);
if (main && main.name === 'الفرع الرئيسي') await api('PATCH', `/branches/${main.id}`, { name: 'وسط البلد' });
let nasr = branchList.branches.find((branch) => branch.slug === 'nasr-city');
if (!nasr && branchList.used < branchList.limit) {
  console.log('Creating the demo branch in Nasr City…');
  nasr = (
    await api('POST', '/branches', {
      name: 'مدينة نصر',
      slug: 'nasr-city',
      phone: '0222220000',
      city: 'القاهرة',
      address: '5 شارع عباس العقاد',
      mapUrl: 'https://maps.google.com/?q=Abbas+El+Akkad+Nasr+City',
      openingHours: Object.fromEntries(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, [{ opens: '12:00', closes: '02:00' }]])),
      ...(main && { copyTablesFrom: main.id }),
    })
  ).data;
  await api('PATCH', `/branches/${nasr.id}`, { orderingEnabled: true });
  const firstDish = (await api('GET', `/branches/${nasr.id}/menu`)).data.categories[0]?.items[0];
  if (firstDish) {
    await api('PUT', `/branches/${nasr.id}/menu/items/${firstDish.id}`, {
      prices: [{ variantId: firstDish.variants[0].id, pricePiastres: firstDish.variants[0].pricePiastres + 500 }],
    });
  }
}

// Inventory, recipes and costs (Full Experience plan): Egyptian pantry ingredients with purchase
// units, a prepared tomato sauce, crispy onions and garlic-vinegar dressing, recipes for every dish
// size, suppliers, a received purchase and some waste at each branch, and reorder levels. Only what
// is missing is added, so the owner's own data is kept. Costs are piastres per gram, ml or piece.
// Cheddar and mint are set to need reordering, so the reorder list has something to show.
await seedInventory();

async function seedInventory() {
  const settings = await api('GET', '/inventory/settings', undefined, { expect: [200, 409] });
  if (settings.status === 409) {
    console.log('Inventory skipped: the demo plan does not include it.');
    return;
  }
  if (!settings.data.updatedAt) await api('PUT', '/inventory/settings', { enabled: true, autoSoldOut: true });

  const SUPPLIERS = [
    { name: 'شركة النيل للمواد الغذائية', phone: '0223900000', note: 'رز وعدس ومكرونة وزيت — توريد كل حد' },
    { name: 'سوق العبور — خضار الحاج سيد', phone: '01001234567', note: 'خضار وفاكهة كل يوم الصبح' },
    { name: 'جزارة الأمانة', phone: '01112345678' },
    { name: 'مخبز الفردوس', phone: '01223456789' },
    { name: 'تغليف بلس', phone: '0233334444', email: 'orders@taghleef.example' },
  ];
  const suppliers = new Map((await api('GET', '/inventory/suppliers')).data.map((row) => [row.name, row.id]));
  for (const supplier of SUPPLIERS) {
    if (!suppliers.has(supplier.name)) suppliers.set(supplier.name, (await api('POST', '/inventory/suppliers', supplier)).data.id);
  }
  const [nile, obour, butcher, bakery, packaging] = SUPPLIERS.map((supplier) => suppliers.get(supplier.name));

  const kg = { nameAr: 'كيلو', nameEn: 'kg', factor: 1000 };
  const litre = { nameAr: 'لتر', nameEn: 'L', factor: 1000 };
  // [nameAr, nameEn, category, dimension, standard cost, preferred supplier, purchase units]
  const RAW = [
    ['رز مصري', 'Egyptian rice', 'بقالة', 'MASS', 3.2, nile, [kg, { nameAr: 'شيكارة 25 كيلو', nameEn: '25 kg sack', factor: 25_000 }]],
    ['عدس بني', 'Brown lentils', 'بقالة', 'MASS', 6.5, nile, [kg, { nameAr: 'شيكارة 10 كيلو', nameEn: '10 kg sack', factor: 10_000 }]],
    ['مكرونة كوع', 'Elbow pasta', 'بقالة', 'MASS', 4, nile, [kg, { nameAr: 'كرتونة 20 كيس', nameEn: 'Carton of 20 × 400 g', factor: 8000 }]],
    ['مكرونة اسباجتي', 'Spaghetti', 'بقالة', 'MASS', 5, nile, [kg]],
    ['زيت عباد الشمس', 'Sunflower oil', 'بقالة', 'VOLUME', 9.5, nile, [litre, { nameAr: 'جركن 5 لتر', nameEn: '5 L jerrycan', factor: 5000 }]],
    ['خل', 'Vinegar', 'بقالة', 'VOLUME', 2, nile, [litre]],
    ['سكر', 'Sugar', 'بقالة', 'MASS', 3.5, nile, [kg]],
    ['طحينة خام', 'Raw tahini', 'بقالة', 'MASS', 12, nile, [kg]],
    ['كمون', 'Cumin', 'توابل', 'MASS', 30, nile, [kg]],
    ['ملح', 'Salt', 'توابل', 'MASS', 0.5, nile, [kg]],
    ['طماطم', 'Tomatoes', 'خضار', 'MASS', 1.8, obour, [kg, { nameAr: 'صندوق 20 كيلو', nameEn: '20 kg crate', factor: 20_000 }]],
    ['بصل', 'Onions', 'خضار', 'MASS', 1.2, obour, [kg, { nameAr: 'شوال 20 كيلو', nameEn: '20 kg sack', factor: 20_000 }]],
    ['ثوم', 'Garlic', 'خضار', 'MASS', 8, obour, [kg]],
    ['خس', 'Lettuce', 'خضار', 'MASS', 2.5, obour, [kg]],
    ['ليمون', 'Lemons', 'خضار', 'MASS', 3, obour, [kg]],
    ['نعناع', 'Mint', 'خضار', 'MASS', 6, obour, [kg]],
    ['ريحان', 'Basil', 'خضار', 'MASS', 15, obour, [kg]],
    ['كركديه ناشف', 'Dried hibiscus', 'مشروبات', 'MASS', 25, nile, [kg]],
    ['لحم بقري مفروم', 'Minced beef', 'لحوم', 'MASS', 45, butcher, [kg]],
    ['جبنة شيدر', 'Cheddar', 'ألبان', 'MASS', 40, nile, [kg]],
    ['جبنة بارميزان', 'Parmesan', 'ألبان', 'MASS', 90, nile, [kg]],
    ['عيش برجر', 'Burger buns', 'مخبوزات', 'COUNT', 300, bakery, [{ nameAr: 'كيس 6', nameEn: 'Bag of 6', factor: 6 }]],
    ['عيش بلدي', 'Baladi bread', 'مخبوزات', 'COUNT', 100, bakery, [{ nameAr: 'ربطة 10', nameEn: 'Bundle of 10', factor: 10 }]],
    ['كوباية ورق', 'Paper cup', 'تغليف', 'COUNT', 75, packaging, [{ nameAr: 'كرتونة 1000', nameEn: 'Carton of 1000', factor: 1000 }]],
    ['علبة كشري', 'Koshary box', 'تغليف', 'COUNT', 150, packaging, [{ nameAr: 'كرتونة 500', nameEn: 'Carton of 500', factor: 500 }]],
  ];
  // [nameAr, nameEn, dimension, yield, [[ingredient, quantity, waste %]]]
  const PREPARED = [
    ['صلصة طماطم', 'Tomato sauce', 'MASS', 1000, [['طماطم', 1200, 5], ['زيت عباد الشمس', 40, 0], ['ثوم', 20, 10], ['كمون', 5, 0], ['ملح', 10, 0], ['خل', 30, 0]]],
    ['بصل مقرمش', 'Crispy onions', 'MASS', 350, [['بصل', 1000, 10], ['زيت عباد الشمس', 150, 0], ['ملح', 5, 0]]],
    ['دقة', 'Garlic-vinegar dressing', 'VOLUME', 500, [['خل', 400, 0], ['ثوم', 60, 10], ['كمون', 5, 0], ['ملح', 8, 0]]],
  ];

  const ingredients = new Map((await api('GET', '/inventory/ingredients?includeInactive=true')).data.map((row) => [row.nameAr, row]));
  let created = 0;
  for (const [nameAr, nameEn, category, dimension, standardCost, preferredSupplierId, units] of RAW) {
    if (ingredients.has(nameAr)) continue;
    ingredients.set(nameAr, (await api('POST', '/inventory/ingredients', { nameAr, nameEn, category, dimension, standardCost, preferredSupplierId, units })).data);
    created++;
  }
  for (const [nameAr, nameEn, dimension, yieldQuantity, lines] of PREPARED) {
    if (!ingredients.has(nameAr)) {
      ingredients.set(nameAr, (await api('POST', '/inventory/ingredients', { nameAr, nameEn, category: 'تحضيرات', kind: 'PREPARED', dimension })).data);
      created++;
    }
    const current = ingredients.get(nameAr);
    if (current.recipe.length) continue;
    await api('PUT', `/inventory/ingredients/${current.id}/recipe`, {
      yieldQuantity,
      lines: lines.map(([name, quantity, wastePercent]) => ({ ingredientId: ingredients.get(name).id, quantity, wastePercent })),
    });
  }
  if (created) console.log(`Added ${created} demo ingredients.`);
  const id = (name) => ingredients.get(name).id;
  const unit = (name, unitName) => ingredients.get(name).units.find((row) => row.nameAr === unitName).id;

  // Recipes per dish and size (sizes in menu order). [ingredient, quantity as served, waste %]
  const koshary = (scale) => [['رز مصري', 90 * scale], ['عدس بني', 40 * scale], ['مكرونة كوع', 60 * scale], ['صلصة طماطم', 80 * scale], ['بصل مقرمش', 15 * scale], ['دقة', 20 * scale], ['علبة كشري', 1]];
  const burger = (patties) => [['لحم بقري مفروم', 120 * patties, 10], ['جبنة شيدر', 20 * patties], ['عيش برجر', 1], ['خس', 15], ['طماطم', 30, 10], ['بصل', 10, 10]];
  const RECIPES = {
    'كشري أبو طارق': [koshary(1), koshary(1.4), koshary(1.9)],
    'برجر البيت': [burger(1), burger(2)],
    'باستا بيستو': [[['مكرونة اسباجتي', 150], ['ريحان', 20, 15], ['جبنة بارميزان', 25], ['زيت عباد الشمس', 20], ['ثوم', 5, 10], ['طماطم', 50, 10]]],
    'فتة لحمة': [[['رز مصري', 150], ['لحم بقري مفروم', 150, 15], ['عيش بلدي', 1], ['صلصة طماطم', 100], ['دقة', 30]]],
    'سلطة الحديقة': [[['خس', 120, 15], ['طماطم', 80, 10], ['بصل', 20, 10], ['ليمون', 15, 50], ['زيت عباد الشمس', 10]]],
    'طحينة': [[['طحينة خام', 40], ['ليمون', 10, 50], ['كمون', 1], ['ملح', 1]]],
    'ليمون نعناع': [[['ليمون', 60, 50], ['نعناع', 10, 20], ['سكر', 25], ['كوباية ورق', 1]]],
    'كركديه': [[['كركديه ناشف', 10], ['سكر', 25], ['كوباية ورق', 1]], [['كركديه ناشف', 40], ['سكر', 100]]],
  };
  let recipes = 0;
  for (const category of (await api('GET', '/menu')).data.categories) {
    for (const dish of category.items) {
      const sizes = RECIPES[dish.nameAr];
      if (!sizes || sizes.length !== dish.variants.length) continue;
      for (const [index, variant] of dish.variants.entries()) {
        if ((await api('GET', `/inventory/recipes/variants/${variant.id}`)).data.lines.length) continue;
        await api('PUT', `/inventory/recipes/variants/${variant.id}`, {
          lines: sizes[index].map(([name, quantity, wastePercent = 0]) => ({ ingredientId: id(name), quantity: Math.round(quantity * 1000) / 1000, wastePercent })),
        });
        recipes++;
      }
    }
  }
  if (recipes) console.log(`Added recipes for ${recipes} dish sizes.`);

  // A week's delivery at each branch (Nasr City pays a little more), some waste, and reorder levels.
  const { branches } = (await api('GET', '/branches')).data;
  const DELIVERY = [
    // [ingredient, unit, quantity, piastres per unit at the main branch]
    ['رز مصري', 'شيكارة 25 كيلو', 2, 80_000], ['عدس بني', 'شيكارة 10 كيلو', 2, 65_000], ['مكرونة كوع', 'كرتونة 20 كيس', 3, 32_000],
    ['مكرونة اسباجتي', 'كيلو', 6, 5000], ['زيت عباد الشمس', 'جركن 5 لتر', 3, 47_500], ['خل', 'لتر', 6, 2000], ['سكر', 'كيلو', 10, 3500],
    ['طحينة خام', 'كيلو', 3, 12_000], ['كمون', 'كيلو', 1, 30_000], ['ملح', 'كيلو', 5, 500], ['طماطم', 'صندوق 20 كيلو', 2, 36_000],
    ['بصل', 'شوال 20 كيلو', 1, 24_000], ['ثوم', 'كيلو', 2, 8000], ['خس', 'كيلو', 5, 2500], ['ليمون', 'كيلو', 6, 3000], ['نعناع', 'كيلو', 1, 6000],
    ['ريحان', 'كيلو', 1, 15_000], ['كركديه ناشف', 'كيلو', 2, 25_000], ['لحم بقري مفروم', 'كيلو', 12, 45_000], ['جبنة شيدر', 'كيلو', 3, 40_000],
    ['جبنة بارميزان', 'كيلو', 1, 90_000], ['عيش برجر', 'كيس 6', 20, 1800], ['عيش بلدي', 'ربطة 10', 5, 1000], ['كوباية ورق', 'كرتونة 1000', 1, 75_000],
    ['علبة كشري', 'كرتونة 500', 1, 75_000],
  ];
  const LEVELS = {
    'رز مصري': [20_000, 60_000], 'عدس بني': [8000, 25_000], 'مكرونة كوع': [6000, 24_000], 'زيت عباد الشمس': [5000, 15_000], 'طماطم': [10_000, 40_000],
    'بصل': [5000, 20_000], 'لحم بقري مفروم': [4000, 12_000], 'جبنة شيدر': [4000, 8000], 'عيش برجر': [24, 120], 'ليمون': [2000, 6000],
    'نعناع': [1000, 2000], 'كوباية ورق': [200, 1000], 'علبة كشري': [100, 500], 'سكر': [3000, 10_000],
  };
  for (const branch of branches) {
    const factor = branch.isMain ? 1 : 1.05;
    const purchases = (await api('GET', `/inventory/purchases?branchId=${branch.id}&pageSize=1`)).data;
    if (!purchases.total) {
      // Delivered per supplier, as separate invoices.
      const bySupplier = new Map();
      for (const [name, unitName, quantity, price] of DELIVERY) {
        const supplierId = ingredients.get(name).preferredSupplier?.id ?? null;
        const lines = bySupplier.get(supplierId) ?? [];
        lines.push({ ingredientId: id(name), unitId: unit(name, unitName), quantity: branch.isMain ? quantity : Math.max(1, Math.round(quantity * 0.6)), unitPrice: Math.round(price * factor) });
        bySupplier.set(supplierId, lines);
      }
      let invoice = 1;
      for (const [supplierId, lines] of bySupplier) {
        await api('POST', '/inventory/purchases', { branchId: branch.id, supplierId, invoiceNumber: `${branch.isMain ? 'DT' : 'NC'}-${String(invoice++).padStart(4, '0')}`, receive: true, lines });
      }
      console.log(`Received the demo deliveries at ${branch.name}.`);
    }
    const waste = (await api('GET', `/inventory/waste?branchId=${branch.id}&pageSize=1`)).data;
    if (!waste.total) {
      await api('POST', '/inventory/waste', { branchId: branch.id, reason: 'SPOILED', note: 'طماطم طرية زيادة', lines: [{ ingredientId: id('طماطم'), unitId: unit('طماطم', 'كيلو'), quantity: branch.isMain ? 2.5 : 1 }] });
      await api('POST', '/inventory/waste', { branchId: branch.id, reason: 'EXPIRED', lines: [{ ingredientId: id('نعناع'), quantity: 150 }, { ingredientId: id('خس'), quantity: 400 }] });
      if (branch.isMain) {
        const kosharyDish = (await api('GET', '/menu')).data.categories.flatMap((category) => category.items).find((dish) => dish.nameAr === 'كشري أبو طارق');
        if (kosharyDish) await api('POST', '/inventory/waste', { branchId: branch.id, reason: 'DROPPED', note: 'طبق وقع من الويتر', lines: [{ variantId: kosharyDish.variants[1].id, quantity: 1 }] });
        await api('POST', '/inventory/waste', { branchId: branch.id, reason: 'STAFF_MEAL', lines: [{ ingredientId: id('رز مصري'), quantity: 600 }, { ingredientId: id('عدس بني'), quantity: 250 }] });
      }
    }
    const stock = (await api('GET', `/inventory/stock?branchId=${branch.id}`)).data.rows;
    for (const [name, [reorderPoint, parLevel]] of Object.entries(LEVELS)) {
      const row = stock.find((candidate) => candidate.ingredientId === id(name));
      if (row && row.reorderPoint === null) {
        await api('PATCH', `/inventory/stock/${id(name)}?branchId=${branch.id}`, { reorderPoint: branch.isMain ? reorderPoint : Math.round(reorderPoint * 0.6), parLevel: branch.isMain ? parLevel : Math.round(parLevel * 0.6) });
      }
    }
  }
}

// Feedback and reviews (Menu & Orders and Full Experience plans): reviews on, shown on the menu
// (dish badges after 2 ratings), unverified feedback allowed, a Google review link on each branch,
// and about twenty Egyptian diners' reviews of real completed pickup orders at both branches over
// the last weeks: replies, dish ratings, tags, low ratings with follow-ups, and two waiting for
// moderation (AUTO publishes 3 stars and up). Orders use fixed idempotency keys, so running the
// seed again finds them instead of ordering twice; the new ones are then backdated in the database.
await seedReviews();

async function seedReviews() {
  const settings = await api('GET', '/reviews/settings', undefined, { expect: [200, 409] });
  if (settings.status === 409) {
    console.log('Reviews skipped: the demo plan does not include them.');
    return;
  }
  if (!settings.data.updatedAt) {
    await api('PUT', '/reviews/settings', {
      enabled: true, showOnMenu: true, menuMinCount: 2, allowUnverified: true, publishMode: 'AUTO', publishMinStars: 3,
      subRatings: ['food', 'service', 'value', 'speed'], googlePrompt: true, googleMinStars: 4, alertBelowStars: 3,
    });
  }
  const { branches } = (await api('GET', '/branches')).data;
  const GOOGLE = { main: 'https://search.google.com/local/writereview?placeid=ChIJdemoKosharyDowntown', 'nasr-city': 'https://search.google.com/local/writereview?placeid=ChIJdemoKosharyNasrCity' };
  for (const branch of branches) {
    if (!branch.googleReviewUrl && GOOGLE[branch.slug]) await api('PATCH', `/branches/${branch.id}`, { googleReviewUrl: GOOGLE[branch.slug] });
  }

  const dishes = new Map((await api('GET', '/menu')).data.categories.flatMap((category) => category.items).map((dish) => [dish.nameAr, dish]));
  const line = (name, size = 0, quantity = 1) => {
    const dish = dishes.get(name);
    return dish && { menuItemId: dish.id, variantId: dish.variants[Math.min(size, dish.variants.length - 1)].id, quantity };
  };
  const K = 'كشري أبو طارق', B = 'برجر البيت', P = 'باستا بيستو', S = 'سلطة الحديقة', T = 'طحينة', L = 'ليمون نعناع', H = 'كركديه';
  // [branch, days ago, diner, phone, order lines, review, thumbs per line (1 up, 0 down), reply, follow-up]
  const REVIEWS = [
    ['main', 26, 'منى أحمد', '01001112233', [[K, 1, 2], [L]], { overall: 5, ratings: { food: 5, service: 5, value: 5, speed: 4 }, tags: ['DELICIOUS', 'GOOD_VALUE'], comment: 'أحلى كشري في وسط البلد بجد، والدقة نار 🔥 هنرجع تاني أكيد' }, [1, 1], 'نورتينا يا منى، مستنيينك تاني!'],
    ['main', 25, 'Karim Fathy', '01112223344', [[B, 1], [L]], { overall: 4, ratings: { food: 4, service: 4, value: 3, speed: 4 }, tags: ['DELICIOUS'], comment: 'Burger was juicy and the cheddar was generous. A bit pricey for a double, but worth it.', language: 'en' }, [1, 1]],
    ['nasr-city', 24, 'أحمد سمير', '01223334455', [[K, 2], [T, 0, 2]], { overall: 5, ratings: { food: 5, service: 4, value: 5 }, tags: ['DELICIOUS', 'FAST', 'GOOD_VALUE'], comment: 'الكبير يشبّع اتنين، والطحينة فريش. التسليم كان في عشر دقايق' }, [1, 1]],
    ['main', 22, 'Sara Mostafa', '01098887766', [[P], [S]], { overall: 3, ratings: { food: 3, service: 4, value: 3 }, tags: ['SMALL_PORTION'], comment: 'Pesto tasted good but the portion is small for 155 EGP. Salad was fresh.', language: 'en' }, [0, 1], 'Thanks Sara! We have just made the pasta portion bigger, come try it again.'],
    ['nasr-city', 21, 'محمود عبد العزيز', '01009998877', [[K, 1], [H, 0]], { overall: 2, ratings: { food: 2, service: 3, speed: 1 }, tags: ['SLOW', 'COLD_FOOD'], comment: 'استنيت نص ساعة والكشري وصل فاتر. المكان كان زحمة بس كان ممكن يقولولي من الأول', contactPhone: '01009998877' }, [0, 1], 'حقك علينا يا أستاذ محمود، كان يوم ماتش والمطبخ اتزحم. كلمناك وعوضناك، وزوّدنا فرد في المطبخ أيام الزحمة.', ['RESOLVED', 'اتصلت بيه واعتذرت، بعتناله طلب كشري هدية. كان مبسوط في الآخر']],
    ['main', 20, 'Youssef Adel', '01155554444', [[B], [K, 0]], { overall: 5, ratings: { food: 5, service: 5, speed: 5 }, tags: ['FAST', 'FRIENDLY_STAFF'], comment: 'Super quick pickup and the staff were really nice. Koshary + burger combo is a win.', language: 'en' }, [1, 1]],
    ['main', 18, 'هبة الله إبراهيم', '01277776655', [[S], [L], [T]], { overall: 4, ratings: { food: 4, service: 5, value: 4 }, tags: ['CLEAN', 'FRIENDLY_STAFF'], comment: 'السلطة حلوة والليمون نعناع منعش جدًا. المكان نضيف' }, [1, 1, 1]],
    ['nasr-city', 17, 'عمر خالد', '01033332211', [[B, 1], [H, 1]], { overall: 4, ratings: { food: 5, service: 3, value: 4 }, tags: ['DELICIOUS'], comment: 'البرجر الدبل ممتاز. الكاشير كان مستعجل شوية بس عادي' }, [1, 1], 'شكرًا يا عمر! هنوصل ملاحظتك للفريق 🙏'],
    ['main', 15, 'نادية فؤاد', null, [[K, 1], [K, 0]], { overall: 5, ratings: { food: 5, value: 5 }, tags: ['DELICIOUS', 'GOOD_VALUE'], comment: 'كشري زي بتاع زمان، والبصل مقرمش. طلبت لبيتي كله' }, [1, 1]],
    ['nasr-city', 14, 'Mariam Hany', '01144443322', [[P], [L]], { overall: 1, ratings: { food: 1, service: 2, speed: 2 }, tags: ['WRONG_ORDER', 'COLD_FOOD'], comment: 'I ordered pesto pasta and got it without basil and cold. Nobody picked up the phone when I called.', language: 'en', contactPhone: '01144443322' }, [0, 0], null, ['CONTACTED', 'Called her, apologised, offered a free meal next visit. She will come on Friday.']],
    ['main', 13, 'إسلام رمضان', '01266665544', [[K, 2], [L, 0, 2]], { overall: 4, ratings: { food: 4, service: 4, value: 5, speed: 3 }, tags: ['GOOD_VALUE'], comment: 'الأكل حلو والسعر معقول، بس التسليم اتأخر شوية' }, [1, 1]],
    ['main', 11, 'Laila Samir', '01022221100', [[S], [P]], { overall: 5, ratings: { food: 5, service: 5 }, tags: ['DELICIOUS', 'CLEAN'], comment: 'Fresh, colourful and tasty. Best pesto I have had in Downtown.', language: 'en' }, [1, 1], 'Thank you Laila, see you soon!'],
    ['nasr-city', 10, 'حسن الشافعي', '01199990000', [[K, 1], [T]], { overall: 3, ratings: { food: 3, service: 3, value: 4 }, tags: ['SMALL_PORTION'], comment: 'الكشري كويس بس الوسط بقى أصغر من الأول' }, [0, 1]],
    ['main', 9, 'رانيا مجدي', '01288887766', [[B], [S]], { overall: 2, ratings: { food: 2, service: 2, value: 2 }, tags: ['RUDE_STAFF'], comment: 'البرجر كان محروق من برة ونيء من جوة، ولما قلت للكاشير رد بطريقة مش لطيفة', contactPhone: '01288887766' }, [0, 1], 'آسفين جدًا يا رانيا، ده مش المستوى اللي بنقدمه. اتكلمنا مع الفريق وهنتصل بيكي.', ['CONTACTED', 'كلمتها وعرضنا نرجّع الفلوس، طلبت ترجع تجرب تاني بدل كده']],
    ['main', 7, 'Ahmed Tarek', '01011110000', [[K, 1], [H, 0]], { overall: 5, ratings: { food: 5, service: 5, value: 5, speed: 5 }, tags: ['FAST', 'DELICIOUS', 'FRIENDLY_STAFF'], comment: 'Perfect every single time. The karkade is homemade and you can taste it.', language: 'en' }, [1, 1]],
    ['nasr-city', 6, 'شيماء عادل', '01055550000', [[K, 0], [L]], { overall: 4, ratings: { food: 4, service: 5 }, tags: ['FRIENDLY_STAFF'], comment: 'الولد اللي على الكاشير ذوق جدًا، والكشري طعمه حلو' }, [1, 1]],
    ['main', 5, 'مصطفى جمال', '01133330000', [[B, 1], [K, 0], [L]], { overall: 1, ratings: { food: 2, service: 1, speed: 1 }, tags: ['SLOW', 'WRONG_ORDER'], comment: 'ساعة إلا ربع على الطلب وفي الآخر البرجر طلع عادي مش دبل. محدش اعتذر', contactPhone: '01133330000' }, [0, 1, 1], null, ['OPEN', 'هكلمه بكرة الصبح بعد ما أراجع الطلب مع المطبخ']],
    ['nasr-city', 4, 'Nour El Din', '01266660000', [[P], [S]], { overall: 4, ratings: { food: 4, value: 3 }, tags: ['CLEAN'], comment: 'Nice and clean branch. Pasta was good, salad dressing could use more lemon.', language: 'en' }, [1, 0]],
    ['main', 2, 'دينا حسام', '01077770000', [[K, 2], [T, 0, 2], [H, 1]], { overall: 5, ratings: { food: 5, service: 5, value: 5, speed: 4 }, tags: ['DELICIOUS', 'GOOD_VALUE'], comment: 'عزومة العيلة كلها كانت من عندكم، الكل انبسط والكمية ممتازة' }, [1, 1, 1], 'ألف هنا يا دينا، تشرفونا دايمًا ❤️'],
    ['nasr-city', 1, 'Omar Hesham', '01188880000', [[B], [L]], { overall: 4, ratings: { food: 4, service: 4, speed: 5 }, tags: ['FAST'], comment: 'Fast and tasty. Would love a spicy sauce option for the burger.', language: 'en' }, [1, 1]],
  ];

  const existing = (await api('GET', '/reviews?pageSize=1')).data.total;
  if (existing >= REVIEWS.length) {
    console.log('The demo reviews already exist.');
    return;
  }
  const orderIdOf = (trackingToken) => {
    const hex = Buffer.from(trackingToken.split('.')[0], 'base64url').toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const created = [];
  let index = 0;
  for (const [slug, daysAgo, name, phone, lines, review, thumbs, reply, followUp] of REVIEWS) {
    index++;
    const items = lines.map(([dish, size, quantity]) => line(dish, size, quantity)).filter(Boolean);
    if (!items.length) continue;
    const placed = await fetch(`${API}/public/restaurants/${SUBDOMAIN}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `demo-review-order-${String(index).padStart(2, '0')}` },
      body: JSON.stringify({ type: 'PICKUP', branch: slug, customerName: name, customerPhone: phone ?? '01000000000', items }),
    });
    const body = await placed.json();
    if (placed.status !== 201) {
      // A dish sold out by inventory: skip that diner. Otherwise the branch is closed or not taking orders.
      if (['ITEMS_UNAVAILABLE', 'INSUFFICIENT_STOCK'].includes(body?.error?.code)) continue;
      console.log(`Demo reviews stopped: ${body?.error?.code ?? placed.status} at ${slug} (orders go through the real API: run the seed again while it is open).`);
      break;
    }
    const orderId = orderIdOf(body.trackingToken);
    for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) {
      const current = (await api('GET', `/orders/${orderId}`)).data.status;
      if (current === 'COMPLETED') break;
      if (['ACCEPTED', 'READY', 'COMPLETED'].indexOf(current) >= ['ACCEPTED', 'READY', 'COMPLETED'].indexOf(status)) continue;
      await api('PATCH', `/orders/${orderId}/status`, { status });
    }
    const state = (await api('GET', `/public/orders/${body.trackingToken}/review`)).data;
    if (state.review) continue;
    const { contactPhone, ...fields } = review;
    await api('PUT', `/public/orders/${body.trackingToken}/review`, {
      ...fields,
      name,
      language: fields.language ?? 'ar',
      ...(contactPhone && { contactPhone, contactConsent: true }),
      dishes: state.form.dishes.map((dish, position) => ({ orderItemId: dish.orderItemId, rating: thumbs[position] === 0 ? 1 : 5 })),
    });
    const row = (await api('GET', `/reviews?q=%23${body.order.number}&branchId=${branches.find((branch) => branch.slug === slug).id}&pageSize=100`)).data.items.find((item) => item.orderId === orderId);
    if (!row) continue;
    if (reply) await api('PUT', `/reviews/${row.id}/reply`, { text: reply });
    if (followUp) await api('PATCH', `/reviews/${row.id}/follow-up`, { status: followUp[0], note: followUp[1] });
    // Unhappy reviews the restaurant answered are published; the others stay waiting for moderation.
    if (row.status === 'PENDING' && reply) await api('POST', `/reviews/${row.id}/publish`);
    created.push({ orderId, reviewId: row.id, daysAgo, replied: Boolean(reply) });
  }
  // Two pieces of unverified feedback from the menu.
  if (created.length && !existing) {
    for (const [slug, body] of [
      ['main', { overall: 5, comment: 'أكلت في المحل، الخدمة ممتازة والمكان نضيف', name: 'زائر', tags: ['CLEAN', 'FRIENDLY_STAFF'] }],
      ['nasr-city', { overall: 3, comment: 'Seating area was a bit crowded on Thursday night.', name: 'Guest', language: 'en' }],
    ]) {
      await fetch(`${API}/public/restaurants/${SUBDOMAIN}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: slug, ...body }) });
    }
  }
  if (created.length) {
    await backdate(created);
    console.log(`Added ${created.length} demo reviews.`);
  }
}

/** Spreads the reviews just created over the last weeks (orders, their history and the reviews' times). */
async function backdate(rows) {
  const { default: pg } = await import('pg');
  const { parseEnv } = await import('node:util');
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      url = parseEnv(await readFile(resolve(import.meta.dirname, '../.env'), 'utf8')).DATABASE_URL;
    } catch {
      // No .env file.
    }
  }
  if (!url) {
    console.log('Reviews left dated today: set DATABASE_URL to spread them over the last weeks.');
    return;
  }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    for (const [position, row] of rows.entries()) {
      await db.query('BEGIN');
      // Lunch or dinner time, a few minutes apart per review.
      const { rows: [order] } = await db.query(
        `SELECT o.id, o.branch_id, o.placed_at, r.restaurant_id,
           (date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') - make_interval(days => $2) + make_interval(hours => $3, mins => $4)) AT TIME ZONE 'Africa/Cairo' AS target
         FROM orders o JOIN reviews r ON r.order_id = o.id WHERE o.id = $1 FOR UPDATE OF o`,
        [row.orderId, row.daysAgo, position % 2 ? 20 : 14, (position * 7) % 50],
      );
      const shift = [order.placed_at, order.target];
      const by = `($2::timestamptz - $1::timestamptz)`;
      await db.query(`UPDATE order_status_events SET created_at = created_at + ${by} WHERE order_id = $3`, [...shift, row.orderId]);
      await db.query(`UPDATE order_item_events SET created_at = created_at + ${by} WHERE order_id = $3`, [...shift, row.orderId]);
      await db.query(
        `UPDATE order_items SET accepted_at = accepted_at + ${by}, started_at = started_at + ${by}, ready_at = ready_at + ${by}, served_at = served_at + ${by} WHERE order_id = $3`,
        [...shift, row.orderId],
      );
      const day = (await db.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS day`, [order.target])).rows[0].day;
      const number = (await db.query('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM orders WHERE branch_id = $1 AND business_day = $2', [order.branch_id, day])).rows[0].next;
      await db.query(
        `UPDATE orders SET placed_at = placed_at + ${by}, accepted_at = accepted_at + ${by}, ready_at = ready_at + ${by}, completed_at = completed_at + ${by},
           estimated_ready_at = estimated_ready_at + ${by}, tracked_at = tracked_at + ${by}, business_day = $4::date, number = $5 WHERE id = $3`,
        [...shift, row.orderId, day, number],
      );
      // The diner wrote it 40 minutes to 3 hours after picking up; replies came within the day.
      const after = `make_interval(mins => ${40 + ((position * 23) % 140)})`;
      const reviewShift = `(($2::timestamptz - $1::timestamptz) + ${after})`;
      await db.query(
        `UPDATE reviews SET created_at = created_at + ${reviewShift}, editable_until = editable_until + ${reviewShift}, published_at = published_at + ${reviewShift},
           replied_at = replied_at + ${reviewShift} + interval '3 hours', reply_updated_at = reply_updated_at + ${reviewShift} + interval '3 hours',
           follow_up_updated_at = follow_up_updated_at + ${reviewShift} + interval '5 hours', moderated_at = moderated_at + ${reviewShift} + interval '6 hours',
           alerted_at = alerted_at + ${reviewShift} WHERE id = $3`,
        [...shift, row.reviewId],
      );
      await db.query(
        `UPDATE review_events SET created_at = created_at + ${reviewShift} + CASE kind WHEN 'CREATED' THEN interval '0' WHEN 'EDITED' THEN interval '0' WHEN 'REPLIED' THEN interval '3 hours' WHEN 'FOLLOW_UP' THEN interval '5 hours' ELSE interval '6 hours' END WHERE review_id = $3`,
        [...shift, row.reviewId],
      );
      await db.query(`UPDATE review_dish_ratings SET created_at = created_at + ${reviewShift} WHERE review_id = $3`, [...shift, row.reviewId]);
      await db.query('COMMIT');
    }
    // The unverified feedback, a few days back too.
    await db.query(
      `UPDATE reviews SET created_at = created_at - interval '3 days', editable_until = editable_until - interval '3 days', published_at = published_at - interval '3 days'
       WHERE verified = false AND created_at > now() - interval '1 hour' AND restaurant_id = (SELECT id FROM restaurants WHERE subdomain = $1)`,
      [SUBDOMAIN],
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    console.log(`Reviews left dated today: ${error.message}`);
  } finally {
    await db.end();
  }
}

const restaurant = (await api('GET', '/restaurants/mine')).data;
console.log(`\nDemo menu: ${restaurant.publicUrl}${nasr ? `\nNasr City branch: ${restaurant.publicUrl}/?b=nasr-city` : ''}\nOwner login: ${EMAIL} / ${PASSWORD}\nKitchen login: ${KITCHEN_EMAIL} / ${KITCHEN_PASSWORD}\nCashier login: ${CASHIER_EMAIL} / ${CASHIER_PASSWORD}`);
