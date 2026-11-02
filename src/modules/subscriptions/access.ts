import { PLAN_FEATURES, type PlanFeatures, type RestaurantAccess } from '@bilhanah/contracts';
import type { Entitlement, RestaurantStatus } from '@bilhanah/database';

const NO_FEATURES: PlanFeatures = { menu: false, ordering: false, readyAlerts: false, branches: 0 };

type EntitlementPeriod = Pick<Entitlement, 'kind' | 'planCode' | 'startsAt' | 'endsAt'>;

/**
 * Effective access at `now`. Manual suspension overrides every entitlement;
 * otherwise the entitlement covering `now` decides the plan.
 */
export function resolveAccess(
  restaurantStatus: RestaurantStatus,
  entitlements: readonly EntitlementPeriod[],
  now: Date,
): RestaurantAccess {
  const trial = entitlements.find((entitlement) => entitlement.kind === 'TRIAL');
  const trialEndsAt = trial ? trial.endsAt.toISOString() : null;

  const current = entitlements
    .filter((entitlement) => entitlement.startsAt <= now && now < entitlement.endsAt)
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];

  if (restaurantStatus === 'SUSPENDED' || !current) {
    return {
      status: restaurantStatus === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE',
      planCode: null,
      features: NO_FEATURES,
      currentPeriodEndsAt: null,
      trialEndsAt,
    };
  }

  return {
    status: current.kind,
    planCode: current.planCode,
    features: PLAN_FEATURES[current.planCode],
    currentPeriodEndsAt: current.endsAt.toISOString(),
    trialEndsAt,
  };
}

export function hasAccess(access: RestaurantAccess): boolean {
  return access.status === 'TRIAL' || access.status === 'PAID';
}
