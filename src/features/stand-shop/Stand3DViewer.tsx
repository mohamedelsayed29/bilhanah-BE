import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, ArrowUUpLeftIcon, ArrowsOutSimpleIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../lib/language';
import { useReducedMotion } from '../marketing/hooks/useReducedMotion';
import { shapes, type StandConfig } from './catalog';
import { createStandArtwork } from './stand-artwork';
import { createStandScene, type StandScene } from './stand-scene';
import './stand-3d.css';

export default function Stand3DViewer({ config, qrElement }: { config: StandConfig; qrElement: RefObject<HTMLDivElement | null> }) {
  const { language, text } = useLanguage();
  const reduced = useReducedMotion();
  const instructions = useId();
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<StandScene | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const shape = shapes.find(item => item.id === config.shape)!;

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setStatus('loading');
    let viewer: StandScene;
    try { viewer = createStandScene(container, () => setStatus('unavailable')); runtime.current = viewer; }
    catch { setStatus('unavailable'); return; }
    return () => { runtime.current = null; viewer.dispose(); };
  }, [attempt]);

  useEffect(() => { runtime.current?.setShape(config.shape); }, [config.shape, attempt]);
  useEffect(() => { runtime.current?.setReducedMotion(reduced); }, [reduced, attempt]);
  useEffect(() => {
    const viewer = runtime.current;
    if (!viewer) return;
    viewer.canvas.setAttribute('aria-label', text('مجسّم الحامل. اسحب للدوران ٣٦٠ درجة، أو استخدم الأسهم. + و- للزوم، وHome لإعادة الزاوية.', '3D stand. Drag to rotate 360 degrees, or use the arrow keys. + and - zoom; Home resets the view.'));
    viewer.canvas.setAttribute('aria-describedby', instructions);
    let cancelled = false;
    const qr = qrElement.current?.querySelector('svg');
    const markup = qr ? new XMLSerializer().serializeToString(qr) : '';
    void createStandArtwork(config, language, markup).then(artwork => {
      if (cancelled) return;
      viewer.setArtwork(artwork); setStatus('ready');
    }).catch(() => { if (!cancelled) setStatus('unavailable'); });
    return () => { cancelled = true; };
  }, [config.customColors, config.nfc, config.brand, config.caption, config.design, config.logo, config.numbered, config.startNumber, config.purpose, config.url, language, attempt, instructions, qrElement]);

  useEffect(() => {
    if (status !== 'unavailable') return;
    runtime.current?.dispose(); runtime.current = null;
  }, [status]);

  return <div className="stand-3d-viewer" data-state={status} aria-label={text('معاينة ٣٦٠ درجة', '360-degree preview')}>
    <div ref={host} className="stand-3d-canvas" />
    {status === 'loading' && <div className="stand-3d-message" role="status"><ArrowsOutSimpleIcon size={28} aria-hidden="true" /><span>{text('بنجهّز مجسّم حاملك…', 'Preparing your 3D stand…')}</span></div>}
    {status === 'unavailable' && <div className="stand-3d-fallback"><img src={shape.image} width="880" height="1100" alt={text(`صورة الحامل ${shape.name.ar}`, `${shape.name.en} stand photo`)} /><div role="status"><p>{text('عرض 3D مش متاح في المتصفح حاليًا. تقدر تكمّل بصورة الحامل أو تعيد المحاولة.', '3D is currently unavailable in this browser. Use the product photo or try again.')}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{text('جرّب 3D تاني', 'Retry 3D')}</button></div></div>}
    {status === 'ready' && <>
      <span className="stand-3d-badge" dir="ltr">360°</span>
      <div className="stand-3d-tools" role="group" aria-label={text('التحكم في المجسّم', '3D model controls')}>
        <button type="button" onClick={() => runtime.current?.turn(Math.PI / 4)} aria-label={text('لف الحامل لليسار', 'Rotate stand left')} title={text('لف لليسار', 'Rotate left')}><ArrowCounterClockwiseIcon size={18} aria-hidden="true" /></button>
        <button type="button" onClick={() => runtime.current?.turn(-Math.PI / 4)} aria-label={text('لف الحامل لليمين', 'Rotate stand right')} title={text('لف لليمين', 'Rotate right')}><ArrowClockwiseIcon size={18} aria-hidden="true" /></button>
        <span aria-hidden="true" />
        <button type="button" onClick={() => runtime.current?.zoom(false)} aria-label={text('إبعاد المجسّم', 'Zoom out model')} title={text('إبعاد', 'Zoom out')}><MinusIcon size={18} aria-hidden="true" /></button>
        <button type="button" onClick={() => runtime.current?.zoom(true)} aria-label={text('تقريب المجسّم', 'Zoom in model')} title={text('تقريب', 'Zoom in')}><PlusIcon size={18} aria-hidden="true" /></button>
        <span aria-hidden="true" />
        <button type="button" onClick={() => runtime.current?.reset()} aria-label={text('إعادة زاوية البداية', 'Reset model view')} title={text('إعادة الزاوية', 'Reset view')}><ArrowUUpLeftIcon size={18} aria-hidden="true" /></button>
      </div>
    </>}
    <p id={instructions} className="stand-3d-instructions">{text('اسحب يمين وشمال للدوران · كبّر بإصبعين أو بالأزرار', 'Drag to rotate · Pinch or use the buttons to zoom')}</p>
  </div>;
}
