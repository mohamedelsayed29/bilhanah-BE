import { useState } from 'react';
import { ArrowLeftIcon, BowlFoodIcon, CheckIcon, MinusIcon, PlusIcon, ShoppingBagIcon, XIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { menuItems } from '../data/menu';
import type { Category } from '../data/menu';

type CartLine = { key: string; id: string; large: boolean; quantity: number };

export function DemoMenu({ compact = false }: { compact?: boolean }) {
  const { language, text, number } = useLanguage();
  const [category, setCategory] = useState<Category>('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [large, setLarge] = useState<Record<string, boolean>>({});
  const [showCart, setShowCart] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const categories: { id: Category; label: string }[] = [
    { id: 'all', label: text('الكل', 'All') }, { id: 'mains', label: text('رئيسي', 'Mains') }, { id: 'pasta', label: text('باستا', 'Pasta') }, { id: 'light', label: text('خفيف', 'Light') },
  ];
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart.reduce((sum, line) => { const item = menuItems.find(item => item.id === line.id)!; return sum + line.quantity * (line.large ? item.largePrice : item.price); }, 0);
  function add(id: string) {
    const isLarge = !!large[id];
    const key = `${id}-${isLarge ? 'large' : 'regular'}`;
    setCart(current => current.some(line => line.key === key) ? current.map(line => line.key === key ? { ...line, quantity: line.quantity + 1 } : line) : [...current, { key, id, large: isLarge, quantity: 1 }]);
    setConfirmed(false);
  }
  function change(key: string, amount: number) { setCart(current => current.map(line => line.key === key ? { ...line, quantity: line.quantity + amount } : line).filter(line => line.quantity > 0)); }
  return <div className={`demo-menu ${compact ? 'demo-menu-compact' : ''}`}>
    <div className="demo-restaurant"><span className="restaurant-mark"><BowlFoodIcon weight="duotone" size={30} /></span><div><strong>{text('بيت الزيتون', 'Olive House')}</strong><span>{text('أكل معمول بحُب', 'Made with a little love')}</span></div><span className="demo-tag">{text('منيو تجريبي', 'Sample menu')}</span></div>
    <div className="demo-cover"><img src="/media/ready.jpg" alt={text('طبق أكل طازج بجوار موبايل يعرض المنيو', 'Freshly prepared food beside a phone displaying the menu')} width="800" height="450" loading="lazy" /><span>{text('اختار مزاجك النهارده.', 'What are you craving?')}</span></div>
    <div className="menu-category-tabs" role="group" aria-label={text('أقسام المنيو', 'Menu categories')}>{categories.map(item => <button key={item.id} className={category === item.id ? 'selected' : ''} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
    <div className="demo-items">
      {menuItems.filter(item => category === 'all' || item.category === category).map(item => <article className="demo-dish" key={item.id}>
        <img src={item.image} alt={item.name[language]} loading="lazy" width="120" height="120" />
        <div className="dish-info"><h3>{item.name[language]}</h3><p>{item.description[language]}</p>
          {!compact && <div className="size-options" role="group" aria-label={text(`حجم ${item.name.ar}`, `${item.name.en} size`)}><button className={!large[item.id] ? 'selected' : ''} aria-pressed={!large[item.id]} onClick={() => setLarge(current => ({ ...current, [item.id]: false }))}>{text('عادي', 'Regular')}</button><button className={large[item.id] ? 'selected' : ''} aria-pressed={!!large[item.id]} onClick={() => setLarge(current => ({ ...current, [item.id]: true }))}>{text('كبير', 'Large')}</button></div>}
          <strong className="dish-price">{number(large[item.id] ? item.largePrice : item.price)} <small>{text('ج.م', 'EGP')}</small></strong>
        </div>
        <button className="add-dish" onClick={() => add(item.id)} aria-label={text(`أضف ${item.name.ar}`, `Add ${item.name.en}`)}><PlusIcon size={18} /></button>
      </article>)}
    </div>
    <button className="demo-cart-button" onClick={() => setShowCart(true)}><ShoppingBagIcon size={20} /><span>{count ? text(`السلة (${number(count)})`, `View bag (${number(count)})`) : text('جرّب تضيف أكلة للسلة', 'Try adding a dish')} </span><strong>{number(total)} {text('ج.م', 'EGP')}</strong></button>
    {showCart && <section className="cart-preview" aria-label={text('سلة الطلب التجريبي', 'Sample order bag')}>
      <div className="cart-title"><h3>{text('طلبك على ذوقك', 'Your order, your way')}</h3><button className="icon-button" onClick={() => setShowCart(false)} aria-label={text('إغلاق السلة', 'Close bag')}><XIcon size={20} /></button></div>
      {!count ? <p className="cart-empty">{text('لسه السلة فاضية. اختار أكلة تفتح نفسك.', 'Your bag is empty. Pick something delicious.')}</p> : <>
        {cart.map(line => { const item = menuItems.find(item => item.id === line.id)!; return <div className="cart-line" key={line.key}><div><strong>{item.name[language]}</strong><small>{line.large ? text('كبير', 'Large') : text('عادي', 'Regular')}</small></div><div className="quantity-controls"><button onClick={() => change(line.key, -1)} aria-label={text(`تقليل ${item.name.ar}`, `Remove one ${item.name.en}`)}><MinusIcon size={14} /></button><span>{number(line.quantity)}</span><button onClick={() => change(line.key, 1)} aria-label={text(`زيادة ${item.name.ar}`, `Add one more ${item.name.en}`)}><PlusIcon size={14} /></button></div></div>; })}
        <div className="cart-total"><span>{text('الإجمالي', 'Total')}</span><strong>{number(total)} {text('ج.م', 'EGP')}</strong></div>
        <button className="button button-teal" onClick={() => setConfirmed(true)}>{confirmed ? <CheckIcon size={20} /> : <ArrowLeftIcon className="directional-arrow" size={20} />}{confirmed ? text('خلصت التجربة، بالهنا!', 'Demo complete. Enjoy!') : text('جرّب تأكيد الطلب', 'Try confirming your order')}</button>
        <p className="sample-disclaimer" role="status">{confirmed ? text('ده طلب تجريبي فقط. مفيش طلب اتبعت لمطعم ومفيش دفع مطلوب.', 'This is a demo. No restaurant receives an order and no payment is required.') : text('تجربة توضيحية، بدون دفع أو إرسال طلب حقيقي.', 'An interactive sample, with no payment or real order.')}</p>
      </>}
    </section>}
  </div>;
}
