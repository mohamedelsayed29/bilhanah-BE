import { ArrowLeftIcon, CheckIcon, SparkleIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { plans } from '../data/plans';
import type { PlanId } from '../data/plans';

export function Pricing({ onSelect }: { onSelect: (id: PlanId) => void }) {
  const { language, text, number } = useLanguage();
  return <section id="pricing" className="pricing-section page-container section-space" aria-labelledby="pricing-title">
    <div className="section-heading"><h2 id="pricing-title">{text('على قد مطعمك.', 'Made for your restaurant.')}<span className="teal-text">{text('وعلى مزاجك.', 'And where it goes next.')}</span></h2><p>{text('ابدأ بمنيو، وكبّر التجربة وقت ما تحتاج. اختار الباقة اللي تناسبك.', 'Start with your menu. Add more when you need it. Choose the right fit for your restaurant.')}</p></div>
    <div className="pricing-context"><span><SparkleIcon size={17} />{text('٣٠ يوم تجربة مجانية للباقة الكاملة', '30 days free on the Full Experience plan')}</span><span>{text('اشتراك شهري، من غير تجديد تلقائي', 'Monthly plans. No automatic renewal.')}</span></div>
    <div className="pricing-grid">{plans.map(plan => <article className={`price-card ${plan.featured ? 'price-card-featured' : ''}`} key={plan.id}>
      {plan.featured && <span className="plan-highlight">{text('لمنيو بياخد طلبات', 'For menus that take orders')}</span>}
      <div className="plan-title"><h3>{plan.name[language]}</h3><p>{plan.subtitle[language]}</p></div>
      <div className="plan-price"><strong>{number(plan.price)}</strong><div><span>{text('جنيه', 'EGP')}</span><small>{text('/ شهريًا', '/ month')}</small></div></div>
      <button className={`button ${plan.featured ? 'button-ivory' : 'button-outline'}`} onClick={() => onSelect(plan.id)}>{text('ابدأ تجربتك', 'Start your trial')}<ArrowLeftIcon className="directional-arrow" size={18} /></button>
      <ul className="plan-features">{plan.features.map(feature => <li key={feature.en}><CheckIcon size={17} weight="bold" /><span>{feature[language]}</span></li>)}</ul>
      {plan.id === 'advanced' && <p className="device-note">{text('التنبيهات والاهتزاز حسب دعم الجهاز وإعداداته.', 'Alerts and vibration depend on device support and settings.')}</p>}
    </article>)}</div>
    <p className="pricing-footnote">{text('الدفع الإلكتروني أو التحويل اليدوي بعد المراجعة. الأسعار المعروضة مبدئية وقابلة للتعديل.', 'Pay electronically or by reviewed manual transfer. These are initial prices and may change.')}</p>
  </section>;
}
