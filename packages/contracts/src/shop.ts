// The QR/NFC table-stand shop. Free of zod, so the website can import it
// without the schema library; request schemas are in shop-orders.ts.

/** stand: an acrylic table stand. sticker: a QR sticker stuck on the table. */
export const SHOP_PRODUCTS = ['stand', 'sticker'] as const;
export type ShopProduct = (typeof SHOP_PRODUCTS)[number];

export const STAND_SHAPES = ['classic', 'arch', 'tilt', 'wood'] as const;
export type StandShape = (typeof STAND_SHAPES)[number];

export const STICKER_SHAPES = ['square', 'circle'] as const;
export type StickerShape = (typeof STICKER_SHAPES)[number];

/** The shapes each product comes in; an order line's shape must belong to its product. */
export const PRODUCT_SHAPES = { stand: STAND_SHAPES, sticker: STICKER_SHAPES } as const satisfies Record<ShopProduct, readonly string[]>;
export type ProductShape = StandShape | StickerShape;

export const STAND_DESIGNS = ['signature', 'forest', 'clay', 'mono'] as const;
export type StandDesign = (typeof STAND_DESIGNS)[number];

export const STAND_PURPOSES = ['menu', 'reviews', 'custom'] as const;
export type StandPurpose = (typeof STAND_PURPOSES)[number];

/** Prices are set here and checked by the API; the website shows the same numbers. */
export const STAND_PRICES = {
  /** One acrylic stand with the printed QR code. */
  unitPiastres: 35_000,
  /** An NFC chip added to a stand. */
  nfcPiastres: 10_000,
} as const;

/** One printed QR sticker, and the NFC chip added to it. */
export const STICKER_PRICES = {
  unitPiastres: 15_000,
  nfcPiastres: 10_000,
} as const;

export const STAND_LIMITS = {
  linesPerOrder: 20,
  quantity: 500,
  brand: 35,
  caption: 60,
  notes: 300,
  /** Uploaded logo files (PNG, JPEG or WebP). */
  logoBytes: 3 * 1024 * 1024,
} as const;

/** Google links accepted for the "reviews" purpose (the domain or a subdomain of it). */
export const GOOGLE_REVIEW_DOMAINS = ['google.com', 'google.com.eg', 'g.page', 'maps.app.goo.gl', 'goo.gl'] as const;

export function standUnitPricePiastres(nfc: boolean): number {
  return STAND_PRICES.unitPiastres + (nfc ? STAND_PRICES.nfcPiastres : 0);
}

export function shopUnitPricePiastres(product: ShopProduct, nfc: boolean): number {
  const prices = product === 'sticker' ? STICKER_PRICES : STAND_PRICES;
  return prices.unitPiastres + (nfc ? prices.nfcPiastres : 0);
}

/** CASH_ON_DELIVERY: paid to the courier. PAYMOB: paid online (card or wallet) before production. */
export const STAND_PAYMENT_METHODS = ['CASH_ON_DELIVERY', 'PAYMOB'] as const;
export type StandPaymentMethod = (typeof STAND_PAYMENT_METHODS)[number];

export const STAND_PAYMENT_STATUSES = ['UNPAID', 'PAID'] as const;
export type StandPaymentStatus = (typeof STAND_PAYMENT_STATUSES)[number];

/**
 * AWAITING_PAYMENT: an online order whose payment is not finished (cancelled
 * automatically after two days). NEW: placed (cash) or paid (online), waiting
 * for us. Then CONFIRMED (we called the customer), IN_PRODUCTION, SHIPPED,
 * DELIVERED; or CANCELLED.
 */
export const STAND_ORDER_STATUSES = ['AWAITING_PAYMENT', 'NEW', 'CONFIRMED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type StandOrderStatus = (typeof STAND_ORDER_STATUSES)[number];

/** Status changes an administrator may make. Payment moves AWAITING_PAYMENT to NEW. */
export const STAND_ORDER_TRANSITIONS: Record<StandOrderStatus, readonly StandOrderStatus[]> = {
  AWAITING_PAYMENT: ['CANCELLED'],
  NEW: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'CANCELLED'],
  IN_PRODUCTION: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export const SHOP_ERROR_CODES = {
  /** details.methods: what is offered now. */
  PAYMENT_METHOD_UNAVAILABLE: 'PAYMENT_METHOD_UNAVAILABLE',
  /** The total the customer saw differs from today's (details: { totalPiastres, deliveryFeePiastres }). */
  PRICE_CHANGED: 'PRICE_CHANGED',
  /** Not a PNG, JPEG or WebP image, or too large. */
  LOGO_INVALID: 'LOGO_INVALID',
  /** A logoId that this server did not issue, or that expired. */
  LOGO_NOT_FOUND: 'LOGO_NOT_FOUND',
  STAND_ORDER_NOT_FOUND: 'STAND_ORDER_NOT_FOUND',
  /** details: { from, to, allowed } */
  INVALID_STATUS_CHANGE: 'INVALID_STATUS_CHANGE',
  /** Only an online order still awaiting payment can be paid again. */
  NOT_AWAITING_PAYMENT: 'NOT_AWAITING_PAYMENT',
} as const;

/** GET /v1/public/shop: what the checkout offers today. */
export type ShopInfo = {
  prices: typeof STAND_PRICES;
  stickerPrices: typeof STICKER_PRICES;
  /** Flat delivery fee; null means it is confirmed by phone (and online payment is then not offered). */
  deliveryFeePiastres: number | null;
  paymentMethods: StandPaymentMethod[];
};

/** POST /v1/public/shop/logos (multipart "file"): pass logoId with the order line. */
export type UploadedLogo = { logoId: string };

export type StandOrderLine = {
  id: string;
  product: ShopProduct;
  shape: ProductShape;
  nfc: boolean;
  design: StandDesign;
  customColors: { background: string; ink: string } | null;
  purpose: StandPurpose;
  brand: string;
  caption: string;
  url: string;
  hasLogo: boolean;
  numbered: boolean;
  startNumber: number;
  quantity: number;
  notes: string;
  unitPricePiastres: number;
  lineTotalPiastres: number;
};

/** An order as its customer sees it (GET /v1/public/shop/orders/:token). */
export type PublicStandOrder = {
  /** Shown to the customer and used on the phone, e.g. "S-1042". */
  reference: string;
  status: StandOrderStatus;
  paymentMethod: StandPaymentMethod;
  paymentStatus: StandPaymentStatus;
  lines: StandOrderLine[];
  subtotalPiastres: number;
  deliveryFeePiastres: number | null;
  /** Subtotal plus delivery; without delivery while the fee is to be confirmed. */
  totalPiastres: number;
  customerName: string;
  city: string;
  createdAt: string;
  updatedAt: string;
};

/** POST /v1/public/shop/orders. Online orders go to checkoutUrl; Paymob returns them to /shop/orders/<trackingToken>. */
export type PlaceStandOrderResponse = {
  trackingToken: string;
  order: PublicStandOrder;
  checkoutUrl: string | null;
};

/** POST /v1/public/shop/orders/:token/pay: a new checkout for an order still awaiting payment. */
export type StandOrderCheckout = { checkoutUrl: string };

/** The fulfilment queue (GET /v1/admin/stand-orders). */
export type AdminStandOrder = PublicStandOrder & {
  id: string;
  phone: string;
  email: string | null;
  address: string;
  customerNotes: string | null;
  /** Internal notes, never shown to the customer. */
  adminNote: string | null;
  language: 'ar' | 'en';
  paidAt: string | null;
  statusHistory: { status: StandOrderStatus; at: string; by: string | null; note: string | null }[];
};

/** GET/PUT /v1/admin/settings/shop */
export type ShopSettings = {
  deliveryFeePiastres: number | null;
  cashOnDelivery: boolean;
  onlinePayment: boolean;
};
