import { useEffect, useState } from 'react';
import { Outlet, useLocation, useOutletContext } from 'react-router';
import { ArrowLeftIcon, CheckIcon } from '@phosphor-icons/react';
import { Dialog } from '../components/Dialog';
import { DASHBOARD_URL } from '../lib/config';
import { useLanguage } from '../lib/language';
import { Header } from '../features/marketing/components/Header';
import { Footer } from '../features/marketing/components/Footer';
import { DemoShowcase } from '../features/marketing/components/DemoShowcase';
import { plans } from '../features/marketing/data/plans';
import type { PlanId } from '../features/marketing/data/plans';

export type SiteActions = { start: () => void; openDemo: () => void; selectPlan: (plan: PlanId) => void };

/** Actions shared by every marketing page: open the trial dialog, the sample menu, or a specific plan. */
export function useSiteActions() {
  return useOutletContext<SiteActions>();
}

/** Route changes start at the top of the page; links with a hash scroll to that section once it renders. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) { window.scrollTo(0, 0); return; }
    const frame = requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);
  return null;
}

export function SiteLayout() {
  const { language, text, number } = useLanguage();
  const [demoOpen, setDemoOpen] = useState(() => new URLSearchParams(location.search).get('demo') === '1');
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
  const selected = plans.find(plan => plan.id === selectedPlan);
  const openDemo = () => setDemoOpen(true);
  const start = () => setSelectedPlan('advanced');
  return <>
    <a className="skip-link" href="#main-content">{text('انتقل للمحتوى', 'Skip to content')}</a>
    <Header onStart={start} />
    <ScrollManager />
    <main id="main-content">
      <Outlet context={{ start, openDemo, selectPlan: setSelectedPlan } satisfies SiteActions} />
      <Footer onStart={start} />
    </main>
    <Dialog open={demoOpen} onClose={() => setDemoOpen(false)} title={text('منيو بالهنا التجريبي', 'Bilhanah sample menu')} className="demo-dialog"><DemoShowcase /></Dialog>
    <Dialog open={!!selected} onClose={() => setSelectedPlan(null)} title={text('تجربتك مع بالهنا', 'Your Bilhanah experience')} className="trial-dialog">
      {selected && <><span className="trial-icon"><img src="/brand/bilhanah-mark.svg" alt="" width="445" height="479" /></span><h2>{text('منيو مطعمك يبدأ من هنا.', 'Your next menu starts here.')}</h2><p>{text('٣٠ يوم تكتشف فيهم التجربة الكاملة، وبعدها تختار اللي يناسب مطعمك.', 'Explore the Full Experience for 30 days, then choose the plan that fits your restaurant.')}</p><div className="trial-plan"><div><small>{text('الباقة اللي اخترتها', 'Your selected plan')}</small><strong>{selected.name[language]}</strong></div><span>{number(selected.price)} {text('جنيه / شهر', 'EGP / month')}</span></div><ul className="trial-benefits"><li><CheckIcon size={18} />{text('منيو باسم مطعمك وQR خاص بيك', 'Your restaurant menu and personal QR')}</li><li><CheckIcon size={18} />{text('التجربة المجانية على الباقة الكاملة', 'Free trial on the Full Experience plan')}</li><li><CheckIcon size={18} />{text('من غير تجديد تلقائي', 'No automatic renewal')}</li></ul>{DASHBOARD_URL
        ? <div className="trial-actions"><a className="button button-teal" href={`${DASHBOARD_URL}/register`}>{text('أنشئ حسابك مجانًا', 'Create your free account')}<ArrowLeftIcon className="directional-arrow" size={19} /></a><button className="button button-outline" onClick={() => { setSelectedPlan(null); setDemoOpen(true); }}>{text('استكشف المنيو التجريبي', 'Explore the sample menu')}</button></div>
        : <><div className="launch-notice" role="status">{text('إنشاء الحسابات هيتاح قريبًا. لحد ما نفتح التسجيل، تقدر تجرّب المنيو التفاعلي بالكامل.', 'Account registration is coming soon. In the meantime, explore the fully interactive sample menu.')}</div><button className="button button-teal" onClick={() => { setSelectedPlan(null); setDemoOpen(true); }}>{text('استكشف المنيو التجريبي', 'Explore the sample menu')}<ArrowLeftIcon className="directional-arrow" size={19} /></button></>}
    </>}
    </Dialog>
  </>;
}
