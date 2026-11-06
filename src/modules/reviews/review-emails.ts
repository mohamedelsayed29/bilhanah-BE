import type { Language } from '@bilhanah/contracts';
import type { EmailMessage } from '../../infrastructure/email/mailer.service.js';
import { renderEmail } from '../../infrastructure/email/template.js';

type Recipient = { email: string; fullName: string; preferredLanguage: Language };

export type LowRatingFacts = {
  restaurantName: string;
  branchName: string;
  overall: number;
  comment: string | null;
  orderNumber: number | null;
  verified: boolean;
  /** The diner left a phone number to be contacted. */
  hasContact: boolean;
};

const excerpt = (text: string) => (text.length > 280 ? `${text.slice(0, 277)}…` : text);

/** "A diner rated their visit 2/5": to the owner and the staff who follow reviews up at that branch. */
export function lowRatingEmail(to: Recipient, review: LowRatingFacts, link: string): EmailMessage {
  const stars = `${review.overall}/5`;
  if (to.preferredLanguage === 'ar') {
    return renderEmail(to.email, 'ar', {
      subject: `تقييم ${stars} في ${review.branchName}`,
      greeting: `أهلًا ${to.fullName}،`,
      body: [
        `زبون قيّم زيارته لـ${review.restaurantName} (${review.branchName}) بـ${stars}${review.orderNumber ? ` على طلب رقم ${review.orderNumber}` : ''}${review.verified ? '' : ' (تقييم من غير طلب)'}.`,
        ...(review.comment ? [`كتب: «${excerpt(review.comment)}»`] : []),
        review.hasContact ? 'الزبون ساب رقمه ووافق إنكم تكلموه: كلمه بدري وشوف إيه اللي حصل.' : 'رد عليه أو تابع معاه من صفحة التقييمات.',
      ],
      action: 'افتح التقييم',
      footer: 'الإيميل ده بيتبعت مرة واحدة لكل تقييم أقل من الحد اللي حددته في إعدادات التقييمات.',
    }, link);
  }
  return renderEmail(to.email, 'en', {
    subject: `${stars} review at ${review.branchName}`,
    greeting: `Hi ${to.fullName},`,
    body: [
      `A diner rated their visit to ${review.restaurantName} (${review.branchName}) ${stars}${review.orderNumber ? ` for order #${review.orderNumber}` : ''}${review.verified ? '' : ' (feedback without an order)'}.`,
      ...(review.comment ? [`They wrote: “${excerpt(review.comment)}”`] : []),
      review.hasContact ? 'They left a phone number and agreed to be contacted: a quick call can turn this around.' : 'Reply or follow them up from the reviews page.',
    ],
    action: 'Open the review',
    footer: 'This email is sent once per review below the threshold set in your review settings.',
  }, link);
}
