// Illustrative design specimens only. No restaurant records are created or changed.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { reportHtml } from '../dist/modules/reports/report-template.js';
import { reportPdfFooter } from '../dist/modules/reports/report-brand.js';

const browser=await chromium.launch({channel:'chrome'});
await mkdir('output/pdf',{recursive:true});
await mkdir('test-results/reports',{recursive:true});
const base={units:0,orders:0,gross:0,net:0,refunds:0,cancelled:0,completed:0,pending:0,refundedOrders:0,products:1,contribution:0,average:0,category:'الأطباق الرئيسية',categoryEn:'Main dishes',nameEn:null};
const rows=Array.from({length:55},(_,i)=>({...base,id:String(i),name:i%6===0?'طبق بالهنا الخاص مع الأرز والخضار الطازجة وصوص الطماطم المنزلي':'كشري بالهنا - حجم '+(i+1),nameEn:i%6===0?'Bilhanah signature rice with fresh vegetables and homemade tomato sauce':'Koshary - size '+(i+1),orders:i+1,units:(i+1)*2,gross:(i+1)*7000,net:(i+1)*7000,contribution:0}));
const net=rows.reduce((s,r)=>s+r.net,0),orders=rows.reduce((s,r)=>s+r.orders,0);
rows.forEach(r=>r.contribution=r.net/net*100);
const days=Array.from({length:6},(_,i)=>({...base,id:`2026-11-0${i+1}`,name:`2026-11-0${i+1}`,date:`2026-11-0${i+1}`,net:net/6,gross:net/6,orders:orders/6}));
try{for(const language of ['ar','en']){
  const data={restaurant:{name:language==='ar'?'مطعم بالهنا - نموذج تصميم ببيانات توضيحية':'Bilhanah Restaurant - Illustrative design sample',timezone:'Africa/Cairo',currency:'EGP',logoUrl:null},branch:null,generatedAt:new Date().toISOString(),
    filters:{from:'2026-11-01',to:'2026-11-06',type:'products',language,page:1,pageSize:20,sort:'net',direction:'desc'},
    summary:{gross:net,net,orders,completed:orders-20,cancelled:0,pending:20,refundedOrders:0,refunds:0,discounts:0,average:Math.round(net/orders)},days,
    branches:[{...base,id:'main',name:'وسط البلد',nameEn:'Downtown',net:net*.6,contribution:60},{...base,id:'second',name:'مدينة نصر',nameEn:'Nasr City',net:net*.4,contribution:40}],categories:[],payments:[],topProducts:[...rows].reverse().slice(0,6),rows,total:rows.length,options:{branches:[],categories:[],products:[]},capabilities:{discounts:false,refunds:'RECORDED_CASH_REVERSALS',currency:'EGP'}};
  const html=reportHtml(data);
  await writeFile(`test-results/reports/sample-${language}.html`,html);
  const page=await browser.newPage();await page.setContent(html);await page.evaluate('document.fonts.ready');
  await page.pdf({path:`output/pdf/bilhanah-report-${language}.pdf`,format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:reportPdfFooter('Illustrative sample')});
  await page.close();
  console.log(`Generated output/pdf/bilhanah-report-${language}.pdf`);
}}finally{await browser.close();}
