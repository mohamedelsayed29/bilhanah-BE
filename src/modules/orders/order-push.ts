import type { Language, OrderPushPayload, OrderStatus, OrderType } from '@bilhanah/contracts';

export type OrderPushInput = {
  orderId: string;
  number: number;
  type: OrderType;
  status: OrderStatus;
  rejectionReason: string | null;
  restaurantName: string;
  language: Language;
  /** The order's tracking page. */
  url: string;
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
    default:
      body = ar ? `فيه تحديث على طلبك رقم ${number}.` : `Order #${number} has an update.`;
  }
  return { title: input.restaurantName, body, url: input.url, tag: `order-${input.orderId}`, status: input.status, icon: input.icon };
}

/** Push topic: a newer update replaces an older one the push service still holds. At most 32 URL-safe characters. */
export function orderPushTopic(orderId: string): string {
  return orderId.replaceAll('-', '');
}
