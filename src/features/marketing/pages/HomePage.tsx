import { useSiteActions } from '../../../app/SiteLayout';
import { usePageTitle } from '../../../lib/language';
import { Hero } from '../components/Hero';
import { CapabilityStrip, Features, HowItWorks } from '../components/Features';
import { Pricing } from '../components/Pricing';
import { FAQ } from '../components/FAQ';
import { NfcStands } from '../components/NfcStands';

export function HomePage() {
  const { start, openDemo, selectPlan } = useSiteActions();
  usePageTitle('بالهنا | منيو يفتح النفس', 'Bilhanah | A menu worth opening');
  return <>
    <div className="hero-wrap"><Hero onStart={start} onDemo={openDemo} /></div>
    <CapabilityStrip />
    <Features onDemo={openDemo} />
    <NfcStands />
    <HowItWorks />
    <Pricing onSelect={selectPlan} />
    <FAQ />
  </>;
}
