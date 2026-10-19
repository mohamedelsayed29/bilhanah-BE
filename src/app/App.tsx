import { useState } from 'react';
import { ArrowLeftIcon, CheckIcon, ForkKnifeIcon, SparkleIcon } from '@phosphor-icons/react';
import { Dialog } from '../components/Dialog';
import { useLanguage } from '../lib/language';
import { Header } from '../features/marketing/components/Header';
import { Hero } from '../features/marketing/components/Hero';
import { CapabilityStrip, Features, HowItWorks } from '../features/marketing/components/Features';
import { Pricing } from '../features/marketing/components/Pricing';
import { FAQ } from '../features/marketing/components/FAQ';
import { Footer } from '../features/marketing/components/Footer';
import { DemoMenu } from '../features/marketing/components/DemoMenu';
import { plans } from '../features/marketing/data/plans';
import type { PlanId } from '../features/marketing/data/plans';

export function App() {
  const { language, text, number } = useLanguage();
  const [demoOpen, setDemoOpen] = useState(() => new URLSearchParams(location.search).get('demo') === '1');
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
  const selected = plans.find(plan => plan.id === selectedPlan);
  const openDemo = () => setDemoOpen(true);
  const start = () => setSelectedPlan('advanced');
  return <>
    <a className="skip-link" href="#main-content">{text('انتقل للمحتوى', 'Skip to content')}</a>
    <Header onStart={start} />
    <main id="main-content">
      <div className="hero-wrap"><Hero onStart={start} onDemo={openDemo} /></div>
      <CapabilityStrip />
      <Features onDemo={openDemo} />
      <HowItWorks />
      <Pricing onSelect={setSelectedPlan} />
      <FAQ />
      <Footer onStart={start} />
    </main>
    <Dialog open={demoOpen} onClose={() => setDemoOpen(false)} title={text('منيو بالهنا التجريبي', 'Bilhanah sample menu')} className="demo-dialog"><div className="demo-dialog-heading"><span className="small-icon"><ForkKnifeIcon size={20} /></span><div><h2>{text('حُط نفسك مكان زبونك.', 'Take a seat at your own table.')}</h2><p>{text('استكشف، اختار الحجم، وضيف للسلة. دي تجربة توضيحية بدون دفع.', 'Browse, choose a size, and add to your bag. A sample experience with no payment.')}</p></div></div><DemoMenu /></Dialog>
    <Dialog open={!!selected} onClose={() => setSelectedPlan(null)} title={text('تجربتك مع بالهنا', 'Your Bilhanah experience')} className="trial-dialog">
      {selected && <><span className="trial-icon"><SparkleIcon size={30} /></span><h2>{text('منيو مطعمك يبدأ من هنا.', 'Your next menu starts here.')}</h2><p>{text('٣٠ يوم تكتشف فيهم التجربة الكاملة، وبعدها تختار اللي يناسب مطعمك.', 'Explore the Full Experience for 30 days, then choose the plan that fits your restaurant.')}</p><div className="trial-plan"><div><small>{text('الباقة اللي اخترتها', 'Your selected plan')}</small><strong>{selected.name[language]}</strong></div><span>{number(selected.price)} {text('جنيه / شهر', 'EGP / month')}</span></div><ul className="trial-benefits"><li><CheckIcon size={18} />{text('منيو باسم مطعمك وQR خاص بيك', 'Your restaurant menu and personal QR')}</li><li><CheckIcon size={18} />{text('التجربة المجانية على الباقة الكاملة', 'Free trial on the Full Experience plan')}</li><li><CheckIcon size={18} />{text('من غير تجديد تلقائي', 'No automatic renewal')}</li></ul><div className="launch-notice" role="status">{text('إنشاء الحسابات هيتاح قريبًا. لحد ما نفتح التسجيل، تقدر تجرّب المنيو التفاعلي بالكامل.', 'Account registration is coming soon. In the meantime, explore the fully interactive sample menu.')}</div><button className="button button-teal" onClick={() => { setSelectedPlan(null); setDemoOpen(true); }}>{text('استكشف المنيو التجريبي', 'Explore the sample menu')}<ArrowLeftIcon className="directional-arrow" size={19} /></button></>}
    </Dialog>
  </>;
}
