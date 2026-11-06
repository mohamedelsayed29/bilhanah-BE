#!/usr/bin/env node
// Fills a local stack (npm run dev) with a demo restaurant and menu, through the real API.
//
//   npm run seed:demo            # creates it if missing
//   npm run seed:demo -- --reset # replaces the demo menu
//
// Owner: demo-owner@bilhanah.local / demo-password-1 · Restaurant: koshary-demo
// Kitchen screen: demo-kitchen@bilhanah.local / demo-kitchen-1
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

const restaurant = (await api('GET', '/restaurants/mine')).data;
console.log(`\nDemo menu: ${restaurant.publicUrl}${nasr ? `\nNasr City branch: ${restaurant.publicUrl}/?b=nasr-city` : ''}\nOwner login: ${EMAIL} / ${PASSWORD}\nKitchen login: ${KITCHEN_EMAIL} / ${KITCHEN_PASSWORD}\nCashier login: ${CASHIER_EMAIL} / ${CASHIER_PASSWORD}`);
