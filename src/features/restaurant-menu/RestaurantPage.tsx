import { useEffect, useState } from 'react';
import { GlobeHemisphereWestIcon, MapPinIcon, PhoneIcon, StorefrontIcon } from '@phosphor-icons/react';
import { API_URL } from '../../lib/config';
import { useLanguage } from '../../lib/language';
import type { Language } from '../../lib/language';

// Mirrors PublicRestaurant in packages/contracts (this app is not in the npm workspace yet).
type PublicRestaurant =
  | { availability: 'AVAILABLE'; subdomain: string; name: string; defaultLanguage: Language; phone: string; city: string; address: string; whatsappNumber: string | null; websiteUrl: string | null; facebookUrl: string | null; instagramUrl: string | null }
  | { availability: 'TEMPORARILY_UNAVAILABLE'; subdomain: string; name: string; defaultLanguage: Language };

type State = { status: 'loading' } | { status: 'not-found' } | { status: 'error' } | { status: 'ready'; restaurant: PublicRestaurant };

export function RestaurantPage({ subdomain }: { subdomain: string }) {
  const { text, toggleLanguage, setLanguage, hasPreference } = useLanguage();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/v1/public/restaurants/${encodeURIComponent(subdomain)}`, { signal: controller.signal })
      .then(async response => {
        if (response.status === 404) return setState({ status: 'not-found' });
        if (!response.ok) return setState({ status: 'error' });
        const restaurant = await response.json() as PublicRestaurant;
        if (!hasPreference) setLanguage(restaurant.defaultLanguage);
        setState({ status: 'ready', restaurant });
      })
      .catch(error => { if (!controller.signal.aborted) { console.error(error); setState({ status: 'error' }); } });
    return () => controller.abort();
    // The visitor's language choice must not refetch the restaurant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomain]);

  return <main className="restaurant-page">
    <button className="language-button restaurant-language" onClick={toggleLanguage} aria-label={text('Switch to English', 'التبديل للعربية')}><GlobeHemisphereWestIcon size={18} /><span>{text('EN', 'عربي')}</span></button>
    <div className="restaurant-card">
      <span className="restaurant-mark"><StorefrontIcon size={26} /></span>
      {state.status === 'loading' && <p role="status">{text('جاري التحميل…', 'Loading…')}</p>}
      {state.status === 'error' && <p role="alert">{text('حصلت مشكلة. جرب تاني بعد شوية.', 'Something went wrong. Please try again shortly.')}</p>}
      {state.status === 'not-found' && <><h1>{text('المطعم ده مش موجود', 'Restaurant not found')}</h1><p>{text('اتأكد من اللينك أو امسح الـ QR تاني.', 'Check the link or scan the QR code again.')}</p></>}
      {state.status === 'ready' && state.restaurant.availability === 'TEMPORARILY_UNAVAILABLE' && <><h1>{state.restaurant.name}</h1><p>{text('المنيو مش متاح مؤقتًا. جرب تاني بعدين.', 'The menu is temporarily unavailable. Please check back later.')}</p></>}
      {state.status === 'ready' && state.restaurant.availability === 'AVAILABLE' && <>
        <h1>{state.restaurant.name}</h1>
        <ul className="restaurant-contact">
          <li><MapPinIcon size={18} />{state.restaurant.address}، {state.restaurant.city}</li>
          <li><PhoneIcon size={18} /><a href={`tel:${state.restaurant.phone}`} dir="ltr">{state.restaurant.phone}</a></li>
        </ul>
        <p className="restaurant-note">{text('المنيو بيتجهز، وهيظهر هنا قريب.', 'The menu is being prepared and will appear here soon.')}</p>
      </>}
    </div>
  </main>;
}
