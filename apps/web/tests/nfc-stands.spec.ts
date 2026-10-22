import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const review = fileURLToPath(new URL('../test-results/review/nfc-stands/', import.meta.url));

test('NFC stand section displays both product views in Arabic and English across screen sizes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mkdir(review, { recursive: true });
  await page.goto('/#nfc-stands');
  await page.evaluate(() => document.fonts.ready);
  const section = page.locator('#nfc-stands');
  for (const language of ['ar', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator('.nfc-visual img')).toHaveCount(2);
      expect(await section.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${language} at ${width}`).toBe(true);
      const clipped = await section.locator('.nfc-copy, .nfc-table-photo figcaption').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth));
      expect(clipped, `${language} copy fits at ${width}`).toBe(false);
      if ([1440, 390].includes(width)) await section.screenshot({ path: `${review}/${language}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await section.scrollIntoViewIfNeeded();
  const result = await new AxeBuilder({ page }).include('#nfc-stands').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
});

test('stand inquiry preserves the product topic and leaves ordinary contact inquiries unchanged', async ({ page }) => {
  await page.goto('/#nfc-stands');
  await page.getByRole('link', { name: 'اسأل عن حامل مطعمك', exact: true }).click();
  await expect(page).toHaveURL(/\/contact\?topic=nfc$/);
  await expect(page.getByRole('combobox')).toHaveValue('nfc');
  await expect(page.getByRole('textbox', { name: 'رسالتك', exact: true })).toHaveValue(/QR وNFC/);
  await page.goto('/contact');
  await expect(page.getByRole('combobox')).toHaveValue('subscription');
  await expect(page.getByRole('textbox', { name: 'رسالتك', exact: true })).toBeEmpty();
});
