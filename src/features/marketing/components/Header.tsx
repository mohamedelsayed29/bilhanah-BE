import { useState } from 'react';
import { ArrowUpLeftIcon, GlobeHemisphereWestIcon, ListIcon, XIcon } from '@phosphor-icons/react';
import { Brand } from '../../../components/Brand';
import { useLanguage } from '../../../lib/language';

export function Header({ onStart }: { onStart: () => void }) {
  const { text, toggleLanguage } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = [
    { href: '#features', title: text('ليه بالهنا؟', 'Why Bilhanah?') },
    { href: '#how-it-works', title: text('بتشتغل إزاي؟', 'How it works') },
    { href: '#pricing', title: text('الباقات والأسعار', 'Plans & pricing') },
    { href: '#faq', title: text('أسئلة شائعة', 'FAQ') },
  ];
  return <header className="site-header">
    <div className="header-inner">
      <Brand />
      <nav id="main-navigation" aria-label={text('التنقل الرئيسي', 'Main navigation')} className={menuOpen ? 'navigation is-open' : 'navigation'} onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false); }}>
        {links.map(link => <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>{link.title}</a>)}
      </nav>
      <div className="header-actions">
        <button className="language-button" onClick={toggleLanguage} aria-label={text('Switch to English', 'التبديل للعربية')}><GlobeHemisphereWestIcon size={18} /><span>{text('EN', 'عربي')}</span></button>
        <button className="button button-teal header-trial" onClick={onStart}>{text('ابدأ مجانًا', 'Start for free')}<ArrowUpLeftIcon className="directional-arrow" size={17} /></button>
        <button className="icon-button menu-toggle" onClick={() => setMenuOpen(value => !value)} aria-label={text(menuOpen ? 'إغلاق القائمة' : 'فتح القائمة', menuOpen ? 'Close menu' : 'Open menu')} aria-expanded={menuOpen} aria-controls="main-navigation">{menuOpen ? <XIcon size={25} /> : <ListIcon size={25} />}</button>
      </div>
    </div>
  </header>;
}
