import { ArrowLeftIcon, GlobeHemisphereWestIcon, HandHeartIcon, LayoutIcon, LinkSimpleIcon, QrCodeIcon, ReceiptIcon, ShieldCheckIcon, SparkleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { useSiteActions } from '../../../app/SiteLayout';
import { usePageTitle, useLanguage } from '../../../lib/language';
import { PageHero } from '../components/PageHero';

export function AboutPage() {
  const { text } = useLanguage();
  const { openDemo } = useSiteActions();
  usePageTitle('عن بالهنا | بالهنا', 'About | Bilhanah');
  const values = [
    { icon: HandHeartIcon, title: text('الضيافة الأول', 'Hospitality first'), body: text('كل قرار بناخده بنسأل فيه: ده هيخلّي تجربة الضيف أحلى؟ ولا هيخلّي شغل المطعم أسهل؟', 'Every decision starts with one question: does this make the guest’s visit better, or the restaurant’s work easier?') },
    { icon: SparkleIcon, title: text('البساطة', 'Simplicity'), body: text('من غير تدريب ولا أجهزة جديدة. لو بتعرف تستخدم موبايلك، هتعرف تدير منيو مطعمك.', 'No training, no new hardware. If you can use your phone, you can run your menu.') },
    { icon: ReceiptIcon, title: text('الوضوح', 'Clarity'), body: text('سعر شهري واضح بالجنيه، من غير رسوم مخفية ومن غير تجديد تلقائي. إنت اللي بتقرر.', 'A clear monthly price in EGP, with no hidden fees and no automatic renewal. You stay in control.') },
    { icon: ShieldCheckIcon, title: text('خصوصية مطعمك', 'Your data, protected'), body: text('بيانات كل مطعم منفصلة تمامًا عن غيره، ومش بنبيعها ولا بنستخدمها في إعلانات.', 'Each restaurant’s data is fully isolated. We never sell it or use it for advertising.') },
  ];
  const includes = [
    { icon: LinkSimpleIcon, title: text('عنوان باسم مطعمك', 'Your own address'), body: text('صفحة منيو على لينك خاص بيك، زي restaurant.bilhanah.com.', 'A menu page at your own link, like restaurant.bilhanah.com.') },
    { icon: QrCodeIcon, title: text('QR جاهز للطباعة', 'A print-ready QR'), body: text('بيتعمل لوحده أول ما تجهّز مطعمك. اطبعه مرة واحدة، والمنيو يتحدث على طول.', 'Generated as soon as you set up. Print it once; the menu stays up to date.') },
    { icon: LayoutIcon, title: text('لوحة تحكم واحدة', 'One dashboard'), body: text('الأطباق، والأسعار، والأحجام، والطلبات، والاشتراك. كله في مكان واحد.', 'Dishes, prices, sizes, orders, and your subscription, all in one place.') },
    { icon: GlobeHemisphereWestIcon, title: text('عربي وإنجليزي', 'Arabic and English'), body: text('المنيو واللوحة بلغتين بنفس الجودة، وكل زبون يختار لغته.', 'The menu and dashboard work equally well in both languages, and every guest picks theirs.') },
  ];
  return <>
    <PageHero
      eyebrow={text('عن بالهنا', 'About Bilhanah')}
      title={<>{text('بنبني المنيو اللي', 'We build the menu')} <em>{text('مطعمك يستاهله.', 'your restaurant deserves.')}</em></>}
      lead={text('بالهنا منصة منيو رقمي معمولة للمطاعم والكافيهات في مصر: منيو بلغتين على موبايل الزبون، وطلبات من الترابيزة، وتنبيه أول ما الطلب يجهز.', 'Bilhanah is a digital-menu platform made for restaurants and cafés in Egypt: a bilingual menu on every guest’s phone, orders from the table, and an alert the moment food is ready.')}
    />

    <section className="page-container section-space about-story" aria-labelledby="story-title">
      <figure className="about-story-media">
        <img src="/media/hero-live-menu.jpg" width="1280" height="720" loading="lazy" decoding="async" alt={text('زبون بيتصفح منيو رقمي على موبايله.', 'A guest browsing a digital menu on their phone.')} />
      </figure>
      <div className="about-story-copy">
        <span className="section-kicker">{text('الحكاية', 'Our story')}</span>
        <h2 id="story-title">{text('المنيو المطبوع بيقدم أسرع من ما تتوقع.', 'Printed menus age faster than you think.')}</h2>
        <p>{text('سعر يتغير، طبق يخلص، صنف جديد يتضاف. وكل تعديل معناه طباعة جديدة، أو منيو عليه شطب وتصحيح بالقلم. وفي نفس الوقت، الزبون عايز يشوف الأكل قبل ما يطلبه، ويعرف كل حجم بسعره من غير ما يستنى حد.', 'A price changes, a dish sells out, something new joins the menu. Every edit means a new print run or a menu covered in corrections. Meanwhile, guests want to see the food before they order and know every size and price without waiting for someone.')}</p>
        <p>{text('عشان كده عملنا بالهنا: منيو حي على موبايل الزبون، إنت بتتحكم فيه من لوحة واحدة، وأي تعديل بيوصل في نفس اللحظة.', 'So we built Bilhanah: a living menu on every guest’s phone, managed from one dashboard, where every change goes live instantly.')}</p>
        <button className="text-link" onClick={openDemo}>{text('جرّب المنيو بنفسك', 'Try the menu yourself')}<ArrowLeftIcon className="directional-arrow" size={17} /></button>
      </div>
    </section>

    <section className="about-mission" aria-labelledby="mission-title">
      <div className="page-container">
        <span className="section-kicker">{text('مهمتنا', 'Our mission')}</span>
        <h2 id="mission-title">{text('نخلّي التكنولوجيا تخدم الضيافة، مش العكس.', 'Technology that serves hospitality, not the other way around.')}</h2>
        <p>{text('إنت ركّز في الأكل والناس اللي بتستقبلهم. وإحنا نتكفّل إن المنيو يكون واضح، وشهي، وفي إيد كل زبون.', 'You focus on the food and the people you welcome. We make sure the menu is clear, appetising, and in every guest’s hand.')}</p>
      </div>
    </section>

    <section className="page-container section-space" aria-labelledby="values-title">
      <div className="section-heading">
        <h2 id="values-title">{text('اللي بنآمن بيه', 'What we stand for')}</h2>
        <p>{text('أربع حاجات بنرجعلها في كل تفصيلة بنبنيها.', 'Four principles we return to in every detail we build.')}</p>
      </div>
      <div className="values-grid">{values.map(({ icon: Icon, title, body }) => <article key={title} className="value-card">
        <span className="value-icon"><Icon size={24} /></span>
        <h3>{title}</h3>
        <p>{body}</p>
      </article>)}</div>
    </section>

    <section className="about-includes" aria-labelledby="includes-title">
      <div className="page-container">
        <div className="about-includes-heading">
          <span className="section-kicker">{text('مع كل اشتراك', 'With every subscription')}</span>
          <h2 id="includes-title">{text('كل مطعم بياخد بيته الرقمي.', 'Every restaurant gets a digital home.')}</h2>
          <Link className="button button-teal" to="/#pricing">{text('شوف الباقات', 'See the plans')}<ArrowLeftIcon className="directional-arrow" size={18} /></Link>
        </div>
        <ol className="includes-list">{includes.map(({ icon: Icon, title, body }, index) => <li key={title}>
          <span className="includes-index">{String(index + 1).padStart(2, '0')}</span>
          <Icon size={26} className="includes-icon" />
          <div><h3>{title}</h3><p>{body}</p></div>
        </li>)}</ol>
      </div>
    </section>
  </>;
}
