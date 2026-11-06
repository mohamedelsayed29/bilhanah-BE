export const PLAN_CODES = ['MENU', 'ORDERS', 'ADVANCED'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanFeatures = {
  menu: boolean;
  ordering: boolean;
  readyAlerts: boolean;
  /** Inventory, recipes and cost management (docs/INVENTORY.md). Which plans include it is decided here only. */
  inventory: boolean;
  /** Feedback and reviews (docs/REVIEWS.md). Which plans include it is decided here only. */
  reviews: boolean;
  /** How many active branches the plan allows. */
  branches: number;
};

export const PLAN_FEATURES: Record<PlanCode, PlanFeatures> = {
  MENU: { menu: true, ordering: false, readyAlerts: false, inventory: false, reviews: false, branches: 1 },
  ORDERS: { menu: true, ordering: true, readyAlerts: false, inventory: true, reviews: true, branches: 3 },
  ADVANCED: { menu: true, ordering: true, readyAlerts: true, inventory: true, reviews: true, branches: 10 },
};

export type AccessStatus = 'TRIAL' | 'PAID' | 'INACTIVE' | 'SUSPENDED';

/** A restaurant's effective access, computed at request time. Dates are ISO strings. */
export type RestaurantAccess = {
  status: AccessStatus;
  planCode: PlanCode | null;
  features: PlanFeatures;
  currentPeriodEndsAt: string | null;
  trialEndsAt: string | null;
};

/** Display names, matching the website's pricing section. */
export const PLAN_NAMES: Record<PlanCode, { ar: string; en: string }> = {
  MENU: { ar: 'منيو', en: 'Menu' },
  ORDERS: { ar: 'منيو وطلبات', en: 'Menu & Orders' },
  ADVANCED: { ar: 'التجربة الكاملة', en: 'The Full Experience' },
};
