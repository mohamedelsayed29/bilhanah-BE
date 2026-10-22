import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCounterClockwiseIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../lib/language';
import { colorContrast, normalizeHex, printColors, readableInk, type PrintColors, type StandConfig } from './catalog';
import './stand-colors.css';

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value.toUpperCase());
  const [invalid, setInvalid] = useState(false);
  const { text } = useLanguage();
  useEffect(() => { setDraft(value.toUpperCase()); setInvalid(false); }, [value]);
  function commit() {
    const normalized = normalizeHex(draft);
    setInvalid(!normalized);
    if (normalized) { setDraft(normalized); onChange(normalized); }
  }
  return <div className="stand-color-field">
    <span id={`${id}-label`}>{label}</span>
    <div className="stand-color-inputs">
      <input className="stand-native-color" type="color" value={value} aria-label={`${label} — ${text('بالتة الألوان', 'color picker')}`} onChange={event => { setDraft(event.target.value.toUpperCase()); setInvalid(false); onChange(event.target.value.toUpperCase()); }} />
      <input className="shop-input stand-color-hex" type="text" dir="ltr" aria-label={`${label} — HEX`} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} value={draft} maxLength={7} required pattern="#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})" autoComplete="off" spellCheck={false} onInvalid={() => setInvalid(true)} onChange={event => { setDraft(event.target.value); setInvalid(false); if (/^#?[\da-f]{6}$/i.test(event.target.value)) onChange(normalizeHex(event.target.value)!); }} onBlur={commit} />
    </div>
    {invalid && <small id={`${id}-error`} className="shop-error">{text('اكتب كود لون صحيح، زي #075E54.', 'Enter a valid color, such as #075E54.')}</small>}
  </div>;
}

type HSV = { h: number; s: number; v: number };
function hsvToHex({ h, s, v }: HSV) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
function hexToHsv(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}
function ColorWheel({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { text } = useLanguage();
  const help = useId();
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  useEffect(() => { setHsv(current => { const next = hexToHsv(value); return { ...next, h: !next.s || !next.v ? current.h : next.h, s: !next.v ? current.s : next.s }; }); }, [value]);
  function choose(next: HSV) { setHsv(next); onChange(hsvToHex(next)); }
  function point(element: HTMLDivElement, x: number, y: number) {
    const box = element.getBoundingClientRect(), dx = (x - box.left) / box.width - .5, dy = (y - box.top) / box.height - .5;
    choose({ ...hsv, h: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) * 2) });
  }
  return <div className="stand-wheel-controls">
    <div className="stand-color-wheel" role="slider" tabIndex={0} aria-label={text('عجلة الألوان', 'Color wheel')} aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(hsv.h) % 360} aria-valuetext={`${value}, ${text('تشبع', 'saturation')} ${Math.round(hsv.s * 100)}%`} aria-describedby={help}
      onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); point(event.currentTarget, event.clientX, event.clientY); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event.currentTarget, event.clientX, event.clientY); }}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const amount = event.shiftKey ? 10 : 2; choose({ ...hsv, h: event.key === 'Home' ? 0 : event.key === 'End' ? 359 : event.key === 'ArrowLeft' ? (hsv.h - amount + 360) % 360 : event.key === 'ArrowRight' ? (hsv.h + amount) % 360 : hsv.h, s: event.key === 'ArrowUp' ? Math.min(1, hsv.s + .05) : event.key === 'ArrowDown' ? Math.max(0, hsv.s - .05) : hsv.s }); }}>
      <span className="stand-wheel-spectrum" style={{ filter: `brightness(${hsv.v})` }} />
      <span className="stand-wheel-thumb" style={{ left: `${50 + Math.cos(hsv.h * Math.PI / 180) * hsv.s * 50}%`, top: `${50 + Math.sin(hsv.h * Math.PI / 180) * hsv.s * 50}%`, background: value }} />
    </div>
    <p id={help} className="stand-wheel-help">{text('اسحب لاختيار الدرجة. بالكيبورد: يمين وشمال للون، وفوق وتحت للتشبع.', 'Drag to choose. Arrow keys: left/right change hue; up/down change saturation.')}</p>
    <label className="stand-brightness"><span>{text('فاتح / غامق', 'Light / dark')}<b>{Math.round(hsv.v * 100)}%</b></span><input type="range" min="0" max="100" value={Math.round(hsv.v * 100)} aria-label={text('سطوع اللون', 'Color brightness')} style={{ background: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})` }} onChange={event => choose({ ...hsv, v: Number(event.target.value) / 100 })} /></label>
  </div>;
}

export function StandColorPicker({ config, onChange }: { config: StandConfig; onChange: (colors: PrintColors | null) => void }) {
  const { text } = useLanguage();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<keyof PrintColors>('background');
  const [draft, setDraft] = useState<PrintColors>(() => printColors(config));
  const [preset, setPreset] = useState(!config.customColors);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  function launch() { setDraft(printColors(config)); setPreset(!config.customColors); setTarget('background'); setOpen(true); dialog.current?.showModal(); }
  function close() { dialog.current?.close(); }
  function edit(key: keyof PrintColors, color: string) { setPreset(false); setDraft(current => key === 'background' ? { background: color, ink: readableInk(color) } : { ...current, ink: color }); }
  function apply() {
    for (const input of dialog.current?.querySelectorAll('input') ?? []) if (!input.reportValidity()) return;
    onChange(preset ? null : { background: draft.background, ink: draft.ink }); close();
  }
  const lowContrast = colorContrast(draft.background, draft.ink) < 4.5;
  return <>
    <div className="stand-custom-style">
      <button ref={trigger} type="button" className={`stand-add-color ${config.customColors ? 'selected' : ''}`} aria-label={text('اختار لون مخصص', 'Choose a custom color')} aria-haspopup="dialog" aria-expanded={open} style={config.customColors ? { background: config.customColors.background, color: config.customColors.ink } : undefined} onClick={launch}><PlusIcon size={25} aria-hidden="true" /></button>
      <span>{text('لون مخصص', 'Custom')}</span>
    </div>
    {createPortal(<dialog ref={dialog} className="stand-color-dialog" aria-labelledby={title} onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} onClick={event => { if (event.target !== event.currentTarget) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); }}>
      <div className="stand-color-dialog-inner">
        <header><div><h2 id={title}>{text('لون على ذوق براندك', 'Find your brand’s color')}</h2><p>{text('اختار من العجلة أو اكتب كود HEX.', 'Choose from the wheel or enter a HEX code.')}</p></div><button type="button" className="stand-color-close" aria-label={text('إغلاق اختيار الألوان', 'Close color picker')} onClick={close}><XIcon size={21} aria-hidden="true" /></button></header>
        <div className="stand-color-dialog-body">
          <div className="stand-color-target" role="group" aria-label={text('اللون اللي بتعدّله', 'Color to edit')}>{(['background', 'ink'] as const).map(key => <button key={key} type="button" aria-pressed={target === key} onClick={() => setTarget(key)}><i style={{ background: draft[key] }} aria-hidden="true" />{key === 'background' ? text('الخلفية', 'Background') : text('النص', 'Text')}</button>)}</div>
          <div className="stand-color-dialog-layout">
            <ColorWheel value={draft[target]} onChange={color => edit(target, color)} />
            <div className="stand-color-dialog-values">
              <div onFocusCapture={() => setTarget('background')}><ColorField label={text('لون الخلفية', 'Background color')} value={draft.background} onChange={color => edit('background', color)} /></div>
              <div onFocusCapture={() => setTarget('ink')}><ColorField label={text('لون النص', 'Text color')} value={draft.ink} onChange={color => edit('ink', color)} /></div>
              <div className="stand-color-sample" style={{ background: draft.background, color: draft.ink }} aria-label={text('عينة ألوان الطباعة المختارة', 'Selected print color sample')}><strong>{config.brand.trim() || text('اسم براندك', 'Your brand')}</strong><span>{text('معاينة اللون والنص', 'Background & text preview')}</span></div>
              {lowContrast && <div className="stand-color-contrast" role="status"><span>{text('النص مش واضح كفاية.', 'Text is hard to read.')}</span><button type="button" onClick={() => edit('ink', readableInk(draft.background))}>{text('ظبّط وضوح النص', 'Improve text contrast')}</button></div>}
              <button type="button" className="stand-color-reset" onClick={() => { setDraft(printColors({ ...config, customColors: null })); setPreset(true); setTarget('background'); }}><ArrowCounterClockwiseIcon size={14} aria-hidden="true" />{text('رجّع الألوان الجاهزة', 'Reset to preset')}</button>
            </div>
          </div>
          <p className="stand-color-dialog-note">{text('طبّق اللون لمشاهدته في 3D. الـQR بيفضل داكن على خلفية بيضا.', 'Apply to see your colors in 3D. QR stays dark on white.')}</p>
        </div>
        <footer><button type="button" className="button button-outline" onClick={close}>{text('إلغاء', 'Cancel')}</button><button type="button" className="button button-teal" onClick={apply}>{text('تطبيق الألوان', 'Apply colors')}</button></footer>
      </div>
    </dialog>, document.body)}
  </>;
}

export function StandColorSummary({ config }: { config: StandConfig }) {
  const { text } = useLanguage();
  if (!config.customColors) return null;
  return <span className="shop-order-colors"><i style={{ background: config.customColors.background }} aria-hidden="true" /><span>{text('ألوان مخصصة', 'Custom colors')} <bdi>{config.customColors.background.toUpperCase()}</bdi> / <bdi>{config.customColors.ink.toUpperCase()}</bdi></span></span>;
}
