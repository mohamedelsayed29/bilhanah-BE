import { REPORT_BRAND as brand } from './report-brand.js';

export const reportStyles = `
  :root{--coral:${brand.coral};--mango:${brand.mango};--deep:${brand.aubergine};--cream:${brand.cream};--paper:${brand.paper};--muted:${brand.muted};--line:${brand.border}}
  *{box-sizing:border-box}
  body{margin:0;color:var(--deep);background:white;font:12px Brand,Arial,sans-serif;line-height:1.7}
  .report-content{position:relative;z-index:1;margin-inline-end:15mm}
  .page-wave{position:fixed;inset-inline-end:0;top:0;width:11mm;height:250mm;z-index:0;pointer-events:none}
  .page-wave>img{width:100%;height:100%;display:block}
  html[dir=rtl] .page-wave>img,html[dir=rtl] .hero-decor>svg{transform:scaleX(-1)}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:0 0 12px;margin-bottom:18px;gap:14px}
  header img{width:130px;height:48px;object-fit:contain}
  .restaurant-logo{width:46px!important;height:46px!important;border-radius:12px}
  .eyebrow{font-size:9px;letter-spacing:1.2px;color:#C42E44;margin:0}
  .report-hero{position:relative;overflow:hidden;background:var(--cream);border-radius:22px;padding:22px 24px;margin:0 0 16px;break-inside:avoid}
  .hero-copy{position:relative;z-index:1;padding-inline-end:44px}
  .hero-decor{position:absolute;inset-inline-end:0;inset-block:0;width:64px;pointer-events:none}
  .hero-decor>svg{width:100%;height:100%}
  h1{font:700 27px/1.45 BrandHeading,Brand,Arial,sans-serif;margin:8px 0;color:var(--deep)}
  h2{break-after:avoid-page;font:700 16px/1.6 BrandHeading,Brand,Arial,sans-serif;color:var(--deep);margin:20px 0 10px}
  .restaurant{font-size:15px;overflow-wrap:anywhere;margin:0}
  .meta{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:14px 0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}
  .meta b{color:var(--deep)}
  .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:18px 0}
  .metric{border:1px solid var(--line);border-radius:13px;padding:13px 9px;break-inside:avoid;overflow-wrap:anywhere}
  .metric:first-child{color:var(--cream);background:var(--deep);border-color:var(--deep);box-shadow:inset 0 4px var(--mango)}
  .metric small{display:block;font-size:10px}
  .metric strong{font-size:17px;display:block;line-height:1.7;font-weight:600}
  .chart{padding:12px 16px;border:1px solid var(--line);border-radius:13px}
  .chart svg{width:100%;height:100px}
  .axis{display:flex;justify-content:space-between;font-size:9px;color:var(--muted);direction:ltr}
  .split{display:grid;grid-template-columns:1fr 1fr;gap:22px}
  .ranking{position:relative;display:flex;justify-content:space-between;gap:10px;padding:8px 0 12px;border-bottom:1px solid var(--line);font-size:11px}
  .ranking span{overflow-wrap:anywhere}
  .ranking strong{white-space:nowrap}
  .ranking div{position:absolute;bottom:0;height:3px;background:var(--coral);border-radius:4px}
  .split>section:first-child .ranking div{background:var(--mango)}
  .detail{margin-top:24px}
  table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:10px}
  thead{display:table-header-group}
  th{background:var(--deep);color:var(--cream);font-weight:400;padding:9px 5px;text-align:start;border-top:3px solid var(--coral)}
  td{padding:9px 5px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;vertical-align:top}
  th:first-child{width:24%}th:nth-child(2){width:15%}
  tbody tr:nth-child(even){background:var(--paper)}
  tr{break-inside:avoid}tfoot td{background:var(--cream)}
  .note{font-size:10px;color:var(--muted);border-inline-start:3px solid var(--coral);padding:10px 12px;margin:18px 0;background:var(--cream)}
  .break-safe{break-inside:avoid}
  .submetrics{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:10px;color:var(--muted)}
  .submetrics b{color:var(--deep)}
  footer{border-top:1px solid var(--line);margin-top:24px;padding-top:12px;font-size:10px;color:var(--muted)}
  @media screen{body{max-width:850px;padding:36px;margin:auto;box-shadow:0 8px 50px #35172f12}.report-content{margin-inline-end:16px}.page-wave{inset-inline-end:0;top:0;width:24px;height:100vh}}
  @page{size:A4;margin:18mm 10mm 22mm}
`;
