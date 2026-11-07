import { z } from 'zod';
import type { PlanFeatures } from './plans.js';

/**
 * Restaurant services (docs/SERVICES.md): the parts of Bilhanah a restaurant switches on or off.
 * A restaurant may keep its own QR menu or POS and use only what it needs; switching a service
 * off hides it and stops it working, but never deletes its data.
 *
 * The core of the dashboard (profile, branches, team, reports and support) is always on.
 * A new service is one key here, one rule in SERVICE_RULES and one database enum value.
 */
export const RESTAURANT_SERVICES = ['DIGITAL_MENU', 'QR_ORDERING', 'REVIEWS', 'INVENTORY', 'CASH_DRAWER', 'ATTENDANCE', 'LOYALTY'] as const;
export type RestaurantServiceKey = (typeof RESTAURANT_SERVICES)[number];

/** Always part of the dashboard, whatever services are on. Shown for reference only. */
export const CORE_SERVICES = ['PROFILE', 'BRANCHES', 'TEAM', 'REPORTS', 'SUPPORT'] as const;
export type CoreServiceKey = (typeof CORE_SERVICES)[number];

export type ServiceRule = {
  /** Services that must be on first. */
  requires: RestaurantServiceKey[];
  /** The plan feature that must include it; null when every plan does. */
  plan: Exclude<keyof PlanFeatures, 'branches' | 'readyAlerts'> | null;
};

export const SERVICE_RULES: Record<RestaurantServiceKey, ServiceRule> = {
  DIGITAL_MENU: { requires: [], plan: 'menu' },
  // Diners order from the Bilhanah menu, so ordering needs it.
  QR_ORDERING: { requires: ['DIGITAL_MENU'], plan: 'ordering' },
  // Diners rate from the order tracking page or the menu.
  REVIEWS: { requires: ['DIGITAL_MENU'], plan: 'reviews' },
  // Stock, purchases and waste work on their own; recipes simply need dishes.
  INVENTORY: { requires: [], plan: 'inventory' },
  CASH_DRAWER: { requires: [], plan: null },
  ATTENDANCE: { requires: [], plan: null },
  // Points are earned on orders placed on Bilhanah, so the program needs ordering.
  LOYALTY: { requires: ['QR_ORDERING'], plan: 'ordering' },
};

/** Whether each service is on. Restaurants that never chose keep every service on (how Bilhanah worked before). */
export type ServiceStates = Record<RestaurantServiceKey, boolean>;
export const ALL_SERVICES_ON: ServiceStates = Object.fromEntries(RESTAURANT_SERVICES.map((key) => [key, true])) as ServiceStates;

export const isRestaurantService = (value: unknown): value is RestaurantServiceKey =>
  typeof value === 'string' && (RESTAURANT_SERVICES as readonly string[]).includes(value);

/** Services `key` needs that are off. */
export function missingRequirements(key: RestaurantServiceKey, on: ServiceStates): RestaurantServiceKey[] {
  return SERVICE_RULES[key].requires.filter((required) => !on[required]);
}

/** Services that are on and need `key`; they must be switched off before it. */
export function activeDependents(key: RestaurantServiceKey, on: ServiceStates): RestaurantServiceKey[] {
  return RESTAURANT_SERVICES.filter((other) => on[other] && SERVICE_RULES[other].requires.includes(key));
}

/** Whether the plan's features include the service. */
export function planIncludesService(key: RestaurantServiceKey, plan: PlanFeatures): boolean {
  const feature = SERVICE_RULES[key].plan;
  return feature === null || plan[feature];
}

/** A service works only while it, and everything it needs, is on. */
export function serviceWorks(key: RestaurantServiceKey, on: ServiceStates): boolean {
  return on[key] && SERVICE_RULES[key].requires.every((required) => serviceWorks(required, on));
}

/**
 * What the restaurant may use: its plan's features, narrowed to the services it has on.
 * Every existing feature check (ordering, reviews, inventory, the menu) follows this.
 */
export function featuresWithServices(plan: PlanFeatures, on: ServiceStates): PlanFeatures {
  const ordering = plan.ordering && serviceWorks('QR_ORDERING', on);
  return {
    ...plan,
    menu: plan.menu && serviceWorks('DIGITAL_MENU', on),
    ordering,
    readyAlerts: plan.readyAlerts && ordering,
    reviews: plan.reviews && serviceWorks('REVIEWS', on),
    inventory: plan.inventory && serviceWorks('INVENTORY', on),
  };
}

/** Where the restaurant's menu lives: Bilhanah's digital menu, its own QR menu elsewhere, or none. */
export const MENU_SOURCES = ['BILHANAH', 'EXTERNAL', 'NONE'] as const;
export type MenuSource = (typeof MENU_SOURCES)[number];

/**
 * Where a record came from. Bilhanah's own data (orders placed on its menu) is kept apart from data
 * brought in from another system (a POS or menu provider, when an integration exists).
 */
export const DATA_SOURCES = ['BILHANAH', 'EXTERNAL'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export type RestaurantServiceView = {
  key: RestaurantServiceKey;
  enabled: boolean;
  /** The current plan includes it (false while the restaurant has no access). */
  inPlan: boolean;
  requires: RestaurantServiceKey[];
  /** Required services that are off: it cannot be switched on until they are. */
  missing: RestaurantServiceKey[];
  /** Services that are on and need it: they must be switched off first. */
  dependents: RestaurantServiceKey[];
  /** When it was last switched; null while it has never been chosen. */
  changedAt: string | null;
};

/** The restaurant's setup: where its menu is, its POS, and its services. */
export type RestaurantSetup = {
  menuSource: MenuSource;
  externalMenuUrl: string | null;
  externalPosName: string | null;
  /** When the owner finished (or skipped) choosing services; null while not yet. */
  completedAt: string | null;
  services: RestaurantServiceView[];
};

/** The setup on the owner's restaurant, for navigation and prompts. */
export type RestaurantSetupSummary = Omit<RestaurantSetup, 'services'> & { services: ServiceStates };

const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable());

export const restaurantSetupSchema = z.object({
  menuSource: z.enum(MENU_SOURCES),
  externalMenuUrl: optionalText(500).pipe(z.string().url().refine((url) => /^https?:\/\//i.test(url), 'Use a web address').nullable()).optional(),
  externalPosName: optionalText(60).optional(),
  /** The services to have on; every other one is switched off. Omitted: services stay as they are. */
  services: z.array(z.enum(RESTAURANT_SERVICES)).max(RESTAURANT_SERVICES.length).optional(),
});
export type RestaurantSetupInput = z.input<typeof restaurantSetupSchema>;

export const setServiceSchema = z.object({ enabled: z.boolean() });

export const SERVICE_ERROR_CODES = {
  /** The service is switched off for this restaurant (409). */
  SERVICE_INACTIVE: 'SERVICE_INACTIVE',
  /** A required service is off (409; details.missing). */
  SERVICE_REQUIREMENTS: 'SERVICE_REQUIREMENTS',
  /** Services that need it are on (409; details.dependents). */
  SERVICE_DEPENDENTS: 'SERVICE_DEPENDENTS',
  /** The plan does not include it (409). */
  SERVICE_NOT_IN_PLAN: 'SERVICE_NOT_IN_PLAN',
} as const;

/** Names for messages and screens. */
export const SERVICE_LABELS: Record<RestaurantServiceKey | CoreServiceKey, [string, string]> = {
  DIGITAL_MENU: ['المنيو الرقمي وأكواد QR', 'Digital menu & QR codes'],
  QR_ORDERING: ['الطلب من الموبايل', 'QR ordering'],
  REVIEWS: ['آراء الزباين', 'Feedback & reviews'],
  INVENTORY: ['المخزون والتكلفة', 'Inventory & costing'],
  CASH_DRAWER: ['الخزنة', 'Cash drawer'],
  ATTENDANCE: ['حضور الموظفين', 'Staff attendance'],
  LOYALTY: ['برنامج الولاء والنقاط', 'Loyalty program'],
  PROFILE: ['بيانات المطعم', 'Restaurant profile'],
  BRANCHES: ['الفروع', 'Branches'],
  TEAM: ['الموظفين والصلاحيات', 'Team & permissions'],
  REPORTS: ['التقارير', 'Reports'],
  SUPPORT: ['الدعم الفني ٢٤ ساعة', '24/7 support'],
};
