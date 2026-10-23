#!/usr/bin/env node
// Fills a local stack (npm run dev) with a demo restaurant and menu, through the real API.
//
//   npm run seed:demo            # creates it if missing
//   npm run seed:demo -- --reset # replaces the demo menu
//
// Owner: demo-owner@bilhanah.local / demo-password-1 · Restaurant: koshary-demo
// Development only: confirms the account through Mailpit.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '') + '/v1';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const ORIGIN = process.env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5174';
const EMAIL = 'demo-owner@bilhanah.local';
const PASSWORD = 'demo-password-1';
const SUBDOMAIN = 'koshary-demo';
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

const restaurant = (await api('GET', '/restaurants/mine')).data;
console.log(`\nDemo menu: ${restaurant.publicUrl}\nOwner login: ${EMAIL} / ${PASSWORD}`);
