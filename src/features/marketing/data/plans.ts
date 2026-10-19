export type PlanId = 'menu' | 'orders' | 'advanced';
export type Bilingual = { ar: string; en: string };
export type Plan = { id: PlanId; name: Bilingual; subtitle: Bilingual; price: number; features: Bilingual[]; featured?: boolean };

// Initial prices explicitly approved by the owner. Replace this data source with
// the public plans API when the NestJS administration backend is available.
export const plans: Plan[] = [
  { id: 'menu', name: { ar: 'منيو', en: 'Menu' }, subtitle: { ar: 'خلّي أول انطباع على ذوقك.', en: 'Make a delicious first impression.' }, price: 200, features: [
    { ar: 'منيو ديجيتال عربي وإنجليزي', en: 'Arabic & English digital menu' },
    { ar: 'صور، أوصاف، أسعار وأحجام', en: 'Photos, descriptions, prices & sizes' },
    { ar: 'لينك باسم مطعمك وQR جاهز', en: 'Your own subdomain & QR code' },
    { ar: 'تعديل المنيو في أي وقت', en: 'Update your menu whenever you need' },
    { ar: 'ألوان ولوجو يعبروا عنك', en: 'Your restaurant logo & brand color' },
  ] },
  { id: 'orders', name: { ar: 'منيو وطلبات', en: 'Menu & Orders' }, subtitle: { ar: 'من الاختيار للطلب، بكل سهولة.', en: 'From browsing to ordering, made easy.' }, price: 350, featured: true, features: [
    { ar: 'كل مميزات باقة منيو', en: 'Everything in the Menu plan' },
    { ar: 'طلبات الترابيزات والاستلام', en: 'Dine-in & pickup orders' },
    { ar: 'سلة وملاحظات على الطلب', en: 'Cart & customer order notes' },
    { ar: 'شاشة متابعة الطلبات للمطعم', en: 'Live restaurant order board' },
    { ar: 'QR مستقل لكل ترابيزة', en: 'A dedicated QR for every table' },
    { ar: 'متابعة حالة الطلب للزبون', en: 'Customer order-status tracking' },
  ] },
  { id: 'advanced', name: { ar: 'التجربة الكاملة', en: 'The Full Experience' }, subtitle: { ar: 'اهتمام يكمل لحد الطلب ما يجهز.', en: 'Thoughtful service, right to the last step.' }, price: 500, features: [
    { ar: 'كل مميزات باقة منيو وطلبات', en: 'Everything in Menu & Orders' },
    { ar: 'تنبيه الزبون لما الطلب يجهز', en: 'Customer order-ready alerts' },
    { ar: 'صوت واهتزاز حسب دعم الجهاز', en: 'Sound & vibration where supported' },
    { ar: 'إشعارات ويب اختيارية', en: 'Optional Web Push notifications' },
    { ar: 'تجربة متابعة أريح للزبون', en: 'A more relaxed customer experience' },
  ] },
];
