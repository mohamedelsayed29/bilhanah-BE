import { z } from 'zod';
import { type Language, languageSchema } from './common.js';
import type { RestaurantAccess } from './plans.js';

export const RESTAURANT_ERROR_CODES = {
  FORBIDDEN: 'FORBIDDEN',
  RESTAURANT_NOT_FOUND: 'RESTAURANT_NOT_FOUND',
  RESTAURANT_ALREADY_EXISTS: 'RESTAURANT_ALREADY_EXISTS',
  RESTAURANT_SUSPENDED: 'RESTAURANT_SUSPENDED',
  SUBDOMAIN_TAKEN: 'SUBDOMAIN_TAKEN',
} as const;

/** Platform and infrastructure names that can never be a restaurant address. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'api', 'app', 'assets', 'auth', 'billing', 'blog', 'cdn', 'dashboard', 'dev',
  'docs', 'help', 'login', 'mail', 'media', 'menu', 'ns1', 'ns2', 'pay', 'payments', 'portal', 'root',
  'shop', 'signup', 'smtp', 'staging', 'static', 'status', 'store', 'support', 'test', 'www', 'bilhanah',
]);

export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 40;
// Lowercase letters and digits, with single hyphens only between them.
const SUBDOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SubdomainProblem = 'INVALID' | 'RESERVED';

export function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why a normalized subdomain cannot be used, or null when its format is acceptable. */
export function subdomainProblem(subdomain: string): SubdomainProblem | null {
  if (
    subdomain.length < SUBDOMAIN_MIN_LENGTH ||
    subdomain.length > SUBDOMAIN_MAX_LENGTH ||
    !SUBDOMAIN_PATTERN.test(subdomain)
  ) {
    return 'INVALID';
  }
  return RESERVED_SUBDOMAINS.has(subdomain) ? 'RESERVED' : null;
}

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
});

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
};

export type PublicRestaurant =
  | {
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
    }
  | { availability: 'TEMPORARILY_UNAVAILABLE'; subdomain: string; name: string; defaultLanguage: Language };
