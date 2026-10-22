import { ArrowLeftIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { usePageTitle, useLanguage } from '../../../lib/language';
import { PageHero } from '../components/PageHero';

export function NotFoundPage() {
  const { text } = useLanguage();
  usePageTitle('الصفحة مش موجودة | بالهنا', 'Page not found | Bilhanah');
  return <PageHero
    eyebrow="404"
    title={<>{text('الطبق ده', 'This dish')} <em>{text('مش في المنيو.', 'isn’t on the menu.')}</em></>}
    lead={text('الصفحة اللي بتدور عليها مش موجودة أو اتنقلت. ارجع للرئيسية أو كلّمنا لو محتاج مساعدة.', 'The page you’re looking for doesn’t exist or has moved. Head home, or contact us if you need a hand.')}
  >
    <div className="page-hero-actions">
      <Link className="button button-guava" to="/">{text('الصفحة الرئيسية', 'Back to home')}<ArrowLeftIcon className="directional-arrow" size={18} /></Link>
      <Link className="button page-hero-outline" to="/contact">{text('تواصل معانا', 'Contact us')}</Link>
    </div>
  </PageHero>;
}
