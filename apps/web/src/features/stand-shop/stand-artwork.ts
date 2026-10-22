import { printColors, purposes, safeUrl, type StandConfig } from './catalog';
import type { Language } from '../../lib/language';

function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
}

function lines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const result: string[] = [];
  let line = '';
  for (const character of Array.from(text)) {
    if (line && context.measureText(line + character).width > maxWidth) { result.push(line.trim()); line = ''; }
    line += character;
  }
  if (line.trim()) result.push(line.trim());
  return result;
}

function fittedText(context: CanvasRenderingContext2D, text: string, y: number, width: number, size: number, maxLines: number, weight = 650) {
  let wrapped: string[];
  do { context.font = `${weight} ${size}px 'Noto Sans Arabic Variable', 'Manrope Variable', sans-serif`; wrapped = lines(context, text, width); if (wrapped.length <= maxLines || size <= 20) break; size -= 2; } while (true);
  wrapped.forEach((line, index) => context.fillText(line, 384, y + index * size * 1.5));
}

/** Draws locally supplied print data; no screenshot service or remote image fetch is used. */
export async function createStandArtwork(config: StandConfig, language: Language, qrMarkup: string) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 1100;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  const design = printColors(config);
  const purpose = purposes.find(item => item.id === config.purpose)!;
  context.fillStyle = design.background; context.fillRect(0, 0, 768, 1100);
  context.fillStyle = design.ink; context.strokeStyle = design.ink;
  context.textAlign = 'center'; context.textBaseline = 'middle'; context.direction = language === 'ar' ? 'rtl' : 'ltr';
  if (config.design === 'forest') { context.lineWidth = 2; context.strokeRect(24, 25, 720, 1050); }
  if (config.design === 'signature') { context.fillStyle = design.accent; context.fillRect(314, 22, 140, 9); context.fillStyle = design.ink; }
  if (config.design === 'clay') { context.fillStyle = design.accent; context.beginPath(); context.arc(751, 13, 78, 0, Math.PI * 2); context.fill(); context.fillStyle = design.ink; }
  const logo = config.logo ? await imageFromUrl(config.logo).catch(() => null) : null;
  if (logo) {
    const scale = Math.min(190 / logo.width, 90 / logo.height);
    const width = logo.width * scale, height = logo.height * scale;
    context.drawImage(logo, 384 - width / 2, 150 - height / 2, width, height);
  }
  fittedText(context, config.brand.trim() || (language === 'ar' ? 'اسم مطعمك' : 'Your brand'), logo ? 248 : 235, 620, config.brand.length > 24 ? 36 : logo ? 44 : 53, 2, 750);
  if (config.purpose === 'reviews') {
    for (let star = 0; star < 5; star++) {
      const x = 304 + star * 40;
      context.beginPath();
      for (let point = 0; point < 10; point++) { const angle = -Math.PI / 2 + point * Math.PI / 5; const radius = point % 2 ? 7 : 16; const px = x + Math.cos(angle) * radius, py = 359 + Math.sin(angle) * radius; if (!point) context.moveTo(px, py); else context.lineTo(px, py); }
      context.closePath(); context.fill();
    }
  }
  fittedText(context, config.caption.trim() || purpose.caption[language], 405, 620, 30, 2);
  if (safeUrl(config.url) && qrMarkup) {
    const qr = await imageFromUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrMarkup)}`);
    context.drawImage(qr, 189, 476, 390, 390);
  } else {
    context.fillStyle = '#f4f5ee'; context.fillRect(189, 476, 390, 390); context.fillStyle = '#52634b';
    fittedText(context, language === 'ar' ? 'أضف الرابط للمعاينة' : 'Add a link to preview', 665, 345, 30, 2);
  }
  context.strokeStyle = design.ink; context.lineWidth = 8; context.lineCap = 'round';
  if (config.nfc) for (const radius of [17, 34, 51]) { context.beginPath(); context.arc(358, 923, radius, -.72, .72); context.stroke(); }
  context.fillStyle = design.ink;
  fittedText(context, config.nfc ? (language === 'ar' ? 'سكان أو لمسة موبايل' : 'SCAN OR TAP') : (language === 'ar' ? 'امسح الكود بالكاميرا' : 'SCAN QR CODE'), 991, 600, 26, 1, 500);
  if (config.numbered) fittedText(context, `${language === 'ar' ? 'ترابيزة' : 'Table'} ${new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en').format(config.startNumber)}`, 1040, 600, 24, 1);
  context.font = '500 15px Manrope Variable, sans-serif'; context.direction = 'ltr'; context.fillText('with bilhanah', 384, 1080);

  const back = document.createElement('canvas'); back.width = 768; back.height = 1100;
  const backContext = back.getContext('2d')!;
  backContext.fillStyle = design.background; backContext.fillRect(0, 0, 768, 1100);
  backContext.fillStyle = design.ink; backContext.textAlign = 'center'; backContext.font = '650 28px Manrope Variable, sans-serif'; backContext.fillText('bilhanah', 384, 1000);
  return { front: canvas, back };
}
