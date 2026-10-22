import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const review = fileURLToPath(new URL('../test-results/review/stand-3d/', import.meta.url));

test('the textured stand rotates through 360 degrees, zooms, resets and follows the selected design', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/shop');
  await page.getByRole('button', { name: 'عرض 3D · 360°', exact: true }).click();
  const viewer = page.locator('.stand-3d-viewer'), scene = page.locator('.stand-3d-canvas'), canvas = scene.locator('canvas');
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await canvas.scrollIntoViewIfNeeded();
  const initialYaw = Number(await scene.getAttribute('data-yaw'));
  const initialDistance = Number(await scene.getAttribute('data-distance'));
  for (let turn = 1; turn <= 8; turn++) {
    await page.getByRole('button', { name: 'لف الحامل لليمين', exact: true }).click();
    await expect.poll(async () => Number(await scene.getAttribute('data-yaw'))).toBe((initialYaw + turn * 45) % 360);
  }
  await page.getByRole('button', { name: 'تقريب المجسّم', exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-distance'))).toBeLessThan(initialDistance);
  await page.getByRole('button', { name: 'إبعاد المجسّم', exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-distance'))).toBeCloseTo(initialDistance, 2);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .55, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Number(await scene.getAttribute('data-yaw'))).not.toBe(initialYaw);
  await canvas.press('Home');
  await expect.poll(async () => Number(await scene.getAttribute('data-yaw'))).toBe(initialYaw);
  await canvas.press('ArrowRight');
  await expect.poll(async () => Number(await scene.getAttribute('data-yaw'))).toBe((initialYaw + 15) % 360);
  await page.getByRole('button', { name: 'إعادة زاوية البداية', exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-yaw'))).toBe(initialYaw);
  const before = await canvas.screenshot();
  const revision = Number(await scene.getAttribute('data-artwork'));
  await page.getByRole('radio', { name: 'أخضر عميق', exact: true }).check();
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('بيت الزيتون');
  await expect.poll(async () => Number(await scene.getAttribute('data-artwork'))).toBeGreaterThan(revision);
  await expect(page.getByRole('button', { name: 'عرض 3D · 360°', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await canvas.scrollIntoViewIfNeeded();
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await mkdir(review, { recursive: true });
  await page.screenshot({ path: `${review}/desktop-ar.png` });
  await page.getByRole('radio', { name: 'قوس', exact: true }).check();
  await expect(scene).toHaveAttribute('data-shape', 'arch');
  await canvas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${review}/arch-ar.png` });
  expect((await new AxeBuilder({ page }).include('.stand-gallery').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await canvas.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'إعادة زاوية البداية', exact: true })).toBeInViewport();
    await page.screenshot({ path: `${review}/mobile-ar-${width}.png` });
  }
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute('aria-label', /3D stand/);
  await page.screenshot({ path: `${review}/mobile-en-320.png` });
  await page.getByRole('button', { name: 'Product view', exact: true }).click();
  await expect(canvas).toHaveCount(0);
  await page.getByRole('button', { name: '3D view · 360°', exact: true }).click();
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await expect(canvas).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a browser without WebGL gets a product photo, retry and a usable configurator', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof original>) {
      if (String(args[0]).startsWith('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.goto('/shop');
  await page.getByRole('button', { name: 'عرض 3D · 360°', exact: true }).click();
  await expect(page.locator('.stand-3d-viewer')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('.stand-3d-fallback img')).toBeVisible();
  await page.getByRole('button', { name: 'جرّب 3D تاني', exact: true }).click();
  await expect(page.locator('.stand-3d-viewer')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('.stand-3d-canvas canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'شكل الحامل', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم البراند', exact: true }).fill('اختبار الحامل');
  await page.getByRole('button', { name: 'أضف تصميمك للسلة', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('اتضاف للسلة');
});
