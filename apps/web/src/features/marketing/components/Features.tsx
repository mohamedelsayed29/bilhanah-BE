import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeftIcon, ArrowsClockwiseIcon, BellRingingIcon, CheckIcon, GlobeHemisphereWestIcon, PaletteIcon, QrCodeIcon, ReceiptIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { OrderFlowDemo } from './OrderFlowDemo';

export function CapabilityStrip() {
  const { text } = useLanguage();
  const items = [
    { icon: QrCodeIcon, label: text('QR جاهز لمطعمك', 'Your QR, ready to go') },
    { icon: PaletteIcon, label: text('منيو يشبه براندك', 'A menu that feels like you') },
    { icon: ArrowsClockwiseIcon, label: text('تحديثات من غير طباعة', 'Update without reprinting') },
    { icon: GlobeHemisphereWestIcon, label: text('عربي وإنجليزي', 'Arabic & English') },
  ];
  return <div className="capability-strip page-container">{items.map(({ icon: Icon, label }) => <div key={label}><Icon size={23} weight="regular" /><span>{label}</span></div>)}</div>;
}

export function Features({ onDemo }: { onDemo: () => void }) {
  const { text } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const demoUrl = `${window.location.origin}/?demo=1`;
  const benefits = [
    { icon: PaletteIcon, title: text('كل أكلة تاخد حقها', 'Give every dish its moment'), body: text('صور واضحة، وصف يشهّي، وكل حجم بسعره. خلّي الاختيار أسهل لزبونك.', 'Beautiful photos, appetizing descriptions, and a price for every size. Make choosing easy.') },
    { icon: ReceiptIcon, title: text('إنت تدير، وإحنا نرتّب', 'Your menu, under your control'), body: text('غيّر سعر، أضف طبق، أو وقّف صنف خلص. من لوحة واحدة ومن غير طباعة جديدة.', 'Change a price, add a dish, or mark something sold out. One dashboard, no new print run.') },
    { icon: BellRingingIcon, title: text('طلبات أوضح. زبون أروق.', 'Clearer orders. Happier tables.'), body: text('استقبل طلبات الترابيزات والاستلام، ومع الباقة الكاملة نبّه الزبون لما طلبه يجهز.', 'Receive dine-in and pickup orders. With the Full Experience plan, alert customers when food is ready.') },
  ];
  async function copyLink() {
    try { await navigator.clipboard.writeText(demoUrl); setCopied(true); setCopyError(false); } catch { setCopyError(true); }
  }
  return <section id="features" className="features-section page-container section-space" aria-labelledby="features-title">
    <div className="feature-copy">
      <h2 id="features-title">{text('الأكل شغلتك.', 'You make the food.')}<span className="teal-text">{text('المنيو علينا.', 'We make the menu easy.')}</span></h2>
      <p className="section-intro">{text('مطعمك له روح. خلّي المنيو يحكيها، وخلّي كل تفصيلة في إيدك.', 'Your restaurant has a personality. Give it a menu to match, with every detail in your hands.')}</p>
      <div className="feature-list">{benefits.map(({ icon: Icon, title, body }) => <article className="feature-row" key={title}><span className="feature-icon"><Icon size={24} /></span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div>
      <button className="text-link" onClick={onDemo}>{text('افتح المنيو وجرّب بنفسك', 'Open the menu and try it')}<ArrowLeftIcon className="directional-arrow" size={19} /></button>
    </div>
    <div className="menu-showcase">
      <div className="showcase-topline"><span>{text('منيو حلو. تجربة أحلى.', 'Good food deserves a good menu.')}</span><span className="showcase-flower"><BowlFoodMark /></span></div>
      <OrderFlowDemo />
      <div className="qr-stand"><QRCodeSVG value={demoUrl} size={84} fgColor="#075E54" bgColor="#FFF8EF" level="M" marginSize={0} title={text('امسح لفتح المنيو التجريبي', 'Scan to open the sample menu')} /><span>{text('سكان وبالهنا!', 'Scan. Explore. Enjoy!')}</span><button onClick={copyLink}>{copied ? <CheckIcon size={13} /> : <QrCodeIcon size={13} />}{copied ? text('اتنسخ اللينك', 'Link copied') : text('انسخ لينك التجربة', 'Copy demo link')}</button>{copyError && <small role="status">{text('افتح التجربة من الزر أسفلها.', 'Open the sample with the button below.')}</small>}</div>
    </div>
  </section>;
}

function BowlFoodMark() { return <PaletteIcon size={24} weight="duotone" aria-hidden="true" />; }

export function HowItWorks() {
  const { text } = useLanguage();
  const steps = [
    { title: text('ضيف لمستك', 'Make it yours'), body: text('سجّل بيانات مطعمك، ارفع اللوجو، وضيف أكلاتك بصورها وأسعارها.', 'Add your restaurant details, upload your logo, and bring your dishes to life with photos and prices.') },
    { title: text('حط المنيو على الترابيزة', 'Bring your menu to the table'), body: text('اطبع الـQR، أو اختار حامل الأكريليك اللي بيجمع QR وNFC. زبونك يعمل سكان أو يقرّب موبايله ويفتح المنيو.', 'Print your QR, or choose an acrylic stand with QR and NFC. Guests can scan the code or tap their phone to open your menu.') },
    { title: text('واستقبل زباينك بالهنا', 'Let good hospitality happen'), body: text('زبونك يعمل سكان، يتصفح المنيو، ويطلب حسب الباقة اللي اخترتها.', 'Your customer scans, explores, and orders with the features included in your plan.') },
  ];
  return <section id="how-it-works" className="how-section section-space" aria-labelledby="how-title"><div className="page-container">
    <div className="how-heading"><h2 id="how-title">{text('من أول سكان،', 'From the first scan,')}<span>{text('التجربة تفرق.', 'feel the difference.')}</span></h2><p>{text('٣ خطوات بسيطة، وتبقى جاهز لضيافة أذكى.', 'Three simple steps to a more thoughtful table.')}</p></div>
    <div className="how-grid">{steps.map((step, index) => <article className="how-step" key={step.title}><span className="step-index" dir="ltr">0{index + 1}</span><h3>{step.title}</h3><p>{step.body}</p></article>)}</div>
  </div></section>;
}
