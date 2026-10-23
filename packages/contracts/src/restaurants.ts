import { z } from 'zod';
import { type Language, languageSchema } from './common.js';
import type { ImageSet } from './media.js';
import type { PublicMenuCategory } from './menus.js';
import { type OpeningHours, openingHoursSchema } from './opening-hours.js';
import type { RestaurantAccess } from './plans.js';
import { normalizeSubdomain, subdomainProblem, type SubdomainProblem } from './subdomains.js';

export const RESTAURANT_ERROR_CODES = {
  FORBIDDEN: 'FORBIDDEN',
  RESTAURANT_NOT_FOUND: 'RESTAURANT_NOT_FOUND',
  RESTAURANT_ALREADY_EXISTS: 'RESTAURANT_ALREADY_EXISTS',
  RESTAURANT_SUSPENDED: 'RESTAURANT_SUSPENDED',
  SUBDOMAIN_TAKEN: 'SUBDOMAIN_TAKEN',
} as const;

export const subdomainSchema = z
  .string()
  .max(100)
  .transform(normalizeSubdomain)
  .superRefine((value, context) => {
    const reason = subdomainProblem(value);
    if (reason) {
      context.addIssue({
        code: 'custom',
        message:
          reason === 'RESERVED'
            ? 'This address is reserved. Please choose another.'
            : 'Use 3–40 lowercase letters, digits and single hyphens.',
        params: { reason },
      });
    }
  });

export const subdomainAvailabilityQuerySchema = z.object({ name: z.string().max(100) });

/** Phone numbers are stored as digits, with an optional leading +. */
const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));

const optionalUrlSchema = z
  .union([z.literal('').transform(() => null), z.url({ protocol: /^https?$/ }).max(2048)])
  .nullable()
  .optional();

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone.');

const restaurantDetails = {
  name: z.string().trim().min(2).max(80),
  contactName: z.string().trim().min(2).max(80),
  phone: phoneSchema,
  city: z.string().trim().min(2).max(60),
  address: z.string().trim().min(3).max(200),
  timezone: timezoneSchema.optional(),
  whatsappNumber: phoneSchema.nullable().optional(),
  websiteUrl: optionalUrlSchema,
  facebookUrl: optionalUrlSchema,
  instagramUrl: optionalUrlSchema,
};

export const createRestaurantSchema = z.strictObject({
  ...restaurantDetails,
  subdomain: subdomainSchema,
  defaultLanguage: languageSchema.default('ar'),
});

/** The subdomain is permanent, so it is rejected here as an unknown key. */
export const updateRestaurantSchema = z.strictObject({
  name: restaurantDetails.name.optional(),
  contactName: restaurantDetails.contactName.optional(),
  phone: phoneSchema.optional(),
  city: restaurantDetails.city.optional(),
  address: restaurantDetails.address.optional(),
  defaultLanguage: languageSchema.optional(),
  timezone: restaurantDetails.timezone,
  whatsappNumber: restaurantDetails.whatsappNumber,
  websiteUrl: optionalUrlSchema,
  facebookUrl: optionalUrlSchema,
  instagramUrl: optionalUrlSchema,
  /** Uploaded images (POST /v1/media with kind LOGO or COVER); null removes. */
  logoId: z.uuid().nullable().optional(),
  coverId: z.uuid().nullable().optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #0f5c4c.')
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
  openingHours: openingHoursSchema.nullable().optional(),
  /** Ordering (plans with ordering only): switched on, order types, and a temporary pause. */
  orderingEnabled: z.boolean().optional(),
  acceptsDineIn: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  ordersPaused: z.boolean().optional(),
});

export type OrderingSettings = {
  /** The plan includes ordering. */
  included: boolean;
  enabled: boolean;
  acceptsDineIn: boolean;
  acceptsPickup: boolean;
  paused: boolean;
};

/** What diners need to decide whether to show the cart. Opening hours are checked separately. */
export type PublicOrdering = { accepting: boolean; dineIn: boolean; pickup: boolean };

/** Presentation shared by the owner and public views. */
export type RestaurantBranding = {
  logo: ImageSet | null;
  cover: ImageSet | null;
  brandColor: string | null;
  openingHours: OpeningHours | null;
};

export type SubdomainAvailability =
  | { subdomain: string; available: true }
  | { subdomain: string; available: false; reason: SubdomainProblem | 'TAKEN' };

export type OwnerRestaurant = {
  id: string;
  name: string;
  subdomain: string;
  publicUrl: string;
  contactName: string;
  phone: string;
  city: string;
  address: string;
  defaultLanguage: Language;
  timezone: string;
  whatsappNumber: string | null;
  websiteUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  createdAt: string;
  access: RestaurantAccess;
  ordering: OrderingSettings;
} & RestaurantBranding;

export type PublicRestaurant =
  | ({
      availability: 'AVAILABLE';
      subdomain: string;
      name: string;
      defaultLanguage: Language;
      phone: string;
      city: string;
      address: string;
      whatsappNumber: string | null;
      websiteUrl: string | null;
      facebookUrl: string | null;
      instagramUrl: string | null;
      timezone: string;
      ordering: PublicOrdering;
    } & RestaurantBranding)
  | { availability: 'TEMPORARILY_UNAVAILABLE'; subdomain: string; name: string; defaultLanguage: Language };

/** Everything a diner's phone needs in one request. `categories` is empty while unavailable. */
export type PublicMenuResponse = {
  restaurant: PublicRestaurant;
  categories: PublicMenuCategory[];
};
