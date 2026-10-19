import { ArrowLeftIcon, BowlFoodIcon } from '@phosphor-icons/react';
import { Brand } from '../../../components/Brand';
import { useLanguage } from '../../../lib/language';

export function Footer({ onStart }: { onStart: () => void }) {
  const { text } = useLanguage();
  return <>
    <section className="closing-section" aria-labelledby="closing-title"><div className="page-container closing-inner"><div><h2 id="closing-title">{text('سيب انطباع حلو.', 'Make a delicious impression.')}<span>{text('من قبل أول لقمة.', 'Before the very first bite.')}</span></h2><p>{text('إنت ركّز في الأكل والضيافة. وإحنا نسهّل حكاية المنيو.', 'You focus on the food and the welcome. We’ll help with the menu.')}</p></div><div className="closing-action"><BowlFoodIcon size={76} weight="light" /><button className="button button-guava" onClick={onStart}>{text('منيو مطعمك يبدأ من هنا', 'Your next menu starts here')}<ArrowLeftIcon className="directional-arrow" size={20} /></button><span>{text('٣٠ يوم مجانًا. خد وقتك وجرّب.', '30 days free. Make yourself at home.')}</span></div></div></section>
    <footer className="site-footer page-container"><div className="footer-main"><Brand /><p>{text('تكنولوجيا على ذوق الضيافة.', 'Technology with a taste for hospitality.')}</p><nav aria-label={text('روابط التذييل', 'Footer navigation')}><a href="#features">{text('المميزات', 'Features')}</a><a href="#pricing">{text('الباقات', 'Plans')}</a><a href="#faq">{text('الأسئلة الشائعة', 'FAQ')}</a></nav></div><div className="footer-bottom"><span>{text('© ٢٠٢٦ بالهنا. كل الحقوق محفوظة.', '© 2026 Bilhanah. All rights reserved.')}</span><span>{text('معمول بحُب، للمطاعم اللي بتحب شغلها.', 'Made with care, for people who care about food.')}</span></div></footer>
  </>;
}
