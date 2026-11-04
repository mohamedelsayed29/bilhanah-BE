import type { Language, OrderPushPayload, OrderStatus, OrderType } from '@bilhanah/contracts';

export type OrderPushInput = {
  orderId: string;
  number: number;
  type: OrderType;
  status: OrderStatus;
  rejectionReason: string | null;
  restaurantName: string;
  /** Set when the restaurant has several branches, so diners know which one is calling them. */
  branchName?: string | null;
  language: Language;
  /** The order's tracking page. */
  url: string;
  /** When the restaurant expects it ready, for the accepted and preparing updates. */
  estimatedReadyAt?: Date | null;
  timezone?: string;
  icon: string | null;
};

/** The notification a diner sees for an order update, in the language their page used. */
export function orderPushPayload(input: OrderPushInput): OrderPushPayload {
  const ar = input.language === 'ar';
  const number = ar ? input.number.toLocaleString('ar-EG') : String(input.number);
  const reason = input.rejectionReason ? (ar ? ` السبب: ${input.rejectionReason}` : ` Reason: ${input.rejectionReason}`) : '';
  let body: string;
  switch (input.status) {
    case 'READY':
      body =
        input.type === 'PICKUP'
          ? ar ? `طلبك رقم ${number} جاهز، اتفضل استلمه. بالهنا!` : `Order #${number} is ready for pickup. Enjoy!`
          : ar ? `طلبك رقم ${number} جاهز وجايلك على الترابيزة. بالهنا!` : `Order #${number} is ready and on its way to your table. Enjoy!`;
      break;
    case 'REJECTED':
      body = (ar ? `المطعم معتذر عن طلبك رقم ${number}.` : `The restaurant could not take order #${number}.`) + reason;
      break;
    case 'CANCELLED':
      body = (ar ? `طلبك رقم ${number} اتلغى.` : `Order #${number} was cancelled.`) + reason;
      break;
    case 'ACCEPTED':
    case 'PREPARING': {
      const step = input.status === 'ACCEPTED'
        ? ar ? `المطعم أكّد طلبك رقم ${number}.` : `Order #${number} is confirmed.`
        : ar ? `طلبك رقم ${number} بيتحضّر دلوقتي.` : `Order #${number} is being prepared.`;
      const at = input.estimatedReadyAt
        ? new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: input.timezone ?? 'Africa/Cairo' }).format(input.estimatedReadyAt)
        : null;
      body = at ? step + (ar ? ` متوقع يجهز حوالي ${at}.` : ` Expected ready around ${at}.`) : step;
      break;
    }
    default:
      body = ar ? `فيه تحديث على طلبك رقم ${number}.` : `Order #${number} has an update.`;
  }
  const title = input.branchName ? `${input.restaurantName} · ${input.branchName}` : input.restaurantName;
  return { title, body, url: input.url, tag: `order-${input.orderId}`, status: input.status, icon: input.icon };
}

/** Push topic: a newer update replaces an older one the push service still holds. At most 32 URL-safe characters. */
export function orderPushTopic(orderId: string): string {
  return orderId.replaceAll('-', '');
}
