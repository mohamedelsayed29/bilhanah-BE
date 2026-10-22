import { lazy, Suspense, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowSquareOutIcon, DownloadSimpleIcon, CubeIcon, ImageIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../lib/language';
import { downloadFile, safeUrl, shapes, type StandConfig } from './catalog';

const Stand3DViewer = lazy(() => import('./Stand3DViewer'));
export type StandPreviewMode = 'photo' | '3d';
type Props = { config: StandConfig; view: StandPreviewMode; onView: (value: StandPreviewMode) => void };
export function StandPreview({ config, view, onView }: Props) {
  const { text, language } = useLanguage();
  const qr = useRef<HTMLDivElement>(null);
  const shape = shapes.find(item => item.id === config.shape)!;
  const url = safeUrl(config.url);
  function downloadQr() {
    const svg = qr.current?.querySelector('svg');
    if (svg && url) downloadFile(new XMLSerializer().serializeToString(svg), 'bilhanah-stand-qr.svg', 'image/svg+xml');
  }
  return <aside id="stand-preview" className="stand-gallery" aria-label={text('معاينة الحامل', 'Stand preview')}>
    <div hidden ref={qr}><QRCodeSVG value={url ?? `${window.location.origin}/?demo=1`} size={512} marginSize={4} level="M" bgColor="#ffffff" fgColor="#172b25" /></div>
    <div className="stand-gallery-tabs" role="group" aria-label={text('طريقة المعاينة', 'Preview mode')}>
      <button type="button" aria-pressed={view === 'photo'} onClick={() => onView('photo')}><ImageIcon size={16} aria-hidden="true" />{text('شكل الحامل', 'Product view')}</button>
      <button type="button" aria-pressed={view === '3d'} onClick={() => onView('3d')}><CubeIcon size={16} aria-hidden="true" />{text('عرض 3D · 360°', '3D view · 360°')}</button>
      <span dir="ltr">{config.nfc ? 'QR + NFC' : 'QR'}</span>
    </div>
    <div className={`stand-stage ${view === '3d' ? 'stand-stage-3d' : 'stand-stage-photo'}`}>
      {view === 'photo' ? <img className="stand-product-photo" src={shape.image} width="880" height="1100" alt={text(`صورة توضيحية للحامل ${shape.name.ar} بخامة أكريليك شفافة وقاعدة`, `Illustrative ${shape.name.en} acrylic stand with a transparent base`)} /> :
        <Suspense fallback={<div className="stand-3d-message" role="status">{text('بنحمّل معاينة 3D…', 'Loading the 3D preview…')}</div>}><Stand3DViewer config={config} qrElement={qr} /></Suspense>}
    </div>
    <div className="stand-gallery-caption"><strong>{shape.name[language]}</strong><span>{view === 'photo' ? text('صورة توضيحية للشكل والخامة؛ طباعتك واختيار NFC بيظهروا في 3D.', 'Illustrative shape and finish. Your print and NFC option appear in 3D.') : text('معاينة توضيحية بتصميمك. اسحب الحامل ولفّه ٣٦٠°.', 'Your design in an illustrative 3D preview. Drag to explore every angle.')}</span></div>
    {view === 'photo' && <button className="shop-preview-design" type="button" onClick={() => onView('3d')}><CubeIcon size={17} aria-hidden="true" />{text('شوف تصميمك على الحامل', 'Preview your design on the stand')}<ArrowSquareOutIcon size={15} aria-hidden="true" /></button>}
    <div className="stand-preview-actions"><button type="button" disabled={!url} onClick={downloadQr}><DownloadSimpleIcon size={16} aria-hidden="true" />{text('نزّل الـQR', 'Download QR')}</button>{url ? <a href={url} target="_blank" rel="noreferrer">{text('جرّب اللينك', 'Test the link')}<ArrowSquareOutIcon size={16} aria-hidden="true" /></a> : <span>{text('أضف لينك للمعاينة', 'Add a link to preview')}</span>}</div>
    <p className="stand-preview-note">{config.nfc ? text('الكاميرا أو لمسة NFC بيفتحوا نفس الرابط. اللمس يحتاج موبايل متوافق.', 'Scan or tap NFC to open the same link. NFC requires a compatible phone.') : text('افتح كاميرا الموبايل وامسح الـQR. الاختيار الحالي من غير شريحة NFC.', 'Open the phone camera and scan the QR. This option has no NFC chip.')}</p>
  </aside>;
}
