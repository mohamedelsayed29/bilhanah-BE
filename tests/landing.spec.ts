import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const review = fileURLToPath(new URL('../../../.impeccable/review/', import.meta.url));

test('Arabic and English render at desktop and mobile sizes without overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mkdir(review, { recursive: true });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  for (const language of ['ar', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow, `${language} at ${width}px`).toBe(false);
      const heroBounds = await page.locator('.hero').evaluate(element => {
        const title = element.querySelector('h1')!.getBoundingClientRect();
        const actions = element.querySelector('.hero-actions')!.getBoundingClientRect();
        const chapters = element.querySelector('.hero-chapters')!.getBoundingClientRect();
        return { titleBottom: title.bottom, actionsBottom: actions.bottom, chaptersTop: chapters.top, stageBottom: element.getBoundingClientRect().bottom };
      });
      expect(heroBounds.actionsBottom, `${language} hero actions fit at ${width}px`).toBeLessThan(heroBounds.chaptersTop);
      expect(heroBounds.chaptersTop, `${language} chapters visible at ${width}px`).toBeLessThan(heroBounds.stageBottom);
      if ([1440, 390].includes(width)) {
        await page.locator('footer').scrollIntoViewIfNeeded();
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: `${review}/${width === 1440 ? 'desktop' : 'mobile'}-${language}.png`, fullPage: true });
      }
    }
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});

test('sample menu supports categories, sizes, quantities, and an explicitly simulated checkout', async ({ page }) => {
  await page.goto('/?demo=1');
  const dialog = page.getByRole('dialog', { name: 'منيو بالهنا التجريبي' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'رئيسي', exact: true }).click();
  await expect(dialog.locator('.demo-dish')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'كبير', exact: true }).click();
  await dialog.getByRole('button', { name: 'أضف برجر البيت', exact: true }).click();
  await dialog.getByRole('button', { name: /السلة/ }).click();
  await expect(dialog.locator('.cart-total')).toContainText('٢٢٥');
  await dialog.getByRole('button', { name: 'زيادة برجر البيت', exact: true }).click();
  await expect(dialog.locator('.cart-total')).toContainText('٤٥٠');
  await dialog.getByRole('button', { name: 'تقليل برجر البيت', exact: true }).click();
  await expect(dialog.locator('.cart-total')).toContainText('٢٢٥');
  await dialog.getByRole('button', { name: 'جرّب تأكيد الطلب', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('مفيش طلب اتبعت لمطعم');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('pricing shows approved prices and trial selection explains registration availability', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('.price-card');
  await expect(cards).toHaveCount(3);
  for (const [index, price] of ['٢٠٠', '٣٥٠', '٥٠٠'].entries()) await expect(cards.nth(index).locator('.plan-price')).toContainText(price);
  await cards.nth(1).getByRole('button', { name: 'ابدأ تجربتك', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'تجربتك مع بالهنا' });
  await expect(dialog.locator('.trial-plan')).toContainText('منيو وطلبات');
  await expect(dialog.getByRole('status')).toContainText('إنشاء الحسابات هيتاح قريبًا');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByText('محتاج أبلكيشن عشان زبوني يشوف المنيو؟', { exact: true }).click();
  await expect(page.locator('details').first()).toHaveAttribute('open', '');
});

test('mobile navigation, background video, and reduced motion respect user controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('video source')).toHaveAttribute('src', '/media/hero-live-v1.mp4');
  await expect(page.getByRole('button', { name: 'تشغيل فيديو الخلفية', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name: 'الباقات والأسعار' }).click();
  await expect(page.getByRole('button', { name: 'فتح القائمة', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole('button', { name: 'تشغيل فيديو الخلفية', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime > 0.1)).toBe(true);
  await page.getByRole('button', { name: 'إيقاف فيديو الخلفية', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.locator('.chapter').nth(2).click();
  await expect(page.locator('.chapter').nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 9.13) < 0.1)).toBe(true);
  await page.locator('.chapter').nth(1).click();
  await expect(page.locator('.chapter').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 3.45) < 0.1)).toBe(true);
});

test('landing and sample-menu dialog meet automated WCAG AA checks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const landing = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(landing.violations).toEqual([]);
  await page.getByRole('button', { name: 'شوف منيو حقيقي', exact: true }).click();
  const sample = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(sample.violations).toEqual([]);
});
