import { z } from 'zod';
import { emailSchema, languageSchema } from './common.js';
import {
  GOOGLE_REVIEW_DOMAINS,
  PRODUCT_SHAPES,
  SHOP_PRODUCTS,
  STAND_DESIGNS,
  STAND_LIMITS,
  STAND_ORDER_STATUSES,
  STAND_PAYMENT_METHODS,
  STAND_PURPOSES,
  STAND_SHAPES,
  STICKER_SHAPES,
} from './shop.js';

const hexColor = z
  .string()
  .trim()
  .regex(/^#?([\da-f]{3}|[\da-f]{6})$/i, 'Use a HEX colour such as #075E54.')
  .transform((value) => {
    const hex = value.replace(/^#/, '').toUpperCase();
    return `#${hex.length === 3 ? [...hex].map((char) => char + char).join('') : hex}`;
  });

const linkSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Enter a complete link starting with https:// or http://.');

const isGoogleLink = (value: string) => {
  const host = new URL(value).hostname.toLowerCase();
  return GOOGLE_REVIEW_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

const text = (max: number) => z.string().trim().max(max).default('');

/** One stand or sticker design in the order. Prices are not sent: the API computes them. */
export const standOrderLineSchema = z
  .strictObject({
    product: z.enum(SHOP_PRODUCTS).default('stand'),
    shape: z.enum([...STAND_SHAPES, ...STICKER_SHAPES]),
    nfc: z.boolean(),
    design: z.enum(STAND_DESIGNS),
    customColors: z.strictObject({ background: hexColor, ink: hexColor }).nullable().default(null),
    purpose: z.enum(STAND_PURPOSES),
    brand: text(STAND_LIMITS.brand),
    caption: text(STAND_LIMITS.caption),
    url: linkSchema,
    /** From POST /v1/public/shop/logos. */
    logoId: z.string().max(200).nullable().default(null),
    numbered: z.boolean().default(false),
    startNumber: z.number().int().min(1).max(9999).default(1),
    quantity: z.number().int().min(1).max(STAND_LIMITS.quantity),
    notes: text(STAND_LIMITS.notes),
  })
  .superRefine((line, context) => {
    if (!(PRODUCT_SHAPES[line.product] as readonly string[]).includes(line.shape)) {
      context.addIssue({ code: 'custom', path: ['shape'], message: `This shape is not available for a ${line.product}.` });
    }
    if (line.purpose === 'reviews' && !isGoogleLink(line.url)) {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Use your Google Maps or Google review link.' });
    }
  });

const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));

export const placeStandOrderSchema = z.strictObject({
  lines: z.array(standOrderLineSchema).min(1).max(STAND_LIMITS.linesPerOrder),
  customer: z.strictObject({
    name: z.string().trim().min(2).max(80),
    phone: phoneSchema,
    email: z
      .union([emailSchema, z.literal('')])
      .transform((value) => value || null)
      .nullable()
      .default(null),
    city: z.string().trim().min(2).max(60),
    address: z.string().trim().min(5).max(300),
    notes: z
      .string()
      .trim()
      .max(500)
      .transform((value) => value || null)
      .nullable()
      .default(null),
  }),
  paymentMethod: z.enum(STAND_PAYMENT_METHODS),
  /** The total the customer was shown (subtotal plus delivery when known); a different one today is 409 PRICE_CHANGED. */
  expectedTotalPiastres: z.number().int().min(0),
  /** Emails and the order page are written in this language. */
  language: languageSchema.default('ar'),
});

export const standOrdersQuerySchema = z.object({
  /** "open": not yet delivered or cancelled. */
  status: z.union([z.enum(STAND_ORDER_STATUSES), z.literal('open')]).optional(),
  query: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const updateStandOrderStatusSchema = z.strictObject({
  status: z.enum(STAND_ORDER_STATUSES),
  /** Shown in the order's history; required to cancel. */
  note: z.string().trim().max(300).optional(),
}).superRefine((input, context) => {
  if (input.status === 'CANCELLED' && !input.note) {
    context.addIssue({ code: 'custom', path: ['note'], message: 'Say why the order is cancelled.' });
  }
});

export const updateStandOrderSchema = z.strictObject({
  adminNote: z.string().trim().max(1000).nullable().optional(),
  /** Cash collected on delivery. */
  paymentStatus: z.enum(['UNPAID', 'PAID']).optional(),
});

export const shopSettingsSchema = z.strictObject({
  deliveryFeePiastres: z.number().int().min(0).max(100_000).nullable(),
  cashOnDelivery: z.boolean(),
  onlinePayment: z.boolean(),
})
  .refine((settings) => settings.cashOnDelivery || settings.onlinePayment, {
    message: 'Offer at least one way to pay.',
    path: ['cashOnDelivery'],
  })
  // Online payment needs a fixed delivery fee, so "online only" without one would leave no way to pay.
  .refine((settings) => settings.cashOnDelivery || settings.deliveryFeePiastres !== null, {
    message: 'Set a delivery fee, or keep cash on delivery.',
    path: ['deliveryFeePiastres'],
  });

export const standOrderIdParamSchema = z.uuid();
