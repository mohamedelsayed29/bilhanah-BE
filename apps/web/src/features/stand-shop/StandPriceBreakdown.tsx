import { useLanguage } from '../../lib/language';
import { NFC_SURCHARGE, UNIT_PRICE } from './catalog';

export function StandPriceBreakdown({ quantity, nfcQuantity }: { quantity: number; nfcQuantity: number }) {
  const { text, number } = useLanguage();
  return <dl className="shop-price-breakdown">
    <div><dt>{text('الحوامل', 'Stands')} <small>{number(quantity)} × {number(UNIT_PRICE)}</small></dt><dd>{number(quantity * UNIT_PRICE)} {text('ج.م', 'EGP')}</dd></div>
    <div><dt>{text('إضافة NFC', 'NFC add-on')} {nfcQuantity > 0 && <small>{number(nfcQuantity)} × {number(NFC_SURCHARGE)}</small>}</dt><dd>{nfcQuantity ? `${number(nfcQuantity * NFC_SURCHARGE)} ${text('ج.م', 'EGP')}` : text('بدون إضافة', 'Not selected')}</dd></div>
    <div className="shop-summary-total"><dt>{text('إجمالي المنتجات', 'Product total')}</dt><dd>{number(quantity * UNIT_PRICE + nfcQuantity * NFC_SURCHARGE)} {text('ج.م', 'EGP')}</dd></div>
  </dl>;
}
