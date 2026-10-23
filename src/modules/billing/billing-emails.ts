import { type Language, PLAN_NAMES, type PlanCode } from '@bilhanah/contracts';
import type { EmailMessage } from '../../infrastructure/email/mailer.service.js';
import { type EmailTemplate, renderEmail } from '../../infrastructure/email/template.js';

type Recipient = { email: string; fullName: string; preferredLanguage: Language };
type PaymentFacts = { planCode: PlanCode; months: number; amountPiastres: number };

const money = (piastres: number, language: Language) =>
  `${new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-EG', { maximumFractionDigits: 2 }).format(piastres / 100)} ${language === 'ar' ? 'ج.م' : 'EGP'}`;

const date = (value: Date, language: Language) =>
  new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'long', timeZone: 'Africa/Cairo' }).format(value);

const months = (count: number, language: Language) =>
  language === 'ar' ? (count === 1 ? 'شهر' : count <= 10 ? `${count} شهور` : `${count} شهر`) : `${count} month${count === 1 ? '' : 's'}`;

function summary(payment: PaymentFacts, language: Language): string {
  const plan = PLAN_NAMES[payment.planCode][language];
  return language === 'ar'
    ? `باقة ${plan} لمدة ${months(payment.months, 'ar')}، بإجمالي ${money(payment.amountPiastres, 'ar')}.`
    : `${plan} plan for ${months(payment.months, 'en')}, ${money(payment.amountPiastres, 'en')} in total.`;
}

function email(to: Recipient, templates: Record<Language, EmailTemplate>, link?: string): EmailMessage {
  return renderEmail(to.email, to.preferredLanguage, templates[to.preferredLanguage], link);
}

export function paymentReceivedEmail(owner: Recipient, payment: PaymentFacts, dashboardUrl: string): EmailMessage {
  return email(owner, {
    ar: {
      subject: 'وصلتنا بيانات الدفع',
      greeting: `أهلًا ${owner.fullName}،`,
      body: [`استلمنا بيانات تحويلك: ${summary(payment, 'ar')}`, 'هنراجع التحويل خلال يوم عمل، وهنبعتلك إيميل أول ما الاشتراك يتفعّل.'],
      action: 'متابعة الاشتراك',
      footer: 'لو عندك أي سؤال، رد على الإيميل ده.',
    },
    en: {
      subject: 'We received your payment details',
      greeting: `Hi ${owner.fullName},`,
      body: [`We received your transfer details: ${summary(payment, 'en')}`, "We'll review the transfer within one business day and email you as soon as your plan is active."],
      action: 'View subscription',
      footer: 'Questions? Just reply to this email.',
    },
  }, `${dashboardUrl}/subscription`);
}

export function paymentApprovedEmail(owner: Recipient, payment: PaymentFacts, period: { startsAt: Date; endsAt: Date }, dashboardUrl: string) {
  return email(owner, {
    ar: {
      subject: 'اشتراكك اتفعّل',
      greeting: `أهلًا ${owner.fullName}،`,
      body: [`أكدنا تحويلك: ${summary(payment, 'ar')}`, `الاشتراك ساري من ${date(period.startsAt, 'ar')} لحد ${date(period.endsAt, 'ar')}. بالهنا!`],
      action: 'لوحة التحكم',
      footer: 'شكرًا إنك اخترت بالهنا.',
    },
    en: {
      subject: 'Your plan is active',
      greeting: `Hi ${owner.fullName},`,
      body: [`We confirmed your transfer: ${summary(payment, 'en')}`, `Your plan runs from ${date(period.startsAt, 'en')} to ${date(period.endsAt, 'en')}. Enjoy!`],
      action: 'Open dashboard',
      footer: 'Thank you for choosing Bilhanah.',
    },
  }, `${dashboardUrl}/subscription`);
}

export function paymentRejectedEmail(owner: Recipient, payment: PaymentFacts, reason: string, dashboardUrl: string) {
  return email(owner, {
    ar: {
      subject: 'محتاجين نراجع معاك التحويل',
      greeting: `أهلًا ${owner.fullName}،`,
      body: [`ماقدرناش نأكد التحويل (${summary(payment, 'ar')})`, `السبب: ${reason}`, 'تقدر تبعت بيانات التحويل تاني من صفحة الاشتراك، أو ترد على الإيميل ده.'],
      action: 'صفحة الاشتراك',
      footer: 'إحنا هنا لو محتاج مساعدة.',
    },
    en: {
      subject: "We couldn't confirm your transfer",
      greeting: `Hi ${owner.fullName},`,
      body: [`We couldn't confirm your transfer (${summary(payment, 'en')})`, `Reason: ${reason}`, 'You can send the transfer details again from your subscription page, or reply to this email.'],
      action: 'Subscription page',
      footer: "We're here if you need help.",
    },
  }, `${dashboardUrl}/subscription`);
}

export function newPaymentAdminEmail(
  admin: Recipient,
  restaurant: { name: string; subdomain: string },
  payment: PaymentFacts & { method: string; reference: string },
  dashboardUrl: string,
) {
  const facts = (language: Language) => `${restaurant.name} (${restaurant.subdomain}) · ${summary(payment, language)} · ${payment.method} · ${payment.reference}`;
  return email(admin, {
    ar: { subject: `دفعة جديدة للمراجعة: ${restaurant.name}`, greeting: 'تحويل جديد مستني المراجعة:', body: facts('ar'), action: 'مراجعة المدفوعات', footer: 'بالهنا · لوحة الإدارة' },
    en: { subject: `New payment to review: ${restaurant.name}`, greeting: 'A transfer is waiting for review:', body: facts('en'), action: 'Review payments', footer: 'Bilhanah · administration' },
  }, `${dashboardUrl}/admin/payments`);
}

/** daysBefore 7, 3 or 1: ending soon. 0: has ended and the menu is paused. */
export function expiryReminderEmail(owner: Recipient, kind: 'TRIAL' | 'PAID', daysBefore: number, endsAt: Date, dashboardUrl: string) {
  const ended = daysBefore === 0;
  const what = { ar: kind === 'TRIAL' ? 'التجربة المجانية' : 'اشتراكك', en: kind === 'TRIAL' ? 'Your free trial' : 'Your plan' };
  const inDays = (language: Language) =>
    language === 'ar' ? (daysBefore === 1 ? 'بكرة' : `خلال ${daysBefore} أيام`) : daysBefore === 1 ? 'tomorrow' : `in ${daysBefore} days`;
  return email(owner, {
    ar: ended
      ? {
          subject: `${what.ar} انتهى`,
          greeting: `أهلًا ${owner.fullName}،`,
          body: [`${what.ar} انتهى يوم ${date(endsAt, 'ar')}، والمنيو متوقف مؤقتًا للزباين.`, 'بياناتك والمنيو محفوظين كلهم. جدّد الاشتراك والمنيو يرجع على طول.'],
          action: 'جدّد الاشتراك',
          footer: 'محتاج مساعدة؟ رد على الإيميل ده.',
        }
      : {
          subject: `${what.ar} هيخلص ${inDays('ar')}`,
          greeting: `أهلًا ${owner.fullName}،`,
          body: [`${what.ar} هيخلص يوم ${date(endsAt, 'ar')}.`, 'جدّد دلوقتي عشان المنيو يفضل شغال للزباين من غير انقطاع.'],
          action: 'جدّد الاشتراك',
          footer: 'لو جددت بالفعل، تجاهل الرسالة دي.',
        },
    en: ended
      ? {
          subject: `${what.en} has ended`,
          greeting: `Hi ${owner.fullName},`,
          body: [`${what.en} ended on ${date(endsAt, 'en')}, so your menu is paused for guests.`, 'Your menu and data are kept. Renew and your menu is back right away.'],
          action: 'Renew now',
          footer: 'Need help? Reply to this email.',
        }
      : {
          subject: `${what.en} ends ${inDays('en')}`,
          greeting: `Hi ${owner.fullName},`,
          body: [`${what.en} ends on ${date(endsAt, 'en')}.`, 'Renew now to keep your menu online without interruption.'],
          action: 'Renew now',
          footer: "If you've already renewed, you can ignore this email.",
        },
  }, `${dashboardUrl}/subscription`);
}
