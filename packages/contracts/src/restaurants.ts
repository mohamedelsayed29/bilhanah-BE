import { z } from 'zod';
import { SERVICE_REQUEST_THROTTLE } from './service-requests.js';
import type { PublicRecommendation } from './recommendations.js';
import { type Language, languageSchema } from './common.js';
import { MENU_THEMES, type MenuTheme } from './themes.js';
import { EXTRA_MENU_LANGUAGES, type ExtraMenuLanguage } from './menu-languages.js';
import type { ImageSet } from './media.js';
import type { PublicMenuCategory } from './menus.js';
import { type OpeningHours, openingHoursSchema } from './opening-hours.js';
import type { RestaurantAccess } from './plans.js';
import type { RestaurantSetupSummary } from './services.js';
import type { PublicBranch } from './branches.js';
import type { PublicReviewsInfo } from './review-display.js';
import { normalizeSubdomain, subdomainProblem, type SubdomainProblem } from './subdomains.js';

/** Minutes the restaurant may give as an order's preparation estimate. */
export const ORDER_PREP_MINUTES = { min: 5, max: 120 } as const;

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
export const contactPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number.'));

export const optionalUrlSchema = z
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
  phone: contactPhoneSchema,
  city: z.string().trim().min(2).max(60),
  address: z.string().trim().min(3).max(200),
  timezone: timezoneSchema.optional(),
  whatsappNumber: contactPhoneSchema.nullable().optional(),
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
  phone: contactPhoneSchema.optional(),
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
  /** How the public menu looks (see themes.ts). */
  menuTheme: z.enum(MENU_THEMES).optional(),
  /** Languages diners may read the menu in besides Arabic and English, in the order offered. */
  menuLanguages: z
    .array(z.enum(EXTRA_MENU_LANGUAGES))
    .max(EXTRA_MENU_LANGUAGES.length)
    .refine((codes) => new Set(codes).size === codes.length, 'List each language once.')
    .optional(),
  /**
   * Ordering (plans with ordering only): switched on, order types, and a temporary pause.
   * These and openingHours apply to the main branch; other branches are edited at /v1/branches.
   */
  orderingEnabled: z.boolean().optional(),
  acceptsDineIn: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  ordersPaused: z.boolean().optional(),
  /** Table service requests from the menu, and their throttling (see service-requests.ts). */
  serviceRequestsEnabled: z.boolean().optional(),
  serviceRequestCooldownSeconds: z.number().int().min(SERVICE_REQUEST_THROTTLE.cooldownSeconds.min).max(SERVICE_REQUEST_THROTTLE.cooldownSeconds.max).optional(),
  serviceRequestHourlyLimit: z.number().int().min(SERVICE_REQUEST_THROTTLE.hourlyLimit.min).max(SERVICE_REQUEST_THROTTLE.hourlyLimit.max).optional(),
  /** Shared table sessions: guests at a scanned table build one order together (see table-sessions.ts). */
  tableSessionsEnabled: z.boolean().optional(),
  /** Guests may change and remove each other's unsent dishes, not only their own. */
  tableSessionSharedEditing: z.boolean().optional(),
  /** The usual preparation time diners see when an order is accepted; null shows none. */
  orderPrepMinutes: z.number().int().min(ORDER_PREP_MINUTES.min).max(ORDER_PREP_MINUTES.max).nullable().optional(),
});

/** Table service requests: switched on, and how they are throttled. */
export type ServiceRequestSettings = { enabled: boolean; cooldownSeconds: number; hourlyLimit: number };

export type OrderingSettings = {
  /** The plan includes ordering. */
  included: boolean;
  enabled: boolean;
  acceptsDineIn: boolean;
  acceptsPickup: boolean;
  paused: boolean;
};

/**
 * What diners need to decide whether to show the cart. Opening hours are checked separately.
 * `serviceRequests`: a diner at a table can call the staff from the menu.
 */
export type PublicOrdering = { accepting: boolean; dineIn: boolean; pickup: boolean; serviceRequests: boolean; /** Guests at a scanned table order together. */ sharedTable: boolean };

/** Presentation shared by the owner and public views. */
export type RestaurantBranding = {
  logo: ImageSet | null;
  cover: ImageSet | null;
  brandColor: string | null;
  openingHours: OpeningHours | null;
  menuTheme: MenuTheme;
  /** Extra menu languages offered to diners (Arabic and English are always available). */
  menuLanguages: ExtraMenuLanguage[];
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
  /** Where the menu is, the POS, and which services are on (services.ts). */
  setup: RestaurantSetupSummary;
  /** The main branch's ordering settings (openingHours is the main branch's too). */
  ordering: OrderingSettings;
  serviceRequests: ServiceRequestSettings;
  tableSessions: { enabled: boolean; sharedEditing: boolean };
  /** The usual preparation time shown to diners on accepted orders; null shows none. */
  orderPrepMinutes: number | null;
  mainBranchId: string;
  /** Active branches. */
  branchCount: number;
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
      /** The chosen branch's (phone, city, address, openingHours and ordering above are the chosen branch's too). */
      ordering: PublicOrdering;
      branch: PublicBranch;
      /** Every active branch, main first; more than one means diners may pick. */
      branches: PublicBranch[];
      /** Diners' reviews (docs/REVIEWS.md); null when the plan has none. */
      reviews: PublicReviewsInfo | null;
    } & RestaurantBranding)
  | { availability: 'TEMPORARILY_UNAVAILABLE'; subdomain: string; name: string; defaultLanguage: Language };

/** Everything a diner's phone needs in one request. `categories` is empty while unavailable. */
export type PublicMenuResponse = {
  restaurant: PublicRestaurant;
  categories: PublicMenuCategory[];
  /** Suggestions for this branch's menu (see recommendations.ts); empty when there are none. */
  recommendations: PublicRecommendation[];
};
