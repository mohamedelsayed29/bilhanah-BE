import { z } from 'zod';
import type { MenuVariant, OwnerMenuItem } from './menus.js';
import { pricePiastresSchema } from './menus.js';
import { type OpeningHours, openingHoursSchema } from './opening-hours.js';
import { contactPhoneSchema, type OrderingSettings, optionalUrlSchema } from './restaurants.js';

// Multi-branch restaurants. The restaurant is the brand: one subdomain, one
// shared menu, one subscription. Each branch has its own location, opening
// hours, ordering switches, tables, orders, staff, and may override the shared
// menu (hide a dish, mark it sold out, set its own price).

export const BRANCH_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  /** details: { limit } — the plan's branch allowance is used up. */
  BRANCH_LIMIT_REACHED: 'BRANCH_LIMIT_REACHED',
  BRANCH_SLUG_TAKEN: 'BRANCH_SLUG_TAKEN',
  /** The main branch cannot be archived or deleted; make another branch main first. */
  MAIN_BRANCH_LOCKED: 'MAIN_BRANCH_LOCKED',
  /** A branch that has received orders is archived, not deleted, so its history stays. */
  BRANCH_HAS_ORDERS: 'BRANCH_HAS_ORDERS',
  /** details: { count } — move or delete the branch's staff accounts first. */
  BRANCH_HAS_STAFF: 'BRANCH_HAS_STAFF',
  BRANCH_ARCHIVED: 'BRANCH_ARCHIVED',
  /** A staff account tried to act on a branch it does not work at. */
  BRANCH_FORBIDDEN: 'BRANCH_FORBIDDEN',
  /** A price was given for a size that does not belong to the dish. */
  VARIANT_MISMATCH: 'VARIANT_MISMATCH',
} as const;

/** A hard ceiling regardless of plan; plans set lower allowances (PLAN_FEATURES.branches). */
export const BRANCH_LIMITS = { max: 50 } as const;

/** The slug of the branch every existing restaurant got when branches were introduced. */
export const MAIN_BRANCH_SLUG = 'main';

export const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Part of the branch's public address (?b=slug): lowercase letters, digits and single hyphens. */
export const branchSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(BRANCH_SLUG_PATTERN, 'Use 2–40 lowercase letters, digits and single hyphens.');

/** Turns a branch name into a slug suggestion ("Nasr City" → "nasr-city"); empty for non-Latin names. */
export function suggestBranchSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const branchDetails = {
  name: z.string().trim().min(2).max(80),
  phone: contactPhoneSchema,
  whatsappNumber: contactPhoneSchema.nullable().optional(),
  city: z.string().trim().min(2).max(60),
  address: z.string().trim().min(3).max(200),
  mapUrl: optionalUrlSchema,
  /** The branch's "write a review" link on Google, offered to happy diners (docs/REVIEWS.md). */
  googleReviewUrl: optionalUrlSchema,
  openingHours: openingHoursSchema.nullable().optional(),
};

export const createBranchSchema = z.strictObject({
  ...branchDetails,
  slug: branchSlugSchema,
  /** Copy tables (names, shapes, seats, locations, areas; new QR codes) from another branch. */
  copyTablesFrom: z.uuid().optional(),
});

/**
 * Owners may change everything. Branch managers may change the branch's
 * contact details, hours and ordering switches, but not its name, slug,
 * main/archived state (those fields are refused for them).
 */
export const updateBranchSchema = z.strictObject({
  name: branchDetails.name.optional(),
  slug: branchSlugSchema.optional(),
  phone: contactPhoneSchema.optional(),
  whatsappNumber: branchDetails.whatsappNumber,
  city: branchDetails.city.optional(),
  address: branchDetails.address.optional(),
  mapUrl: optionalUrlSchema,
  googleReviewUrl: optionalUrlSchema,
  openingHours: branchDetails.openingHours,
  /** False archives the branch: hidden from diners, no new orders, history kept. */
  isActive: z.boolean().optional(),
  orderingEnabled: z.boolean().optional(),
  acceptsDineIn: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  ordersPaused: z.boolean().optional(),
});

/** Fields only the owner may change. */
export const OWNER_ONLY_BRANCH_FIELDS = ['name', 'slug', 'isActive'] as const;

export const reorderBranchesSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(BRANCH_LIMITS.max) });

export const branchIdParamSchema = z.uuid();

/** A branch as its owner (or manager) sees it. */
export type OwnerBranch = {
  id: string;
  name: string;
  slug: string;
  isMain: boolean;
  isActive: boolean;
  phone: string;
  whatsappNumber: string | null;
  city: string;
  address: string;
  mapUrl: string | null;
  /** Google "write a review" link for happy diners. */
  googleReviewUrl: string | null;
  openingHours: OpeningHours | null;
  ordering: OrderingSettings;
  /** The branch's own menu link; table QR codes point at tables directly. */
  publicUrl: string;
  tableCount: number;
  staffCount: number;
  /** Orders still on the board right now. */
  activeOrders: number;
  createdAt: string;
};

/** GET /v1/branches: every branch plus the plan's allowance. */
export type BranchList = {
  branches: OwnerBranch[];
  /** How many branches the plan allows (0 while there is no access); archived branches do not count. */
  limit: number;
  /** Active branches. */
  used: number;
};

/** A branch as diners see it. */
export type PublicBranch = {
  slug: string;
  name: string;
  isMain: boolean;
  phone: string;
  whatsappNumber: string | null;
  city: string;
  address: string;
  mapUrl: string | null;
  googleReviewUrl: string | null;
  openingHours: OpeningHours | null;
  /** Taking orders right now, opening hours aside (they are checked by the client and the server). */
  acceptingOrders: boolean;
};

// --- Branch menu overrides ------------------------------------------------------

/** What a branch has changed about a shared dish. */
export type BranchItemOverride = {
  /** null follows the shared menu; false marks the dish sold out at this branch. */
  available: boolean | null;
  /** The branch does not offer this dish. */
  hidden: boolean;
  /** The sold-out mark was set by inventory (an ingredient ran out); restocking lifts it. Any manual change replaces it. */
  soldOutByInventory: boolean;
  /** Own prices by size (variant id); sizes missing here use the shared price. */
  prices: Record<string, number>;
};

/** A shared dish with this branch's override and the result diners see. */
export type BranchMenuItem = OwnerMenuItem & {
  override: BranchItemOverride;
  effective: { available: boolean; visible: boolean; variants: MenuVariant[] };
};

export type BranchMenuCategory = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  isVisible: boolean;
  items: BranchMenuItem[];
};

/** GET /v1/branches/:id/menu */
export type BranchMenu = { branchId: string; categories: BranchMenuCategory[] };

/**
 * PUT /v1/branches/:id/menu/items/:itemId. Omitted fields stay as they are.
 * A price of null goes back to the shared price. Kitchen screens may only send `available`.
 */
export const setBranchItemSchema = z.strictObject({
  available: z.boolean().nullable().optional(),
  hidden: z.boolean().optional(),
  prices: z
    .array(z.strictObject({ variantId: z.uuid(), pricePiastres: pricePiastresSchema.nullable() }))
    .max(10)
    .optional(),
});

/** POST /v1/branches/:id/menu/reset: drops every override, back to the shared menu. */
export type BranchMenuReset = { removed: number };

/** POST /v1/branches/:id/menu/copy-from/:sourceId: copies another branch's overrides over this one. */
export type BranchMenuCopy = { copied: number };

// --- Comparing branches ---------------------------------------------------------

/** GET /v1/restaurants/mine/stats/branches?days= — one row per branch, rejected and cancelled orders excluded. */
export type BranchComparison = {
  days: number;
  branches: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    orders: number;
    revenuePiastres: number;
    averageOrderPiastres: number;
    /** Median minutes from placed to ready, over orders that reached ready; null without any. */
    medianPrepMinutes: number | null;
    dineIn: number;
    pickup: number;
    /** Share of the restaurant's revenue in the period, 0–1. */
    revenueShare: number;
  }[];
};
