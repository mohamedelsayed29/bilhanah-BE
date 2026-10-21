import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { ArrowLeftIcon, ArrowCounterClockwiseIcon, CheckIcon, CubeIcon, ContactlessPaymentIcon, FloppyDiskIcon, ForkKnifeIcon, LinkSimpleIcon, MinusIcon, PlusIcon, QrCodeIcon, ShoppingBagIcon, StarIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { useLanguage, usePageTitle } from '../../lib/language';
import { defaultConfig, designs, destinationError, loadDraft, MAX_QUANTITY, purposes, shapes, UNIT_PRICE, NFC_SURCHARGE, unitPrice, lineTotal, type CartItem, type Delivery, type PurposeId, type StandConfig } from './catalog';
import { StandPreview, type StandPreviewMode } from './StandPreview';
import { ShopCheckout } from './ShopCheckout';
import { StandColorPicker, StandColorSummary } from './StandColorPicker';
import { StandPriceBreakdown } from './StandPriceBreakdown';
import './shop.css';

type Stage = 'design' | 'bag' | 'checkout';
export function ShopPage() {
  const { text, language, number } = useLanguage();
  usePageTitle('متجر حوامل QR وNFC | بالهنا', 'QR & NFC stand shop | Bilhanah');
  const [config, setConfig] = useState<StandConfig>(loadDraft);
  const [view, setView] = useState<StandPreviewMode>('photo');
  const [stage, setStage] = useState<Stage>('design');
  const [bag, setBag] = useState<CartItem[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [urlError, setUrlError] = useState('');
  const [logoError, setLogoError] = useState('');
  const [readingLogo, setReadingLogo] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>({ name: '', phone: '', email: '', city: '', address: '', notes: '', payment: 'cash' });
  const heading = useRef<HTMLHeadingElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const logoRead = useRef(0);
  const count = bag.reduce((sum, item) => sum + item.config.quantity, 0);
  const nfcCount = bag.reduce((sum, item) => sum + (item.config.nfc ? item.config.quantity : 0), 0);

  useEffect(() => {
    if (stage === 'checkout') return;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [stage]);

  function update<K extends keyof StandConfig>(key: K, value: StandConfig[K]) { setConfig(current => ({ ...current, [key]: value })); setStatus(''); }
  function changePurpose(purpose: PurposeId) {
    setConfig(current => ({ ...current, purpose, url: purpose === 'menu' ? `${window.location.origin}/?demo=1` : '', caption: '' }));
    setUrlError('');
  }
  function saveDraft() {
    try { localStorage.setItem('bilhanah:stand-draft:v1', JSON.stringify(config)); setStatus(text('تصميمك اتحفظ على الجهاز. هتلاقيه لما ترجع.', 'Your design is saved on this device for your next visit.')); }
    catch { setStatus(text('مش قادرين نحفظ على الجهاز. تصميمك لسه موجود طول ما الصفحة مفتوحة.', 'Device storage is unavailable. Your design is still here while this page stays open.')); }
  }
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const sequence = ++logoRead.current;
    const file = event.target.files?.[0];
    if (!file) return;
    setLogoError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setLogoError(text('اختار صورة PNG أو JPG أو WebP، بحد أقصى ٢ ميجابايت.', 'Choose a PNG, JPG or WebP image up to 2 MB.')); event.target.value = ''; return; }
    setReadingLogo(true);
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      await new Promise<void>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(); image.onerror = reject; image.src = data; });
      if (sequence === logoRead.current) { update('logo', data); }
    } catch { if (sequence === logoRead.current) setLogoError(text('الصورة ما اتفتحتش. جرّب ملف تاني.', 'We couldn’t open this image. Try another file.')); }
    finally { if (sequence === logoRead.current) setReadingLogo(false); }
  }
  function addToBag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = destinationError(config, language === 'en');
    setUrlError(error);
    if (error) { urlInput.current?.focus(); return; }
    const snapshot = { ...config, brand: config.brand.trim(), url: config.url.trim() };
    if (editing) { setBag(current => current.map(item => item.id === editing ? { ...item, config: snapshot } : item)); setEditing(null); setStage('bag'); }
    else { setBag(current => [...current, { id: crypto.randomUUID(), config: snapshot }]); setStatus(text('حاملك اتضاف للسلة. كمّل تصميم تاني أو راجع طلبك.', 'Added to your bag. Make another design or review your order.')); }
  }
  function editItem(item: CartItem) { setConfig({ ...item.config }); setEditing(item.id); setStatus(''); setUrlError(''); setView('3d'); setStage('design'); }
  function reset() { logoRead.current++; setReadingLogo(false); setConfig(defaultConfig()); setUrlError(''); setLogoError(''); setStatus(''); setEditing(null); if (logoInput.current) logoInput.current.value = ''; }

  return <div className="stand-shop">
    <div className="shop-topbar page-container">
      <nav aria-label={text('مسار الصفحة', 'Breadcrumb')}><Link to="/">{text('الرئيسية', 'Home')}</Link><span>/</span><span>{text('متجر الحوامل', 'Stand shop')}</span></nav>
      <button type="button" className="shop-bag-trigger" onClick={() => { setStage('bag'); setStatus(''); }}><ShoppingBagIcon size={19} aria-hidden="true" />{text('السلة', 'Bag')}<b>{number(count)}</b></button>
    </div>
    {stage !== 'checkout' && <header className="shop-heading page-container">
      <div><h1 ref={heading} tabIndex={-1}>{stage === 'design' ? text('حامل على ذوق براندك.', 'A stand that’s yours.') : text('راجع حواملك قبل ما تكمّل.', 'Your stands, ready to review.')}</h1>
        <p>{stage === 'design' ? text('اختار الشكل، حدّد الرابط، وخصّص الطباعة. QR مع كل حامل، وNFC لو حبيت.', 'Choose the shape, add your link and personalize the print. QR is included. NFC is up to you.') : text('كل تصميم بسعره وكميته، والإضافات واضحة في الملخص.', 'Review each design, its quantity and the price of every add-on.')}</p>
      </div>
      <div className="shop-price-intro"><span>{stage === 'design' ? text('سعر القطعة حسب اختيارك', 'Per stand, with your options') : text('إجمالي المنتجات', 'Product total')}</span><strong>{number(stage === 'design' ? unitPrice(config) : bag.reduce((sum, item) => sum + lineTotal(item.config), 0))} <small>{text('ج.م', 'EGP')}</small></strong><small>{stage === 'bag' ? text('قبل إضافة الشحن', 'Before shipping') : config.nfc ? text('QR + NFC · يشمل إضافة ١٠٠ ج.م', 'QR + NFC · includes the 100 EGP add-on') : text('QR فقط · إضافة NFC بـ١٠٠ ج.م', 'QR only · add NFC for 100 EGP')}</small></div>
    </header>}
    <ol className="shop-journey page-container" aria-label={text('خطوات الشراء', 'Shopping steps')}>
      {[text('اختار وخصّص', 'Choose & customize'), text('راجع السلة', 'Review bag'), text('بيانات الطلب', 'Order details')].map((label, index) => {
        const step = stage === 'design' ? 0 : stage === 'bag' ? 1 : 2;
        return <li key={label} className={index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <CheckIcon size={13} aria-hidden="true" /> : number(index + 1)}</span>{label}</li>;
      })}
    </ol>
    <div className="shop-demo-notice page-container"><span className="shop-demo-dot" aria-hidden="true" />{text('تجربة شراء توضيحية. لن يتم إرسال طلب أو تحصيل أي مبلغ.', 'A shopping preview. No order is sent and no payment is collected.')}</div>
    {stage === 'checkout' ? <ShopCheckout items={bag} delivery={delivery} onDelivery={setDelivery} onBack={() => setStage('bag')} onDone={() => { setBag([]); setDelivery({ name: '', phone: '', email: '', city: '', address: '', notes: '', payment: 'cash' }); setStage('design'); reset(); }} /> : stage === 'design' ? <div className="shop-workspace page-container">
      <StandPreview config={config} view={view} onView={setView} />
      <form className="stand-config" onSubmit={addToBag}>
        {editing && <div className="shop-edit-notice">{text('بتعدّل تصميم موجود في السلة.', 'Editing a design in your bag.')}<button type="button" onClick={() => { setEditing(null); setStage('bag'); }}>{text('إلغاء التعديل', 'Cancel edit')}</button></div>}
        <fieldset className="shop-fieldset">
          <legend><span>01</span>{text('اختار حاملك', 'Choose your stand')}</legend>
          <p className="shop-section-intro">{text('أكريليك شفاف بقاعدة. كل الأشكال بنفس السعر الأساسي.', 'Clear acrylic with a base. Every shape has the same base price.')}</p>
          <div className="shop-shape-options">{shapes.map(shape => <label key={shape.id} className={`shop-shape-option ${config.shape === shape.id ? 'selected' : ''}`}><input type="radio" name="shape" value={shape.id} checked={config.shape === shape.id} onChange={() => update('shape', shape.id)} /><img src={shape.image} alt="" width="110" height="137" loading="lazy" /><span>{shape.name[language]}<CheckIcon className="shop-choice-check" size={15} weight="bold" aria-hidden="true" /></span></label>)}</div>
          <fieldset className="shop-connection"><legend>{text('طريقة فتح الرابط', 'How guests open your link')}</legend><div className="shop-connection-options">
            <label className={!config.nfc ? 'selected' : ''}><input type="radio" name="connection" checked={!config.nfc} onChange={() => update('nfc', false)} /><QrCodeIcon size={23} aria-hidden="true" /><span><strong>{text('QR فقط', 'QR only')}</strong><small>{text('مسح الكود بكاميرا الموبايل', 'Scan with the phone camera')}</small></span><b>{number(UNIT_PRICE)} <small>{text('ج.م', 'EGP')}</small></b><CheckIcon className="shop-choice-check" size={16} aria-hidden="true" /></label>
            <label className={config.nfc ? 'selected' : ''}><input type="radio" name="connection" checked={config.nfc} onChange={() => update('nfc', true)} /><ContactlessPaymentIcon size={23} aria-hidden="true" /><span><strong>{text('QR + شريحة NFC', 'QR + NFC chip')}</strong><small>{text('مسح الكود أو لمسة بموبايل متوافق', 'Scan, or tap with a compatible phone')}</small></span><b>{number(UNIT_PRICE + NFC_SURCHARGE)} <small>{text('ج.م', 'EGP')}</small><em>+{number(NFC_SURCHARGE)} {text('للشريحة', 'for NFC')}</em></b><CheckIcon className="shop-choice-check" size={16} aria-hidden="true" /></label>
          </div></fieldset>
        </fieldset>
        <fieldset className="shop-fieldset">
          <legend><span>02</span>{text('الحامل هيفتح إيه؟', 'Where should it take guests?')}</legend>
          <p className="shop-section-intro">{text('اختار الوظيفة، وبعدها حط الرابط اللي عايز ضيفك يفتحه.', 'Choose its purpose, then add the link you want guests to open.')}</p>
          <div className="shop-purpose-options">{purposes.map(purpose => {
            const Icon = purpose.id === 'menu' ? ForkKnifeIcon : purpose.id === 'reviews' ? StarIcon : LinkSimpleIcon;
            return <label key={purpose.id} className={config.purpose === purpose.id ? 'selected' : ''}><input type="radio" name="purpose" value={purpose.id} checked={config.purpose === purpose.id} onChange={() => changePurpose(purpose.id)} /><Icon size={20} aria-hidden="true" /><span><strong>{purpose.name[language]}</strong><small>{purpose.hint[language]}</small></span><span className="shop-radio-dot" aria-hidden="true" /></label>;
          })}</div>
          <label className="shop-label" htmlFor="stand-url">{config.purpose === 'reviews' ? text('رابط تقييمات Google', 'Google review link') : config.purpose === 'menu' ? text('رابط المنيو', 'Menu link') : text('الرابط اللي هيفتح', 'Destination link')}</label>
          <input ref={urlInput} id="stand-url" className="shop-input" type="url" dir="ltr" value={config.url} maxLength={2048} required onChange={event => { update('url', event.target.value); setUrlError(''); }} placeholder={config.purpose === 'reviews' ? 'https://g.page/r/…/review' : 'https://your-website.com'} aria-invalid={!!urlError} aria-describedby={urlError ? 'stand-url-error' : 'stand-url-help'} />
          {urlError ? <p className="shop-error" id="stand-url-error" role="alert">{urlError}</p> : <p className="shop-field-help" id="stand-url-help">{config.purpose === 'menu' ? text('الرابط الحالي يفتح المنيو التجريبي. استبدله برابط منيو مطعمك.', 'The default link opens the sample menu. Replace it with your own menu link.') : config.purpose === 'reviews' ? text('انسخ رابط طلب التقييم من ملف نشاطك على Google.', 'Paste the review-request link from your Google Business Profile.') : text('اكتب الرابط كاملًا، مثل رابط موقعك أو واتساب.', 'Use the full address of your website, WhatsApp or another page.')}</p>}
        </fieldset>
        <fieldset className="shop-fieldset">
          <legend><span>03</span>{text('خلّيه يشبه براندك', 'Make it your brand')}</legend>
          <div className="shop-two-fields"><label className="shop-label">{text('اسم البراند', 'Brand name')}<input className="shop-input" name="brand" maxLength={35} required value={config.brand} placeholder={text('مثال: بيت الزيتون', 'e.g. Olive House')} onChange={event => update('brand', event.target.value)} /></label><label className="shop-label">{text('العبارة على الحامل', 'Stand message')} <small>{text('(اختياري)', '(optional)')}</small><input className="shop-input" maxLength={60} value={config.caption} placeholder={purposes.find(item => item.id === config.purpose)!.caption[language]} onChange={event => update('caption', event.target.value)} /></label></div>
          <fieldset className="shop-print-style"><legend>{text('لون الطباعة', 'Print style')}</legend><div className="shop-design-options">{designs.map(design => <label key={design.id} className={config.design === design.id && !config.customColors ? 'selected' : ''}><input type="radio" name="design" value={design.id} checked={config.design === design.id && !config.customColors} onChange={() => { setConfig(current => ({ ...current, design: design.id, customColors: null })); setStatus(''); }} /><span className="shop-design-sample" style={{ background: design.background, color: design.ink }}><span /><QrCodeIcon size={24} aria-hidden="true" /><i style={{ background: design.accent }} /></span><span>{design.name[language]}</span></label>)}<StandColorPicker config={config} onChange={colors => update('customColors', colors)} /></div></fieldset>
          <div className="shop-logo-upload">{config.logo && <img className="shop-logo-preview" src={config.logo} alt={text('لوجو البراند المرفوع', 'Your uploaded brand logo')} />}<label className="shop-upload-button"><UploadSimpleIcon size={18} aria-hidden="true" />{readingLogo ? text('بنجهّز اللوجو…', 'Opening logo…') : config.logo ? text('غيّر اللوجو', 'Replace logo') : text('ارفع لوجو البراند', 'Upload your logo')}<input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadLogo} disabled={readingLogo} /></label>{config.logo && <button className="shop-text-button" type="button" onClick={() => { logoRead.current++; update('logo', ''); if (logoInput.current) logoInput.current.value = ''; }}>{text('إزالة', 'Remove')}</button>}<small>{text('اختياري · PNG, JPG, WebP · حتى ٢ ميجابايت', 'Optional · PNG, JPG, WebP · up to 2 MB')}</small></div>
          {logoError && <p className="shop-error" role="alert">{logoError}</p>}
          <label className="shop-check"><input type="checkbox" checked={config.numbered} onChange={event => update('numbered', event.target.checked)} /><span>{text('أضف ترقيم للترابيزات', 'Add table numbers')}<small>{text('رقم مختلف على كل قطعة في نفس التصميم.', 'A different number on each stand in this design.')}</small></span></label>
          {config.numbered && <label className="shop-label shop-number-start">{text('ابدأ الترقيم من', 'Start numbering from')}<input className="shop-input" type="number" min={1} max={9999} required value={config.startNumber} onChange={event => update('startNumber', Number(event.target.value))} /></label>}
          <details className="shop-extra-details"><summary>{text('عندك ملاحظات على التصميم؟', 'Any design notes?')}</summary><label className="shop-label">{text('ملاحظات على التصميم', 'Design notes')} <small>{text('(اختياري)', '(optional)')}</small><textarea className="shop-input" maxLength={300} rows={2} value={config.notes} placeholder={text('تفاصيل تحب نراعيها في الطباعة…', 'Details you’d like us to consider…')} onChange={event => update('notes', event.target.value)} /></label></details>
          <button type="button" className="shop-preview-design" onClick={() => { setView('3d'); document.getElementById('stand-preview')?.scrollIntoView({ block: 'start', behavior: 'instant' }); }}><CubeIcon size={18} aria-hidden="true" />{text('راجع تصميمك في 3D', 'Review your design in 3D')}<ArrowLeftIcon size={16} className="directional-arrow" aria-hidden="true" /></button>
        </fieldset>
        <section className="shop-purchase-panel" aria-label={text('الكمية والسعر', 'Quantity and price')}>
          <div className="shop-config-total"><div><label htmlFor="stand-quantity">{text('عدد القطع', 'Quantity')}</label><div className="shop-quantity"><button type="button" disabled={config.quantity <= 1} onClick={() => update('quantity', Math.max(1, config.quantity - 1))} aria-label={text('تقليل عدد الحوامل', 'Decrease stand quantity')}><MinusIcon size={15} aria-hidden="true" /></button><input id="stand-quantity" aria-label={text('عدد الحوامل', 'Stand quantity')} type="number" min={1} max={MAX_QUANTITY} required value={config.quantity} onChange={event => update('quantity', Number(event.target.value))} /><button type="button" disabled={config.quantity >= MAX_QUANTITY} onClick={() => update('quantity', Math.min(MAX_QUANTITY, config.quantity + 1))} aria-label={text('زيادة عدد الحوامل', 'Increase stand quantity')}><PlusIcon size={15} aria-hidden="true" /></button></div></div><div><span>{text('سعر القطعة', 'Per stand')}</span><strong>{number(unitPrice(config))} <small>{text('ج.م', 'EGP')}</small></strong></div></div>
          <StandPriceBreakdown quantity={config.quantity} nfcQuantity={config.nfc ? config.quantity : 0} />
          <p className="shop-field-help">{text('الشحن غير محسوب في الإجمالي.', 'Shipping is not included in this total.')}</p>
          <button type="submit" className="button button-teal shop-add-button" disabled={readingLogo}><ShoppingBagIcon size={19} aria-hidden="true" />{editing ? text('احفظ التعديل في السلة', 'Save changes to bag') : text('أضف تصميمك للسلة', 'Add your design to bag')}<ArrowLeftIcon size={19} className="directional-arrow" aria-hidden="true" /></button>
          <div className="shop-save-actions"><button type="button" onClick={saveDraft}><FloppyDiskIcon size={16} aria-hidden="true" />{text('احفظ التصميم للجاي', 'Save for later')}</button><button type="button" onClick={reset}><ArrowCounterClockwiseIcon size={16} aria-hidden="true" />{text('تصميم جديد', 'Start fresh')}</button></div>
          <div className="shop-feedback" role="status">{status}{status && bag.length > 0 && <button type="button" onClick={() => setStage('bag')}>{text('عرض السلة', 'View bag')}<ArrowLeftIcon size={14} className="directional-arrow" aria-hidden="true" /></button>}</div>
        </section>
      </form>
    </div> : <section className="shop-bag-layout page-container" aria-label={text('سلة الحوامل', 'Stand shopping bag')}>
      {bag.length === 0 ? <div className="shop-empty"><ShoppingBagIcon size={48} weight="duotone" aria-hidden="true" /><h2>{text('لسه المساحة لبصمتك.', 'Room for your first design.')}</h2><p>{text('اختار شكل الحامل وخصصه، وهتلاقيه هنا.', 'Choose a stand and make it yours. You’ll find it here.')}</p><button className="button button-teal" onClick={() => { reset(); setStage('design'); }}>{text('صمّم أول حامل', 'Design your first stand')}</button></div> : <>
        <div className="shop-bag-items">{bag.map(item => <article className="shop-bag-line" key={item.id}>
          <img src={shapes.find(shape => shape.id === item.config.shape)!.image} alt={shapes.find(shape => shape.id === item.config.shape)!.name[language]} width="90" height="112" />
          <div className="shop-bag-line-copy"><h2>{item.config.brand}</h2><p>{shapes.find(shape => shape.id === item.config.shape)!.name[language]} · {designs.find(design => design.id === item.config.design)!.name[language]} · {purposes.find(purpose => purpose.id === item.config.purpose)!.name[language]}</p>
            <StandColorSummary config={item.config} /><span className="shop-tech-label">{item.config.nfc ? 'QR + NFC' : text('QR فقط · بدون NFC', 'QR only · no NFC')}</span><p>{number(unitPrice(item.config))} {text('ج.م للقطعة', 'EGP per stand')}</p>
            {item.config.numbered && <small>{text('ترابيزة', 'Table')} {number(item.config.startNumber)}–{number(item.config.startNumber + item.config.quantity - 1)}</small>}
            <div className="shop-bag-line-controls"><label className="shop-label">{text('الكمية', 'Quantity')}<input className="shop-input" aria-label={`${text('كمية', 'Quantity for')} ${item.config.brand}`} type="number" min={1} max={MAX_QUANTITY} value={item.config.quantity} onChange={event => setBag(current => current.map(line => line.id === item.id ? { ...line, config: { ...line.config, quantity: Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(event.target.value) || 1))) } } : line))} /></label><button type="button" className="shop-text-button" onClick={() => editItem(item)}>{text('عدّل التصميم', 'Edit design')}</button><button type="button" className="shop-text-button shop-remove" onClick={() => setBag(current => current.filter(line => line.id !== item.id))} aria-label={`${text('احذف', 'Remove')} ${item.config.brand}`}><TrashIcon size={15} aria-hidden="true" />{text('حذف', 'Remove')}</button></div>
          </div><strong className="shop-bag-line-price">{number(lineTotal(item.config))} <small>{text('ج.م', 'EGP')}</small></strong>
        </article>)}<button type="button" className="shop-back" onClick={() => { reset(); setStage('design'); }}><PlusIcon size={17} aria-hidden="true" />{text('أضف تصميم تاني', 'Add another design')}</button></div>
        <aside className="shop-summary"><h2>{text('ملخص السلة', 'Your bag at a glance')}</h2><StandPriceBreakdown quantity={count} nfcQuantity={nfcCount} /><p>{text('الشحن غير محسوب. يتم تحديده عند تفعيل الطلبات.', 'Shipping is not included. It will be confirmed when ordering is enabled.')}</p><button className="button button-teal" type="button" onClick={() => setStage('checkout')}>{text('كمّل بيانات الطلب', 'Continue to order details')}<ArrowLeftIcon size={18} className="directional-arrow" aria-hidden="true" /></button><small>{text('خطوة تجريبية، بدون دفع فعلي.', 'A preview step. No real payment.')}</small></aside>
      </>}
    </section>}
    {stage === 'design' && <section className="shop-details page-container"><div><h2>{text('كل حاجة واضحة قبل ما تختار.', 'Know exactly what you’re choosing.')}</h2><p>{text('الشكل والطباعة على ذوقك. طريقة الاستخدام والسعر حسب اختيارك.', 'Your shape and print. Your choice of scan, or scan and tap.')}</p></div><div className="shop-faq">
      <details><summary>{text('إيه الفرق بين QR وNFC؟', 'What’s the difference between QR and NFC?')}</summary><p>{text('الـQR بيتفتح بكاميرا الموبايل وموجود في كل حامل بـ٣٥٠ ج.م. شريحة NFC إضافة اختيارية بـ١٠٠ ج.م للقطعة؛ بتفتح نفس الرابط بلمسة موبايل متوافق، مع وجود الـQR كمان.', 'QR opens through the phone camera and is included at 350 EGP. An optional NFC chip adds 100 EGP per stand and opens the same link with a compatible phone. QR is still included.')}</p></details>
      <details><summary>{text('لازم أكون مشترك في منيو بالهنا؟', 'Do I need a Bilhanah menu subscription?')}</summary><p>{text('لأ. الحامل يقدر يفتح أي رابط منيو، تقييمات Google، موقعك أو واتساب. انت بتحدد الرابط.', 'No. Use any menu link, Google reviews, your website or WhatsApp. You choose the destination.')}</p></details>
      <details><summary>{text('الصورة هي نفس تصميمي النهائي؟', 'Does the product photo show my final print?')}</summary><p>{text('الصورة توضيحية للشكل والخامة. افتح عرض 3D عشان تراجع اللوجو والألوان والطباعة واختيار NFC على الحامل.', 'The photo illustrates the shape and material. Open the 3D view to review your logo, colors, print and NFC option.')}</p></details>
      <details><summary>{text('هل الطلب هنا بيتبعت فعلًا؟', 'Will this place a real order?')}</summary><p>{text('دي واجهة شراء تجريبية. تقدر تخصّص الحامل وتراجع طلبك وتنزّل ملخصه، لكن مفيش طلب بيتبعت ولا فلوس بتتخصم. الشحن غير محسوب.', 'This is a shopping preview. Customize, review and download a summary. No order is sent or payment collected. Shipping is not included.')}</p></details>
    </div></section>}
  </div>;
}
