import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReportData } from '@bilhanah/contracts';
import { REPORT_BRAND as brand, reportHeroShapes } from './report-brand.js';
import { reportStyles } from './report-style.js';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function reportTable(data: ReportData) {
  const ar = data.filters.language === 'ar';
  const t = (a:string,e:string) => ar?a:e;
  const headings = [t('البيان','Name'),t('القسم','Category'),t('الطلبات','Orders'),t('الوحدات','Units'),t('إجمالي المبيعات','Gross sales'),t('صافي المبيعات','Net sales'),t('المسترجع المسجّل','Recorded refunds'),t('المساهمة %','Contribution %')];
  const rows = data.rows.map(r=>[ar?r.name:r.nameEn||r.name,ar?r.category:r.categoryEn||r.category,r.orders,r.units,(r.gross/100).toFixed(2),(r.net/100).toFixed(2),(r.refunds/100).toFixed(2),r.contribution.toFixed(2)]);
  if(data.filters.type==='orders') {
    headings.push(t('الحالة','Status'),t('الدفع','Payment'));
    rows.forEach((row,index)=>row.push(data.rows[index]!.status??'',data.rows[index]!.paymentMethod??''));
  }
  if(data.filters.type==='branches') {headings.push(t('متوسط الطلب','Average order'));rows.forEach((row,i)=>row.push((data.rows[i]!.average/100).toFixed(2)));}
  if(data.filters.type==='categories') {headings.push(t('عدد الأصناف','Products count'));rows.forEach((row,i)=>row.push(data.rows[i]!.products));}
  return {headings,rows};
}
export function csvReport(data: ReportData): string {
  const table = reportTable(data);
  // Excel formula injection includes leading whitespace and control characters.
  const cell = (v:unknown) => { let s=String(v??''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; };
  const metaHeadings=['Restaurant','Currency','From','To','Branch scope','Report type','Timezone','Generated at','Category filter','Product filter','Status filter','Payment filter'];
  const meta=[data.restaurant.name,data.restaurant.currency,data.filters.from,data.filters.to,data.branch??'All branches',data.filters.type,data.restaurant.timezone,data.generatedAt,data.filters.categoryId??'',data.filters.productId??'',data.filters.status??'',data.filters.paymentMethod??''];
  // A single rectangular table: standard spreadsheet/CSV readers can use the first row as headers.
  return '\uFEFF'+[[...metaHeadings,...table.headings],...table.rows.map(row=>[...meta,...row])].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function reportHtml(data: ReportData, restaurantLogo: string | null = null): string {
  const ar=data.filters.language==='ar', t=(a:string,e:string)=>ar?a:e, h=escapeHtml;
  const font=(name:string)=>readFileSync(resolve('assets/reports',name)).toString('base64');
  const logo=font('logo.svg'), table=reportTable(data);
  const money=(v:number)=>new Intl.NumberFormat(ar?'ar-EG':'en-EG',{style:'currency',currency:data.restaurant.currency,maximumFractionDigits:2}).format(v/100);
  const title: Record<string,string> = {overview:t('تقرير أداء المطعم','Restaurant performance'),sales:t('تقرير المبيعات','Sales report'),orders:t('تقرير الطلبات','Orders report'),products:t('أداء الأصناف','Product performance'),categories:t('أداء الأقسام','Category performance'),branches:t('أداء الفروع','Branch performance'),payments:t('المدفوعات والاسترجاع','Payments & recorded refunds')};
  const filters = [data.branch??t('كل الفروع','All branches'), data.filters.categoryId ? data.options.categories.find(c=>c.id===data.filters.categoryId)?.name : null, data.filters.productId ? data.options.products.find(p=>p.id===data.filters.productId)?.name : null,data.filters.status,data.filters.paymentMethod].filter(Boolean).join(' · ');
  const max=Math.max(1,...data.days.map(d=>d.net));
  const chart=data.days.map((d,i)=>{const w=620/data.days.length;const height=d.net/max*100;return `<rect x="${i*w}" y="${110-height}" width="${Math.max(.5,w-2)}" height="${height}" rx="3" fill="${i===data.days.length-1?brand.aubergine:brand.coral}"><title>${h(d.date)}: ${h(money(d.net))}</title></rect>`;}).join('');
  const cards=[[t('صافي المبيعات','Net sales'),money(data.summary.net)],[t('إجمالي المبيعات','Gross sales'),money(data.summary.gross)],[t('إجمالي الطلبات','Total orders'),data.summary.orders],[t('متوسط الطلب','Average order'),money(data.summary.average)]];
  const mini=(name:string,rows:ReportData['branches'])=>`<section class="break-safe"><h2>${name}</h2>${rows.slice(0,3).map(r=>`<div class="ranking"><span>${h(ar?r.name:r.nameEn||r.name)}</span><strong>${h(money(r.net))}</strong><div style="width:${Math.max(1,Math.min(100,r.net/Math.max(1,data.summary.net)*100))}%"></div></div>`).join('')||`<p>${t('لا توجد بيانات','No data')}</p>`}</section>`;
  return `<!doctype html><html lang="${ar?'ar':'en'}" dir="${ar?'rtl':'ltr'}"><head><meta charset="utf-8"><title>${h(title[data.filters.type])}</title><style>
  @font-face{font-family:Brand;src:url(data:font/woff2;base64,${font('arabic.woff2')}) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF}
  @font-face{font-family:Brand;src:url(data:font/woff2;base64,${font('latin.woff2')}) format('woff2')}
  @font-face{font-family:BrandHeading;src:url(data:font/woff2;base64,${font('heading.woff2')}) format('woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+0100-024F}
  ${reportStyles}
  </style></head><body><div class="page-wave" aria-hidden="true"><img alt="" src="data:image/svg+xml;base64,${Buffer.from(reportHeroShapes()).toString('base64')}"></div><main class="report-content"><header><img alt="Bilhanah" src="data:image/svg+xml;base64,${logo}"><span class="eyebrow">${t('تقارير بالهنا للأعمال','BILHANAH BUSINESS REPORTS')}</span>${restaurantLogo?`<img class="restaurant-logo" alt="" src="${h(restaurantLogo)}">`:''}</header>
  <section class="report-hero"><div class="hero-decor" aria-hidden="true">${reportHeroShapes()}</div><div class="hero-copy"><p class="eyebrow">${t('الأرقام التي تساعدك على اتخاذ القرار','A CLEARER VIEW OF YOUR BUSINESS')}</p><h1>${title[data.filters.type]}</h1><p class="restaurant">${h(data.restaurant.name)}</p></div></section>
  <div class="meta"><b dir="ltr">${h(data.filters.from)} - ${h(data.filters.to)}</b> · ${h(data.restaurant.timezone)}<br>${h(filters)}<br>${t('تاريخ الإصدار','Generated')}: ${h(new Intl.DateTimeFormat(ar?'ar-EG':'en-GB',{timeZone:data.restaurant.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(data.generatedAt)))}</div>
  <div class="cards">${cards.map(([label,value])=>`<div class="metric"><small>${label}</small><strong>${h(value)}</strong></div>`).join('')}</div>
  <div class="submetrics">${[[t('مكتمل','Completed'),data.summary.completed],[t('ملغي / مرفوض','Cancelled / rejected'),data.summary.cancelled],[t('قيد التنفيذ','Pending'),data.summary.pending],[t('استرجاع مسجل','Recorded refunds'),money(data.summary.refunds)],[t('خصومات','Discounts'),money(0)]].map(([k,v])=>`<span>${k}: <b>${h(v)}</b></span>`).join('')}</div>
  <section class="break-safe"><h2>${t('صافي المبيعات عبر الفترة','Net sales over time')}</h2><div class="chart"><svg viewBox="0 0 620 115" role="img" aria-label="Net sales">${chart}</svg><div class="axis"><span>${h(data.filters.from)}</span><span>${h(data.filters.to)}</span></div></div></section>
  <div class="split">${mini(t('أداء الفروع','Branch performance'),data.branches)}${mini(t('الأصناف الأكثر مبيعًا','Top products'),data.topProducts)}</div>
  <section class="detail"><h2>${t('البيانات التفصيلية','Detailed report')} · ${data.total} ${t('سجل','rows')} · ${h(data.restaurant.currency)}</h2><table><thead><tr>${table.headings.map(v=>`<th>${h(v)}</th>`).join('')}</tr></thead><tbody>${table.rows.length?table.rows.map(row=>`<tr>${row.map(v=>`<td>${h(v)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="8">${t('لا توجد بيانات للفلاتر المختارة.','No data for the selected filters.')}</td></tr>`}</tbody></table></section>
  <p class="note">${t('المبيعات تستبعد الطلبات المرفوضة والملغية والأصناف الملغية. الصافي يخصم عكس المدفوعات النقدية المسجل فقط، بحد قيمة الطلب؛ الاسترجاع للطلب الملغي لا يخصم مرة ثانية. لا يوجد سجل خصومات أو استرجاع بطاقات في النظام الحالي. التصنيف حسب أقسام المنيو الحالية، والأسعار والأسماء من الطلب وقت إنشائه.','Sales exclude rejected/cancelled orders and cancelled dishes. Net deducts recorded cash payment reversals only, capped at the order value; cancelled orders are not deducted twice. Discounts and card refunds are not tracked by the current system. Categories use the current menu; names and prices use order snapshots.')}</p>
  <footer>${t('صُنع لاتخاذ قرارات أفضل، مع بالهنا.','Made for better decisions. With Bilhanah.')} · ${h(data.restaurant.currency)} · ${h(data.generatedAt.slice(0,10))}</footer></main></body></html>`;
}
