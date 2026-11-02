export const PLAN_CODES = ['MENU', 'ORDERS', 'ADVANCED'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanFeatures = {
  menu: boolean;
  ordering: boolean;
  readyAlerts: boolean;
  /** How many active branches the plan allows. */
  branches: number;
};

export const PLAN_FEATURES: Record<PlanCode, PlanFeatures> = {
  MENU: { menu: true, ordering: false, readyAlerts: false, branches: 1 },
  ORDERS: { menu: true, ordering: true, readyAlerts: false, branches: 3 },
  ADVANCED: { menu: true, ordering: true, readyAlerts: true, branches: 10 },
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
