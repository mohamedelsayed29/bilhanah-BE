import { QRCodeSVG } from 'qrcode.react';
import { BatteryFullIcon, CellSignalFullIcon, ShieldCheckIcon, WifiHighIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { DemoMenu } from './DemoMenu';

/** Content of the sample-menu dialog: a short guide beside the menu, presented on a phone as guests see it. */
export function DemoShowcase() {
  const { text } = useLanguage();
  const steps = [
    { title: text('اختار القسم', 'Pick a category'), body: text('رئيسي، باستا، أو حاجة خفيفة.', 'Mains, pasta, or something light.') },
    { title: text('حدد الحجم', 'Choose a size'), body: text('كل حجم بسعره، من غير مفاجآت.', 'Every size shows its own price.') },
    { title: text('ضيف للسلة وأكّد', 'Add to bag and confirm'), body: text('زي ما زبونك هيطلب بالظبط.', 'Exactly how your guests will order.') },
  ];
  return <div className="demo-showcase">
    <aside className="demo-intro">
      <span className="demo-intro-icon"><img src="/brand/bilhanah-mark.svg" alt="" width="445" height="479" /></span>
      <h2>{text('حُط نفسك مكان زبونك.', 'Take a seat at your own table.')}</h2>
      <p>{text('ده منيو حقيقي تقدر تتفاعل معاه. جرّب الطلب من أوله لآخره.', 'This is a fully interactive menu. Try an order from start to finish.')}</p>
      <ol className="demo-steps">{steps.map((step, index) => <li key={step.title}>
        <span className="demo-step-index">{index + 1}</span>
        <div><strong>{step.title}</strong><small>{step.body}</small></div>
      </li>)}</ol>
      <div className="demo-qr">
        <QRCodeSVG value={`${window.location.origin}/?demo=1`} size={76} fgColor="#04352f" bgColor="#fff8ef" level="M" marginSize={0} title={text('امسح لفتح المنيو على موبايلك', 'Scan to open the menu on your phone')} />
        <div><strong>{text('جرّبه على موبايلك', 'Try it on your phone')}</strong><small>{text('امسح الكود بكاميرا الموبايل.', 'Scan the code with your camera.')}</small></div>
      </div>
      <p className="demo-intro-note"><ShieldCheckIcon size={16} />{text('تجربة توضيحية، من غير دفع ومن غير طلب حقيقي.', 'A sample experience. No payment, no real order.')}</p>
    </aside>
    <div className="demo-stage">
      <div className="demo-phone">
        <span className="phone-button phone-button-action" aria-hidden="true" />
        <span className="phone-button phone-button-volume-up" aria-hidden="true" />
        <span className="phone-button phone-button-volume-down" aria-hidden="true" />
        <span className="phone-button phone-button-power" aria-hidden="true" />
        <div className="demo-phone-screen">
          <div className="phone-status" dir="ltr" aria-hidden="true">
            <span className="phone-time">9:41</span>
            <span className="phone-island" />
            <span className="phone-status-icons"><CellSignalFullIcon size={16} weight="fill" /><WifiHighIcon size={16} weight="bold" /><BatteryFullIcon size={22} weight="fill" /></span>
          </div>
          <div className="phone-content"><DemoMenu /></div>
          <span className="phone-home-indicator" aria-hidden="true" />
        </div>
      </div>
    </div>
  </div>;
}
