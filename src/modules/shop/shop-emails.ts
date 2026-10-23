import type { Language, StandOrderStatus } from '@bilhanah/contracts';
import type { EmailMessage } from '../../infrastructure/email/mailer.service.js';
import { renderEmail } from '../../infrastructure/email/template.js';

type Order = {
  reference: string;
  customerName: string;
  email: string | null;
  language: Language;
  totalPiastres: number;
  deliveryFeePiastres: number | null;
  paymentMethod: 'CASH_ON_DELIVERY' | 'PAYMOB';
  stands: number;
};

const money = (piastres: number, language: Language) =>
  `${new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-EG', { maximumFractionDigits: 2 }).format(piastres / 100)} ${language === 'ar' ? 'ج.م' : 'EGP'}`;

function total(order: Order, language: Language): string {
  const amount = money(order.totalPiastres, language);
  if (order.deliveryFeePiastres !== null) return language === 'ar' ? `الإجمالي ${amount} شامل التوصيل.` : `Total ${amount}, delivery included.`;
  return language === 'ar' ? `الإجمالي ${amount}، وسعر التوصيل هنأكده معاك بالتليفون.` : `Total ${amount}; we'll confirm the delivery fee by phone.`;
}

/** To the customer when the order is placed (cash) or paid (online). Null without an email address. */
export function standOrderPlacedEmail(order: Order, link: string): EmailMessage | null {
  if (!order.email) return null;
  const paid = order.paymentMethod === 'PAYMOB';
  const ar = order.language === 'ar';
  return renderEmail(order.email, order.language, ar
    ? {
        subject: `طلبك ${order.reference} وصلنا`,
        greeting: `أهلًا ${order.customerName}،`,
        body: [
          `شكرًا لطلبك من بالهنا: ${order.stands.toLocaleString('ar-EG')} حامل. ${total(order, 'ar')}`,
          paid ? 'وصلنا الدفع أونلاين.' : 'الدفع كاش عند الاستلام.',
          'هنكلمك قريب نأكد التصميم والعنوان قبل ما نبدأ التصنيع.',
        ],
        action: 'متابعة الطلب',
        footer: `رقم الطلب ${order.reference}. لو عندك أي سؤال، رد على الإيميل ده.`,
      }
    : {
        subject: `We received your order ${order.reference}`,
        greeting: `Hi ${order.customerName},`,
        body: [
          `Thank you for your Bilhanah order: ${order.stands} stand${order.stands === 1 ? '' : 's'}. ${total(order, 'en')}`,
          paid ? 'We received your online payment.' : 'You pay cash on delivery.',
          "We'll call you soon to confirm the design and address before production starts.",
        ],
        action: 'Track your order',
        footer: `Order ${order.reference}. Questions? Just reply to this email.`,
      }, link);
}

const STATUS_TEXT: Partial<Record<StandOrderStatus, Record<Language, { subject: string; body: string }>>> = {
  CONFIRMED: {
    ar: { subject: 'أكدنا طلبك', body: 'أكدنا التصميم والعنوان، وطلبك داخل التصنيع قريب.' },
    en: { subject: 'Your order is confirmed', body: 'We confirmed the design and address; production starts soon.' },
  },
  IN_PRODUCTION: {
    ar: { subject: 'طلبك بيتصنع', body: 'بدأنا نصنّع الحوامل بتاعتك.' },
    en: { subject: 'Your stands are being made', body: 'We started making your stands.' },
  },
  SHIPPED: {
    ar: { subject: 'طلبك خرج للتوصيل', body: 'طلبك اتشحن وفي الطريق ليك. المندوب هيكلمك قبل ما يوصل.' },
    en: { subject: 'Your order is on its way', body: 'Your order has shipped. The courier will call before arriving.' },
  },
  DELIVERED: {
    ar: { subject: 'طلبك وصل', body: 'طلبك اتسلّم. نتمنى الحوامل تعجبك، وبالهنا!' },
    en: { subject: 'Your order was delivered', body: 'Your order was delivered. We hope you love your stands!' },
  },
  CANCELLED: {
    ar: { subject: 'طلبك اتلغى', body: 'طلبك اتلغى.' },
    en: { subject: 'Your order was cancelled', body: 'Your order was cancelled.' },
  },
};

/** To the customer on status changes they care about. Null without an email address or for other statuses. */
export function standOrderStatusEmail(order: Order, status: StandOrderStatus, note: string | null, link: string): EmailMessage | null {
  const text = STATUS_TEXT[status]?.[order.language];
  if (!order.email || !text) return null;
  const ar = order.language === 'ar';
  const reason = status === 'CANCELLED' && note ? (ar ? ` السبب: ${note}` : ` Reason: ${note}`) : '';
  return renderEmail(order.email, order.language, {
    subject: `${text.subject} · ${order.reference}`,
    greeting: ar ? `أهلًا ${order.customerName}،` : `Hi ${order.customerName},`,
    body: [`${text.body}${reason}`],
    action: ar ? 'متابعة الطلب' : 'Track your order',
    footer: ar ? `رقم الطلب ${order.reference}. لو عندك أي سؤال، رد على الإيميل ده.` : `Order ${order.reference}. Questions? Just reply to this email.`,
  }, link);
}

/** To administrators when an order needs handling (placed with cash, or paid online). */
export function newStandOrderAdminEmail(admin: { email: string; fullName: string; preferredLanguage: Language }, order: Order & { city: string }, link: string): EmailMessage {
  const ar = admin.preferredLanguage === 'ar';
  return renderEmail(admin.email, admin.preferredLanguage, ar
    ? {
        subject: `طلب حوامل جديد ${order.reference}`,
        greeting: `أهلًا ${admin.fullName}،`,
        body: [`${order.customerName} من ${order.city} طلب ${order.stands.toLocaleString('ar-EG')} حامل. ${total(order, 'ar')}`, order.paymentMethod === 'PAYMOB' ? 'مدفوع أونلاين.' : 'كاش عند الاستلام.'],
        action: 'افتح الطلب',
        footer: 'كلّم العميل وأكّد التصميم والعنوان.',
      }
    : {
        subject: `New stand order ${order.reference}`,
        greeting: `Hi ${admin.fullName},`,
        body: [`${order.customerName} (${order.city}) ordered ${order.stands} stand${order.stands === 1 ? '' : 's'}. ${total(order, 'en')}`, order.paymentMethod === 'PAYMOB' ? 'Paid online.' : 'Cash on delivery.'],
        action: 'Open the order',
        footer: 'Call the customer to confirm the design and address.',
      }, link);
}
