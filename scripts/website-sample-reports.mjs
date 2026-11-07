// Sample reports for the public website (/features/reports): the real report template filled with
// illustrative figures. No restaurant records are read or changed.
// Usage: npm run build && node scripts/website-sample-reports.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { csvReport, reportHtml } from '../dist/modules/reports/report-template.js';
import { reportPdfFooter } from '../dist/modules/reports/report-brand.js';

const out = '../bilhanah-client-FE/public/samples';
await mkdir(out, { recursive: true });

// A deterministic generator, so the samples only change when this script does.
let seed = 7;
const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

const dishes = [
  ['برجر البيت', 'House burger', 'الأطباق الرئيسية', 'Mains', 185, 9],
  ['فراخ مشوية', 'Grilled chicken', 'الأطباق الرئيسية', 'Mains', 210, 7],
  ['باستا بيستو', 'Pesto pasta', 'باستا', 'Pasta', 155, 6],
  ['باستا ألفريدو', 'Alfredo pasta', 'باستا', 'Pasta', 165, 5],
  ['سلطة الحديقة', 'Garden salad', 'خفيف', 'Light', 95, 4],
  ['شوربة عدس', 'Lentil soup', 'خفيف', 'Light', 70, 3],
  ['بطاطس بالجبنة', 'Cheese fries', 'إضافات', 'Sides', 60, 8],
  ['لاتيه', 'Latte', 'مشروبات', 'Drinks', 75, 10],
  ['ليمون نعناع', 'Mint lemonade', 'مشروبات', 'Drinks', 55, 8],
  ['موكا', 'Mocha', 'مشروبات', 'Drinks', 85, 5],
  ['تشيز كيك', 'Cheesecake', 'حلويات', 'Desserts', 110, 4],
  ['براوني', 'Brownie', 'حلويات', 'Desserts', 90, 3],
];
const base = { cancelled: 0, completed: 0, pending: 0, refundedOrders: 0, refunds: 0, products: 1, contribution: 0, average: 0 };
const rows = dishes.map(([name, nameEn, category, categoryEn, price, weight], index) => {
  const units = Math.round(weight * 31 * (0.85 + random() * 0.3));
  const gross = units * price * 100;
  return { ...base, id: `d${index}`, name, nameEn, category, categoryEn, units, orders: Math.round(units * 0.82), gross, net: gross };
}).sort((a, b) => b.net - a.net);
const gross = rows.reduce((sum, row) => sum + row.gross, 0);
const discounts = Math.round(gross * 0.021 / 100) * 100;
const refunds = 64000;
const net = gross - discounts - refunds;
rows.forEach(row => { row.contribution = row.net / gross * 100; });
const orders = 1486;

// October 2026: weekends (Thursday to Saturday) are busier.
const weights = Array.from({ length: 31 }, (_, i) => { const day = new Date(Date.UTC(2026, 9, i + 1)).getUTCDay(); return ([4, 5, 6].includes(day) ? 1.35 : 0.9) * (0.88 + random() * 0.24); });
const total = weights.reduce((sum, value) => sum + value, 0);
const days = weights.map((weight, i) => {
  const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
  return { ...base, id: date, name: date, nameEn: null, category: null, categoryEn: null, units: 0, date, net: Math.round(net * weight / total), gross: Math.round(gross * weight / total), orders: Math.round(orders * weight / total) };
});
const branch = (id, name, nameEn, share) => ({ ...base, id, name, nameEn, category: null, categoryEn: null, units: 0, orders: Math.round(orders * share), gross: Math.round(gross * share), net: Math.round(net * share), contribution: share * 100 });

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const language of ['ar', 'en']) {
    const data = {
      restaurant: { name: language === 'ar' ? 'مطعم بالهنا - تقرير نموذجي ببيانات توضيحية' : 'Bilhanah Restaurant - sample report with illustrative data', timezone: 'Africa/Cairo', currency: 'EGP', logoUrl: null },
      branch: null, generatedAt: '2026-11-01T08:00:00.000Z',
      filters: { from: '2026-10-01', to: '2026-10-31', type: 'overview', language, page: 1, pageSize: 20, sort: 'net', direction: 'desc' },
      summary: { gross, net, orders, completed: orders - 31, cancelled: 23, pending: 8, refundedOrders: 4, refunds, discounts, average: Math.round(net / orders) },
      days, branches: [branch('main', 'وسط البلد', 'Downtown', 0.58), branch('nasr', 'مدينة نصر', 'Nasr City', 0.42)],
      categories: [], payments: [], topProducts: rows.slice(0, 5), rows, total: rows.length,
      options: { branches: [], categories: [], products: [] },
      capabilities: { discounts: true, refunds: 'RECORDED_CASH_REVERSALS', currency: 'EGP' },
    };
    await writeFile(`${out}/bilhanah-sample-report-${language}.csv`, csvReport(data));
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(reportHtml(data), { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    await page.pdf({ path: `${out}/bilhanah-sample-report-${language}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: reportPdfFooter(language === 'ar' ? 'نموذج توضيحي' : 'Illustrative sample') });
    await page.close();
    console.log(`Wrote ${out}/bilhanah-sample-report-${language}.{pdf,csv}`);
  }
} finally { await browser.close(); }
