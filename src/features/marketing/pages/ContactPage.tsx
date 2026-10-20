import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeftIcon, ChatCircleDotsIcon, EnvelopeSimpleIcon, ForkKnifeIcon, PaperPlaneTiltIcon, QuestionIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { useSiteActions } from '../../../app/SiteLayout';
import { CONTACT_EMAIL, CONTACT_WHATSAPP } from '../../../lib/config';
import { usePageTitle, useLanguage } from '../../../lib/language';
import { PageHero } from '../components/PageHero';

type Topic = 'subscription' | 'support' | 'partnership' | 'other';

export function ContactPage() {
  const { text } = useLanguage();
  const { openDemo } = useSiteActions();
  const [opened, setOpened] = useState(false);
  usePageTitle('تواصل معانا | بالهنا', 'Contact | Bilhanah');
  const topics: { id: Topic; label: string }[] = [
    { id: 'subscription', label: text('الاشتراك والباقات', 'Plans and subscriptions') },
    { id: 'support', label: text('مساعدة في الحساب', 'Help with my account') },
    { id: 'partnership', label: text('شراكة أو تعاون', 'Partnership') },
    { id: 'other', label: text('حاجة تانية', 'Something else') },
  ];

  // There is no contact endpoint yet, so the message is handed to the visitor's own email app, ready to send.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const topic = topics.find(item => item.id === value('topic'))?.label ?? '';
    const lines = [
      `${text('الاسم', 'Name')}: ${value('name')}`,
      `${text('المطعم', 'Restaurant')}: ${value('restaurant') || '-'}`,
      `${text('التليفون', 'Phone')}: ${value('phone') || '-'}`,
      '',
      value('message'),
    ];
    const subject = `${text('بالهنا', 'Bilhanah')} · ${topic}`;
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
    setOpened(true);
  };

  return <>
    <PageHero
      eyebrow={text('تواصل معانا', 'Contact us')}
      title={<>{text('عندك سؤال؟', 'Got a question?')} <em>{text('إحنا هنا.', 'We’re here.')}</em></>}
      lead={text('سواء بتفكر تبدأ، أو محتاج مساعدة في حسابك، أو عندك فكرة تعاون. ابعتلنا وهنرد عليك في أقرب وقت.', 'Whether you are about to start, need help with your account, or have a partnership in mind, write to us and we’ll get back to you soon.')}
    />

    <section className="page-container section-space contact-layout" aria-label={text('طرق التواصل', 'Ways to reach us')}>
      <div className="contact-channels">
        <a className="channel-card" href={`mailto:${CONTACT_EMAIL}`}>
          <span className="channel-icon"><EnvelopeSimpleIcon size={24} /></span>
          <span className="channel-copy"><strong>{text('ابعتلنا إيميل', 'Email us')}</strong><span dir="ltr">{CONTACT_EMAIL}</span></span>
          <ArrowLeftIcon className="directional-arrow channel-arrow" size={18} />
        </a>
        {CONTACT_WHATSAPP && <a className="channel-card" href={`https://wa.me/${CONTACT_WHATSAPP}`} target="_blank" rel="noreferrer">
          <span className="channel-icon"><ChatCircleDotsIcon size={24} /></span>
          <span className="channel-copy"><strong>{text('كلّمنا واتساب', 'Message us on WhatsApp')}</strong><span dir="ltr">+{CONTACT_WHATSAPP}</span></span>
          <ArrowLeftIcon className="directional-arrow channel-arrow" size={18} />
        </a>}
        <button className="channel-card" onClick={openDemo}>
          <span className="channel-icon"><ForkKnifeIcon size={24} /></span>
          <span className="channel-copy"><strong>{text('جرّب المنيو التجريبي', 'Try the sample menu')}</strong><span>{text('شوف بالهنا من مكان زبونك', 'See Bilhanah from your guest’s seat')}</span></span>
          <ArrowLeftIcon className="directional-arrow channel-arrow" size={18} />
        </button>
        <Link className="channel-card" to="/#faq">
          <span className="channel-icon"><QuestionIcon size={24} /></span>
          <span className="channel-copy"><strong>{text('الأسئلة الشائعة', 'Frequently asked questions')}</strong><span>{text('يمكن إجابتك موجودة هنا', 'Your answer may already be here')}</span></span>
          <ArrowLeftIcon className="directional-arrow channel-arrow" size={18} />
        </Link>
      </div>

      <form className="contact-form" onSubmit={onSubmit}>
        <div className="contact-form-heading">
          <h2>{text('ابعتلنا رسالة', 'Send us a message')}</h2>
          <p>{text('اكتب رسالتك، وهتتفتح جاهزة في تطبيق الإيميل عندك.', 'Write your message and it will open, ready to send, in your email app.')}</p>
        </div>
        <div className="contact-grid">
          <label className="contact-field"><span>{text('اسمك', 'Your name')}</span><input name="name" autoComplete="name" required /></label>
          <label className="contact-field"><span>{text('اسم المطعم', 'Restaurant name')} <small>{text('(اختياري)', '(optional)')}</small></span><input name="restaurant" autoComplete="organization" /></label>
          <label className="contact-field"><span>{text('رقم التليفون', 'Phone number')} <small>{text('(اختياري)', '(optional)')}</small></span><input name="phone" type="tel" autoComplete="tel" dir="ltr" /></label>
          <label className="contact-field"><span>{text('الموضوع', 'Topic')}</span><select name="topic" defaultValue="subscription">{topics.map(topic => <option key={topic.id} value={topic.id}>{topic.label}</option>)}</select></label>
          <label className="contact-field contact-field-wide"><span>{text('رسالتك', 'Your message')}</span><textarea name="message" rows={5} required /></label>
        </div>
        <div className="contact-submit">
          <button type="submit" className="button button-teal">{text('جهّز الرسالة', 'Prepare message')}<PaperPlaneTiltIcon size={18} /></button>
          {opened && <p role="status">{text(`لو تطبيق الإيميل ما اتفتحش، ابعتلنا مباشرةً على ${CONTACT_EMAIL}`, `If your email app didn’t open, write to us directly at ${CONTACT_EMAIL}`)}</p>}
        </div>
      </form>
    </section>
  </>;
}
