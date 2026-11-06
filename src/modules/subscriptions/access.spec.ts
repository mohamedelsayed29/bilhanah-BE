import { effectiveFeatures, resolveAccess } from './access.js';

const day = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day);

const trial = { kind: 'TRIAL' as const, planCode: 'ADVANCED' as const, startsAt: at(-10), endsAt: at(20) };

describe('resolveAccess', () => {
  it('grants the trial plan while the trial is running', () => {
    expect(resolveAccess('ACTIVE', [trial], now)).toEqual({
      status: 'TRIAL',
      planCode: 'ADVANCED',
      features: { menu: true, ordering: true, readyAlerts: true, branches: 10 },
      currentPeriodEndsAt: at(20).toISOString(),
      trialEndsAt: at(20).toISOString(),
    });
  });

  it('ends access exactly at endsAt', () => {
    expect(resolveAccess('ACTIVE', [trial], at(20)).status).toBe('INACTIVE');
    expect(resolveAccess('ACTIVE', [trial], new Date(at(20).getTime() - 1)).status).toBe('TRIAL');
  });

  it('is inactive without entitlements', () => {
    expect(resolveAccess('ACTIVE', [], now)).toMatchObject({
      status: 'INACTIVE',
      planCode: null,
      features: { menu: false, ordering: false, readyAlerts: false, branches: 0 },
      trialEndsAt: null,
    });
  });

  it('uses a paid period after the trial', () => {
    const paid = { kind: 'PAID' as const, planCode: 'MENU' as const, startsAt: at(20), endsAt: at(51) };
    expect(resolveAccess('ACTIVE', [trial, paid], at(25))).toMatchObject({
      status: 'PAID',
      planCode: 'MENU',
      features: { menu: true, ordering: false, readyAlerts: false, branches: 1 },
    });
  });

  it('suspension overrides an active entitlement', () => {
    expect(resolveAccess('SUSPENDED', [trial], now)).toMatchObject({ status: 'SUSPENDED', planCode: null });
  });
});
