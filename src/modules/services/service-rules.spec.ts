import { activeDependents, ALL_SERVICES_ON, featuresWithServices, missingRequirements, PLAN_FEATURES, planIncludesService, serviceWorks } from '@bilhanah/contracts';

const off = (...keys: (keyof typeof ALL_SERVICES_ON)[]) => ({ ...ALL_SERVICES_ON, ...Object.fromEntries(keys.map((key) => [key, false])) });

describe('restaurant service rules', () => {
  it('keeps every plan feature while every service is on (restaurants that never chose)', () => {
    expect(featuresWithServices(PLAN_FEATURES.ADVANCED, ALL_SERVICES_ON)).toEqual(PLAN_FEATURES.ADVANCED);
    expect(featuresWithServices(PLAN_FEATURES.MENU, ALL_SERVICES_ON)).toEqual(PLAN_FEATURES.MENU);
  });

  it('narrows features to the services that work, including what they need', () => {
    const noMenu = featuresWithServices(PLAN_FEATURES.ADVANCED, off('DIGITAL_MENU'));
    // Ordering and reviews need the digital menu, even if their own switch is on.
    expect(noMenu).toMatchObject({ menu: false, ordering: false, readyAlerts: false, reviews: false, inventory: true, branches: 10 });
    expect(serviceWorks('QR_ORDERING', off('DIGITAL_MENU'))).toBe(false);
    expect(featuresWithServices(PLAN_FEATURES.ADVANCED, off('INVENTORY'))).toMatchObject({ inventory: false, ordering: true });
    // A service cannot add what the plan lacks.
    expect(featuresWithServices(PLAN_FEATURES.MENU, ALL_SERVICES_ON).inventory).toBe(false);
  });

  it('lists missing requirements and active dependents', () => {
    expect(missingRequirements('QR_ORDERING', off('DIGITAL_MENU'))).toEqual(['DIGITAL_MENU']);
    expect(missingRequirements('INVENTORY', off('DIGITAL_MENU'))).toEqual([]);
    expect(activeDependents('DIGITAL_MENU', ALL_SERVICES_ON)).toEqual(['QR_ORDERING', 'REVIEWS']);
    expect(activeDependents('DIGITAL_MENU', off('QR_ORDERING'))).toEqual(['REVIEWS']);
  });

  it('knows which plans include which service', () => {
    expect(planIncludesService('INVENTORY', PLAN_FEATURES.MENU)).toBe(false);
    expect(planIncludesService('CASH_DRAWER', PLAN_FEATURES.MENU)).toBe(true);
    expect(planIncludesService('DIGITAL_MENU', PLAN_FEATURES.MENU)).toBe(true);
  });
});
