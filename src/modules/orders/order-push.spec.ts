import { type OrderPushInput, orderPushPayload, orderPushTopic } from './order-push.js';

const base: OrderPushInput = {
  orderId: '0b6f2c1e-7d1a-4a57-9a8e-3f1c2d4e5a6b',
  number: 12,
  type: 'DINE_IN',
  status: 'READY',
  rejectionReason: null,
  restaurantName: 'Koshary Abou Tarek',
  language: 'ar',
  url: 'https://koshary.bilhanah.com/order/abc.def',
  icon: null,
};

describe('orderPushPayload', () => {
  it('says the order is ready, for the table or the counter', () => {
    expect(orderPushPayload(base)).toEqual({
      title: 'Koshary Abou Tarek',
      body: 'طلبك رقم ١٢ جاهز وجايلك على الترابيزة. بالهنا!',
      url: base.url,
      tag: 'order-0b6f2c1e-7d1a-4a57-9a8e-3f1c2d4e5a6b',
      status: 'READY',
      icon: null,
    });
    expect(orderPushPayload({ ...base, language: 'en' }).body).toBe('Order #12 is ready and on its way to your table. Enjoy!');
    expect(orderPushPayload({ ...base, type: 'PICKUP' }).body).toBe('طلبك رقم ١٢ جاهز، اتفضل استلمه. بالهنا!');
    expect(orderPushPayload({ ...base, type: 'PICKUP', language: 'en' }).body).toBe('Order #12 is ready for pickup. Enjoy!');
  });

  it('explains a refused or cancelled order, with the reason', () => {
    expect(orderPushPayload({ ...base, status: 'REJECTED', rejectionReason: 'الرز خلص' }).body).toBe('المطعم معتذر عن طلبك رقم ١٢. السبب: الرز خلص');
    expect(orderPushPayload({ ...base, status: 'CANCELLED', language: 'en' }).body).toBe('Order #12 was cancelled.');
    expect(orderPushPayload({ ...base, status: 'CANCELLED', language: 'en', rejectionReason: 'Kitchen closed' }).body).toBe(
      'Order #12 was cancelled. Reason: Kitchen closed',
    );
  });

  it('uses the order id as a 32-character push topic', () => {
    expect(orderPushTopic(base.orderId)).toBe('0b6f2c1e7d1a4a579a8e3f1c2d4e5a6b');
  });
});
