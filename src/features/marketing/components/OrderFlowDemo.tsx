import { useEffect, useReducer, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowCounterClockwiseIcon, BatteryFullIcon, BellRingingIcon, BowlFoodIcon, CellSignalFullIcon, CheckIcon, ChefHatIcon, CircleNotchIcon, LockSimpleIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon, ReceiptIcon, ShoppingBagIcon, WifiHighIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { menuItems, type Category } from '../data/menu';
import './order-flow.css';

type FlowState = { beat: number; category: Category; cart: Record<string, number> };
type Action = { type: 'next' | 'reset' | 'cart' | 'confirm' } | { type: 'category'; category: Category } | { type: 'quantity'; id: string; delta: number };
const initial: FlowState = { beat: 0, category: 'all', cart: {} };
const durations = [2400, 1800, 2000, 3000, 1200, 2400, 3800, 6000];

function reducer(state: FlowState, action: Action): FlowState {
  switch (action.type) {
    case 'reset': return initial;
    case 'next':
      if (state.beat === 7) return initial;
      return { ...state, beat: state.beat + 1, ...(state.beat === 0 ? { category: 'mains' as Category } : {}), ...(state.beat === 1 ? { cart: { burger: 1 } } : {}) };
    case 'category': return { ...state, category: action.category };
    case 'quantity': return { ...state, cart: { ...state.cart, [action.id]: Math.max(0, (state.cart[action.id] ?? 0) + action.delta) } };
    case 'cart': return { ...state, beat: state.beat === 3 ? 2 : 3 };
    case 'confirm': return { ...state, beat: 4 };
  }
}

/** A local, self-running order story. It never submits an order or requests payment. */
export function OrderFlowDemo() {
  const { language, text, number } = useLanguage();
  const [state, dispatch] = useReducer(reducer, initial);
  const [automatic, setAutomatic] = useState(true);
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = useRef<HTMLDivElement>(null);
  const interacted = useRef(false);
  const notified = useRef(false);
  const { beat, cart, category } = state;
  const submitted = beat >= 4;
  const running = visible && pageVisible && !paused && (automatic || submitted);
  const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const total = menuItems.reduce((sum, item) => sum + item.price * (cart[item.id] ?? 0), 0);
  const step = beat < 3 ? 0 : beat < 5 ? 1 : beat < 7 ? 2 : 3;
  const captions = [
    text('افتح المنيو واختار اللي على مزاجك', 'Open the menu. Find your favorite.'),
    text('كل قسم يوصّلك لأكلتك أسرع', 'Pick a category to find your dish.'),
    text('أكلتك في السلة، جاهز تطلب؟', 'In your bag. Ready to order?'),
    text('راجع طلبك وأكّده من مكانك', 'Review your bag and confirm.'),
    text('طلبك بيوصل للمطعم', 'Your order is reaching the kitchen.'),
    text('المطعم استلم طلبك', 'The kitchen has your order.'),
    text('الشيف بيجهّز أكلتك', 'The chef is preparing your food.'),
    text('اهتزاز وإشعار… طلبك جاهز. بالهنا!', 'A buzz, a notification… ready. Enjoy!'),
  ];

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.35 });
    if (root.current) observer.observe(root.current);
    const visibility = () => setPageVisible(!document.hidden);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => { setReduced(media.matches); if (media.matches) setPaused(true); };
    document.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', preference);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', preference); };
  }, []);

  useEffect(() => {
    if (!running || (!automatic && beat === 7)) return;
    const timer = window.setTimeout(() => dispatch({ type: 'next' }), durations[beat]);
    return () => window.clearTimeout(timer);
  }, [running, automatic, beat]);

  useEffect(() => {
    if (beat !== 7) { notified.current = false; return; }
    if (!notified.current && interacted.current && !reduced && visible && pageVisible && !paused) {
      notified.current = true;
      navigator.vibrate?.([100, 60, 100]);
    }
  }, [beat, reduced, visible, pageVisible, paused]);

  function act(action: Action) {
    interacted.current = true;
    setAutomatic(false);
    setPaused(false);
    dispatch(action);
  }
  function replay() { interacted.current = true; dispatch({ type: 'reset' }); setAutomatic(true); setPaused(false); }

  return <div className="order-flow" ref={root} data-beat={beat} data-running={running}>
    <div className={`order-phone ${beat === 7 ? 'order-phone-ready' : ''}`} style={{ animationPlayState: running ? 'running' : 'paused' }}>
      <span className="phone-button phone-button-action" aria-hidden="true" />
      <span className="phone-button phone-button-volume-up" aria-hidden="true" />
      <span className="phone-button phone-button-volume-down" aria-hidden="true" />
      <span className="phone-button phone-button-power" aria-hidden="true" />
      <div className="order-phone-screen">
        <div className="order-phone-status" dir="ltr" aria-hidden="true"><span>9:41</span><span className="order-island"><i /></span><span className="order-status-icons"><CellSignalFullIcon size={12} weight="fill" /><WifiHighIcon size={13} weight="bold" /><BatteryFullIcon size={19} weight="fill" /></span></div>
        <div className="order-browser"><LockSimpleIcon size={10} /><span>olivehouse.bilhanah.com</span></div>
        <div className="order-display">
          <header className="order-restaurant"><span className="order-restaurant-mark"><BowlFoodIcon size={24} weight="duotone" /></span><div><strong>{text('بيت الزيتون', 'Olive House')}</strong><small>{text('أكل معمول بحُب', 'Made with love')}</small></div><span>{text('ترابيزة ٠٨', 'Table 08')}</span></header>
          {beat < 3 ? <div className="order-menu-view">
            <div className="order-cover"><img src="/media/ready.jpg" alt="" width="800" height="450" loading="lazy" /><span>{text('اختار مزاجك النهارده.', 'What are you craving?')}</span></div>
            <div className="order-categories" role="group" aria-label={text('أقسام العرض التوضيحي', 'Walkthrough categories')}>{(['all', 'mains', 'pasta', 'light'] as Category[]).map((id, index) => <button key={id} aria-pressed={category === id} className={`${category === id ? 'selected' : ''} ${automatic && beat === 1 && id === 'mains' ? 'order-tap' : ''}`} onClick={() => act({ type: 'category', category: id })}>{[text('الكل', 'All'), text('رئيسي', 'Mains'), text('باستا', 'Pasta'), text('خفيف', 'Light')][index]}</button>)}</div>
            <div className="order-dishes">{menuItems.filter(item => category === 'all' || item.category === category).map(item => <article key={item.id} className="order-dish"><img src={item.image} alt={item.name[language]} width="64" height="64" loading="lazy" /><div><h3>{item.name[language]}</h3><p>{item.description[language]}</p><strong>{number(item.price)} <small>{text('ج.م', 'EGP')}</small></strong></div><button className={automatic && beat === 2 ? 'order-tap added' : ''} onClick={() => act({ type: 'quantity', id: item.id, delta: 1 })} aria-label={text(`أضف ${item.name.ar}`, `Add ${item.name.en}`)}>{cart[item.id] ? <span>{number(cart[item.id])}</span> : <PlusIcon size={16} />}</button></article>)}</div>
            {beat === 2 && automatic && <p className="order-added"><CheckIcon size={14} />{text('برجر البيت اتضاف للسلة', 'House burger added to your bag')}</p>}
            <button className="order-primary order-bag" onClick={() => act({ type: 'cart' })}><ShoppingBagIcon size={17} /><span>{count ? text(`عرض السلة (${number(count)})`, `View bag (${number(count)})`) : text('اختار أكلة وابدأ طلبك', 'Pick a dish to get started')}</span><strong>{number(total)} <small>{text('ج.م', 'EGP')}</small></strong></button>
          </div> : beat === 3 ? <section className="order-cart order-view" aria-label={text('مراجعة الطلب التجريبي', 'Review sample order')}>
            <button className="order-back" onClick={() => act({ type: 'cart' })}><ArrowLeftIcon size={14} className="directional-arrow" />{text('رجوع للمنيو', 'Back to menu')}</button><h3>{text('طلبك على ذوقك', 'Your order, your way')}</h3><p>{text('راجع أكلتك قبل ما نبدأ نجهّزها.', 'A quick look before we start cooking.')}</p>
            <div className="order-cart-lines">{count ? menuItems.filter(item => cart[item.id] > 0).map(item => <div className="order-cart-line" key={item.id}><img src={item.image} alt="" width="48" height="48" /><div><strong>{item.name[language]}</strong><small>{number(item.price * cart[item.id])} {text('ج.م', 'EGP')}</small><div className="order-quantity"><button aria-label={text(`تقليل ${item.name.ar}`, `Remove one ${item.name.en}`)} onClick={() => act({ type: 'quantity', id: item.id, delta: -1 })}><MinusIcon size={12} /></button><span>{number(cart[item.id])}</span><button aria-label={text(`زيادة ${item.name.ar}`, `Add one ${item.name.en}`)} onClick={() => act({ type: 'quantity', id: item.id, delta: 1 })}><PlusIcon size={12} /></button></div></div></div>) : <p>{text('السلة فاضية. ارجع اختار أكلتك.', 'Your bag is empty. Pick a dish first.')}</p>}</div>
            <div className="order-table"><ReceiptIcon size={17} /><span>{text('على الترابيزة', 'Dine in')}</span><strong>{text('ترابيزة ٠٨', 'Table 08')}</strong></div>
            <div className="order-total"><span>{text('الإجمالي', 'Total')}</span><strong>{number(total)} {text('ج.م', 'EGP')}</strong></div>
            <button className={`order-primary ${automatic ? 'order-tap' : ''}`} disabled={!count} onClick={() => act({ type: 'confirm' })}>{text('تأكيد الطلب', 'Confirm order')}<ArrowLeftIcon size={17} className="directional-arrow" /></button>
            <small className="order-demo-note">{text('طلب تجريبي · بدون دفع', 'Sample order · No payment')}</small>
          </section> : <section className={`order-tracking order-view ${beat === 7 ? 'is-ready' : ''}`} aria-label={text('حالة الطلب التجريبي', 'Sample order status')}>
            <div className="order-state-icon">{beat === 4 ? <span className="order-spinner"><CircleNotchIcon size={32} /></span> : beat === 7 ? <BellRingingIcon size={36} weight="duotone" /> : beat === 6 ? <ChefHatIcon size={36} weight="duotone" /> : <CheckIcon size={36} weight="bold" />}</div>
            <span className="order-reference">{text('طلب تجريبي', 'Sample order')} <b dir="ltr">#1042</b></span>
            <h3>{beat === 4 ? text('لحظة، بنبعت طلبك', 'Sending your order') : beat === 5 ? text('طلبك وصل!', 'Order received!') : beat === 6 ? text('أكلتك بتتجهّز', 'Made fresh for you') : text('طلبك جاهز. بالهنا!', 'Ready. Enjoy!')}</h3>
            <p>{beat === 7 ? text('أكلتك مستنياك، استلمها واستمتع بكل لقمة.', 'Your food is waiting. Enjoy every bite.') : text('خليك مرتاح، هنبّهك أول ما طلبك يجهز.', 'Sit back. We’ll let you know when it’s ready.')}</p>
            <ol className="order-progress">{[text('المطعم استلم الطلب', 'Order received'), text('في المطبخ، بيتجهّز بحُب', 'Preparing in the kitchen'), text('جاهز للاستلام', 'Ready to collect')].map((label, index) => <li key={label} className={beat >= index + 5 ? 'complete' : ''} aria-current={beat === index + 5 ? 'step' : undefined}><span>{beat >= index + 5 ? <CheckIcon size={12} weight="bold" /> : <i />}</span>{label}</li>)}</ol>
            <div className="order-ticket"><BowlFoodIcon size={20} /><div><strong>{text('بيت الزيتون', 'Olive House')}</strong><small>{text(`ترابيزة ٠٨ · عدد الأكلات: ${number(count)}`, `Table 08 · ${number(count)} ${count === 1 ? 'item' : 'items'}`)}</small></div><strong>{number(total)}<small> {text('ج.م', 'EGP')}</small></strong></div>
            {!automatic && beat === 7 && <button className="order-back" onClick={replay}><ArrowCounterClockwiseIcon size={14} />{text('شوف الرحلة تاني', 'Replay the journey')}</button>}
            <small className="order-demo-note">{text('تجربة توضيحية، مفيش طلب حقيقي اتبعت.', 'A walkthrough. No real order was sent.')}</small>
          </section>}
        </div>
        <div className={`order-notification ${beat === 7 ? 'visible' : ''}`} aria-hidden={beat !== 7}><span><BowlFoodIcon size={19} weight="fill" /></span><div><strong>{text('بيت الزيتون', 'Olive House')}<small>{text('دلوقتي', 'now')}</small></strong><p>{text('طلبك #١٠٤٢ جاهز للاستلام. بالهنا!', 'Order #1042 is ready. Enjoy!')}</p></div></div>
        <div className="order-home" aria-hidden="true" />
      </div>
    </div>
    <div className="order-story">
      <ol className="order-story-steps" aria-label={text('مراحل الطلب', 'Order journey')}>{[text('اختار', 'Choose'), text('أكّد', 'Confirm'), text('بيتحضّر', 'Cooking'), text('جاهز', 'Ready')].map((label, index) => <li key={label} className={index <= step ? 'active' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <CheckIcon size={10} weight="bold" /> : number(index + 1)}</span>{label}</li>)}</ol>
      <p className="order-caption" role="status" aria-live={automatic ? 'off' : 'polite'}>{captions[beat]}</p>
      <div className="order-playback"><button onClick={() => { if (!automatic) replay(); else setPaused(value => !value); }}>{automatic && !paused ? <PauseIcon size={13} weight="fill" /> : <PlayIcon size={13} weight="fill" />}{automatic && !paused ? text('إيقاف العرض', 'Pause tour') : text('تشغيل العرض', 'Play tour')}</button><span aria-hidden="true">·</span><button onClick={() => { dispatch({ type: 'reset' }); setAutomatic(false); setPaused(false); interacted.current = true; }}>{text('جرّب بنفسك', 'Try it yourself')}</button></div>
    </div>
  </div>;
}
