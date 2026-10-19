import { BowlFoodIcon } from '@phosphor-icons/react';
import { useLanguage } from '../lib/language';

export function Brand({ inverse = false }: { inverse?: boolean }) {
  const { text } = useLanguage();
  return <a href="#" className={`brand ${inverse ? 'brand-inverse' : ''}`} aria-label={text('بالهنا، الصفحة الرئيسية', 'Bilhanah home')}>
    <span className="brand-symbol"><BowlFoodIcon size={30} weight="bold" /></span>
    <span className="brand-type"><strong lang="ar">بالهنا<span className="brand-dot">.</span></strong><span lang="en" dir="ltr">bilhanah</span></span>
  </a>;
}
