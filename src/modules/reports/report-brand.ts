/** Current Bilhanah UI identity. Paths are the official marketing Hero.tsx shapes. */
export const REPORT_BRAND = {
  coral: '#F45164', mango: '#FFC857', aubergine: '#35172F', cream: '#FFF3E7',
  paper: '#FFF9F3', muted: '#76646F', border: '#EADDD5', softCoral: '#FEE6E4',
} as const;

export function reportHeroShapes(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 800" preserveAspectRatio="none" aria-hidden="true">
    <svg x="0" y="15" width="200" height="230" viewBox="0 0 200 230"><path d="M200 0V230C168 222 150 190 128 158C104 124 62 128 30 100C2 76 2 34 40 14C78 -6 140 6 200 0Z" fill="${REPORT_BRAND.mango}"/></svg>
    <svg x="60" y="275" width="140" height="220" viewBox="0 0 140 270"><path d="M140 0V270C86 266 30 236 10 176C-12 108 32 22 140 0Z" fill="${REPORT_BRAND.aubergine}"/></svg>
    <svg x="20" y="490" width="180" height="310" viewBox="0 0 180 330"><path d="M180 0V330H42C14 292 -8 236 14 180C34 128 18 88 52 46C84 8 136 0 180 0Z" fill="${REPORT_BRAND.coral}"/></svg>
  </svg>`;
}

export function reportPdfFooter(date: string): string {
  return `<div style="font-size:9px;color:${REPORT_BRAND.muted};width:100%;padding:0 60px;display:flex;justify-content:space-between"><span>Bilhanah · ${date}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}
