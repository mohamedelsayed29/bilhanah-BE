import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const review = fileURLToPath(new URL('../test-results/review/stand-shop/', import.meta.url));
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('two custom designs can be edited, priced, checked out and exported without submitting an order', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  await page.goto('/shop');
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('بيت الزيتون');
  await page.getByRole('button', { name: 'اختار لون مخصص', exact: true }).click();
  await page.getByRole('textbox', { name: 'لون الخلفية — HEX', exact: true }).fill('#1C4D8D');
  await page.getByRole('textbox', { name: 'لون النص — HEX', exact: true }).fill('#FFE6A7');
  await page.getByRole('button', { name: 'تطبيق الألوان', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'عدد الحوامل', exact: true }).fill('3');
  await expect(page.locator('.shop-purchase-panel')).toContainText('١٬٠٥٠');
  await page.getByRole('button', { name: 'أضف تصميمك للسلة', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('اتضاف للسلة');
  await page.getByRole('radio', { name: 'قوس', exact: true }).check();
  await page.getByRole('radio', { name: /QR \+ شريحة NFC/ }).check();
  await page.getByRole('radio', { name: /تقييمات Google/ }).check();
  await page.getByRole('textbox', { name: 'رابط تقييمات Google', exact: true }).fill('https://g.page/r/olive-house/review');
  await page.getByRole('radio', { name: 'أخضر عميق', exact: true }).check();
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('تقييم مطعمنا');
  await page.getByRole('checkbox', { name: /أضف ترقيم/ }).check();
  await page.getByRole('spinbutton', { name: 'ابدأ الترقيم من', exact: true }).fill('8');
  await page.getByRole('spinbutton', { name: 'عدد الحوامل', exact: true }).fill('2');
  await page.getByRole('button', { name: 'أضف تصميمك للسلة', exact: true }).click();
  await page.getByRole('button', { name: 'عرض السلة', exact: true }).click();
  await expect(page.locator('.shop-bag-line')).toHaveCount(2);
  await expect(page.locator('.shop-summary-total')).toContainText('١٬٩٥٠');
  await page.getByRole('spinbutton', { name: 'كمية بيت الزيتون', exact: true }).fill('2');
  await expect(page.locator('.shop-summary-total')).toContainText('١٬٦٠٠');
  await page.getByRole('button', { name: 'عدّل التصميم', exact: true }).first().click();
  await page.getByRole('textbox', { name: /العبارة على الحامل/ }).fill('بالهنا والشفا');
  await page.getByRole('button', { name: 'احفظ التعديل في السلة', exact: true }).click();
  await expect(page.locator('.shop-bag-line')).toHaveCount(2);
  await page.getByRole('button', { name: 'كمّل بيانات الطلب', exact: true }).click();
  await page.getByRole('textbox', { name: 'الاسم بالكامل', exact: true }).fill('عميل تجريبي');
  await page.getByRole('textbox', { name: 'رقم الموبايل', exact: true }).fill('01012345678');
  await page.getByRole('textbox', { name: 'المحافظة / المدينة', exact: true }).fill('القاهرة');
  await page.getByRole('textbox', { name: 'العنوان بالتفصيل', exact: true }).fill('عنوان تجريبي لاختبار الواجهة فقط');
  await page.getByRole('button', { name: 'ارجع للسلة', exact: true }).click();
  await page.getByRole('button', { name: 'كمّل بيانات الطلب', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'الاسم بالكامل', exact: true })).toHaveValue('عميل تجريبي');
  await page.getByRole('radio', { name: /دفع إلكتروني/ }).check();
  await page.getByRole('checkbox', { name: /راجعت الشكل/ }).check();
  await mkdir(review, { recursive: true });
  await page.screenshot({ path: `${review}/checkout-ar.png`, fullPage: true });
  expect((await new AxeBuilder({ page }).include('.stand-shop').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تصميمك جاهز. وطلبك مترتّب.', exact: true })).toBeVisible();
  await expect(page.locator('.shop-complete-summary')).toContainText('١٬٦٠٠');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'نزّل ملخص طلبك', exact: true }).click();
  const file = await download;
  const order = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(order).toMatchObject({ realOrderPlaced: false, paymentCollected: false, baseUnitPrice: 350, nfcSurcharge: 100, productTotal: 1600 });
  expect(order.items).toHaveLength(2);
  expect(order.items[0]).toMatchObject({ customColors: { background: '#1C4D8D', ink: '#FFE6A7' }, printColors: { background: '#1C4D8D', ink: '#FFE6A7' } });
  expect(order.items[1]).toMatchObject({ shape: 'arch', purpose: 'reviews', nfc: true, unitPrice: 450, lineTotal: 900, numbered: true, startNumber: 8, quantity: 2 });
  expect(writes).toEqual([]);
  const persisted = await page.evaluate(() => Object.values(localStorage).join(' '));
  expect(persisted).not.toContain('01012345678');
  await page.screenshot({ path: `${review}/complete-ar.png`, fullPage: true });
});

test('safe destination validation, logo upload, draft restore and QR export work in 3D mode', async ({ page }) => {
  await page.goto('/shop');
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('تصميم محفوظ');
  await page.getByRole('radio', { name: 'مائل', exact: true }).check();
  await page.getByRole('radio', { name: /تقييمات Google/ }).check();
  await page.getByRole('textbox', { name: 'رابط تقييمات Google', exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'أضف تصميمك للسلة', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('لينك خرائط Google');
  await page.getByRole('radio', { name: /رابط على مزاجك/ }).check();
  await page.getByRole('textbox', { name: 'الرابط اللي هيفتح', exact: true }).fill('javascript:alert(1)');
  await expect(page.getByRole('link', { name: 'جرّب اللينك', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'الرابط اللي هيفتح', exact: true }).fill('https://example.com/contact');
  await page.locator('input[type=file]').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toContainText('PNG');
  await page.locator('input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByRole('img', { name: 'لوجو البراند المرفوع', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'احفظ التصميم للجاي', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'اسم البراند', exact: true })).toHaveValue('تصميم محفوظ');
  await expect(page.getByRole('radio', { name: 'مائل', exact: true })).toBeChecked();
  await expect(page.getByRole('img', { name: 'لوجو البراند المرفوع', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'عرض 3D · 360°', exact: true }).click();
  await expect(page.locator('.stand-3d-viewer')).toHaveAttribute('data-state', 'ready', { timeout: 20000 });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'نزّل الـQR', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('bilhanah-stand-qr.svg');
});

test('shop layouts, 3D shapes and design previews fit mobile and desktop in both languages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir(review, { recursive: true });
  await page.goto('/shop');
  await page.evaluate(() => document.fonts.ready);
  for (const language of ['ar', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: `${language} fits at ${width}` }).toBe(true);
      if ([1440, 390].includes(width)) { await page.screenshot({ path: `${review}/design-${language}-${width}.png`, fullPage: true }); await page.screenshot({ path: `${review}/viewport-${language}-${width}.png` }); }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const shape of ['Classic', 'Arch', 'Tilt']) {
    await page.getByRole('radio', { name: shape, exact: true }).check();
    await page.getByRole('button', { name: '3D view · 360°', exact: true }).click();
    await expect(page.locator('.stand-3d-viewer')).toHaveAttribute('data-state', 'ready', { timeout: 20000 });
    await expect(page.locator('.stand-3d-canvas')).toHaveAttribute('data-shape', shape.toLowerCase());
  }
  await page.getByRole('button', { name: 'Product view', exact: true }).click();
  await page.getByRole('radio', { name: 'Deep green', exact: true }).check();
  await page.getByRole('textbox', { name: 'Brand name', exact: true }).fill('Olive House');
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({ path: `${review}/design-forest-en.png` });
  expect(errors).toEqual([]);
});

test('the product view opens first, shows each whole stand and preserves design customization', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.getByRole('button', { name: 'شكل الحامل', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Your live design|تصميمك مباشر/ })).toHaveCount(0);
  const photo = page.locator('.stand-product-photo');
  for (const [shape, filename] of [['كلاسيك', 'nfc-acrylic-detail-v1.jpg'], ['قوس', 'nfc-arch-v1.jpg'], ['مائل', 'nfc-tilt-v1.jpg']]) {
    await page.getByRole('radio', { name: shape, exact: true }).check();
    await expect(photo).toHaveAttribute('src', `/media/${filename}`);
    await expect.poll(() => photo.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('تصميم العميل');
  await expect(page.getByRole('button', { name: 'شكل الحامل', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'عرض 3D · 360°', exact: true }).click();
  await expect(page.locator('.stand-3d-viewer')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('textbox', { name: 'اسم البراند', exact: true })).toHaveValue('تصميم العميل');
  await page.getByRole('button', { name: 'شكل الحامل', exact: true }).click();
  await expect(photo).toHaveAttribute('src', '/media/nfc-tilt-v1.jpg');
  for (const language of ['ar', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await photo.scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const layout = await photo.evaluate(element => {
        const image = element.getBoundingClientRect(), stage = element.parentElement!.getBoundingClientRect();
        return { fits: image.width <= stage.width + 1 && image.height <= stage.height + 1, fit: getComputedStyle(element).objectFit };
      });
      expect(layout).toEqual({ fits: true, fit: 'contain' });
      await mkdir(review, { recursive: true });
      await page.screenshot({ path: `${review}/product-${language}-${width}.png` });
    }
  }
  expect((await new AxeBuilder({ page }).include('.stand-gallery').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('NFC is optional, adds 100 per stand, persists in drafts and can be removed when editing', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.getByRole('radio', { name: /QR فقط/ })).toBeChecked();
  await expect(page.locator('.shop-price-intro strong')).toContainText('٣٥٠');
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('حامل اختياري');
  await page.getByRole('radio', { name: /QR \+ شريحة NFC/ }).check();
  await expect(page.locator('.shop-price-intro strong')).toContainText('٤٥٠');
  await page.getByRole('spinbutton', { name: 'عدد الحوامل', exact: true }).fill('3');
  await expect(page.locator('.shop-purchase-panel .shop-summary-total')).toContainText('١٬٣٥٠');
  await page.getByRole('button', { name: 'احفظ التصميم للجاي', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: /QR \+ شريحة NFC/ })).toBeChecked();
  await expect(page.locator('.shop-purchase-panel .shop-summary-total')).toContainText('١٬٣٥٠');
  await page.getByRole('button', { name: 'أضف تصميمك للسلة', exact: true }).click();
  await page.getByRole('button', { name: 'عرض السلة', exact: true }).click();
  await expect(page.locator('.shop-tech-label')).toContainText('QR + NFC');
  await page.getByRole('button', { name: 'عدّل التصميم', exact: true }).click();
  await page.getByRole('radio', { name: /QR فقط/ }).check();
  await page.getByRole('button', { name: 'احفظ التعديل في السلة', exact: true }).click();
  await expect(page.locator('.shop-tech-label')).toContainText('بدون NFC');
  await expect(page.locator('.shop-summary-total')).toContainText('١٬٠٥٠');
});

test('refined product, personalization and bag layouts remain clear at desktop and phone sizes', async ({ page }) => {
  await page.goto('/shop');
  await mkdir(review, { recursive: true });
  for (const language of ['ar', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      if ([1440, 1280, 390, 320].includes(width)) await page.screenshot({ path: `${review}/refined-${language}-${width}.png`, fullPage: true });
      if ([1440, 1280, 390, 320].includes(width)) await page.screenshot({ path: `${review}/refined-viewport-${language}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await new AxeBuilder({ page }).include('.stand-shop').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});
