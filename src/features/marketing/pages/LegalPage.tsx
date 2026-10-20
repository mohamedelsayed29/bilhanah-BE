import { Link } from 'react-router';
import { usePageTitle, useLanguage } from '../../../lib/language';
import { PageHero } from '../components/PageHero';
import { legalDocuments } from '../data/legal';
import type { LegalDocumentId } from '../data/legal';

export function LegalPage({ document: id }: { document: LegalDocumentId }) {
  const { language, text } = useLanguage();
  const doc = legalDocuments[id];
  const other = id === 'privacy' ? { to: '/terms', label: text('شروط الاستخدام', 'Terms of service') } : { to: '/privacy', label: text('سياسة الخصوصية', 'Privacy policy') };
  const updated = new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'long' }).format(new Date(doc.updated));
  usePageTitle(`${doc.title.ar} | بالهنا`, `${doc.title.en} | Bilhanah`);
  return <>
    <PageHero compact eyebrow={text('قانوني', 'Legal')} title={doc.title[language]} lead={doc.intro[language]}>
      <p className="page-meta">{text('آخر تحديث:', 'Last updated:')} <time dateTime={doc.updated}>{updated}</time></p>
    </PageHero>
    <div className="page-container section-space legal-layout">
      <nav className="legal-toc" aria-label={text('محتويات الصفحة', 'On this page')}>
        <h2>{text('المحتويات', 'Contents')}</h2>
        <ol>{doc.sections.map(section => <li key={section.id}><a href={`#${section.id}`}>{section.title[language]}</a></li>)}</ol>
        <Link className="legal-other" to={other.to}>{other.label}</Link>
      </nav>
      <article className="legal-article">
        {doc.sections.map((section, index) => <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
          <h2 id={`${section.id}-title`}><span>{String(index + 1).padStart(2, '0')}</span>{section.title[language]}</h2>
          {section.body[language].map((block, blockIndex) => Array.isArray(block)
            ? <ul key={blockIndex}>{block.map(item => <li key={item}>{item}</li>)}</ul>
            : <p key={blockIndex}>{block}</p>)}
        </section>)}
        <aside className="legal-contact">
          <p>{text('عندك سؤال عن الصفحة دي؟', 'Questions about this page?')}</p>
          <Link className="text-link" to="/contact">{text('تواصل معانا', 'Contact us')}</Link>
        </aside>
      </article>
    </div>
  </>;
}
