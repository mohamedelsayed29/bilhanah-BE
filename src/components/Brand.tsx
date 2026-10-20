import { Link } from 'react-router';
import { useLanguage } from '../lib/language';

export function Brand({ inverse = false }: { inverse?: boolean }) {
  const { text } = useLanguage();
  return <Link to="/" className={`brand ${inverse ? 'brand-inverse' : ''}`} aria-label={text('بالهنا، الصفحة الرئيسية', 'Bilhanah home')}>
    <span className="brand-art"><img src={inverse ? '/brand/bilhanah-logo-light.svg' : '/brand/bilhanah-logo.svg'} alt="Bilhanah | بالهنا" width="1507" height="479" decoding="async" /></span>
  </Link>;
}
