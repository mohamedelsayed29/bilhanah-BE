import { pointsFor, rewardDiscount, tierFor } from '@bilhanah/contracts';
import { evaluateReward, loyaltyTargets } from './loyalty-rules.js';

const rules = { pointsPerUnit: 2, spendUnitPiastres: 1000, minOrderPiastres: 0 };
const settings = { earnOn: 'COMPLETED', cancelReturnsRedeemed: true, refundReversesEarned: true, refundReturnsRedeemed: true } as const;
const order = { status: 'COMPLETED', paidAt: null, refundedAt: null, loyaltyPointsToEarn: 10, loyaltyPointsSpent: 5 } as const;
const reward = { type: 'FIXED_DISCOUNT', isActive: true, pointsCost: 10, amountPiastres: 500, percent: null, maxDiscountPiastres: null, menuItemId: null, variantId: null, minOrderPiastres: 0, maxPerMember: null, tierId: null } as const;
const context = { settings: { minRedeemPoints: 0, maxDiscountPercent: 100, orderTypes: ['PICKUP' as const], tiersEnabled: false }, tiers: [], balance: 10, lifetimePoints: 0, redeemedCount: 0 };

describe('loyalty rules', () => {
  it('earns whole spend units, after the minimum, times the tier multiplier', () => {
    expect(pointsFor(2999, rules)).toBe(4);
    expect(pointsFor(2999, { ...rules, minOrderPiastres: 3000 })).toBe(0);
    expect(pointsFor(2999, rules, 150)).toBe(6);
    expect(tierFor([{ minLifetimePoints: 0 }, { minLifetimePoints: 100 }], 99)).toEqual({ minLifetimePoints: 0 });
  });

  it('never discounts more than the subtotal or the cap', () => {
    const lines = [{ menuItemId: 'a', variantId: 'v', unitPricePiastres: 400, quantity: 1 }];
    expect(rewardDiscount(reward, lines)).toBe(400);
    expect(rewardDiscount({ ...reward, type: 'PERCENT_DISCOUNT', percent: 50, maxDiscountPiastres: 150 }, lines)).toBe(150);
    expect(rewardDiscount(reward, lines, 25)).toBe(100);
  });

  it('explains why a reward cannot be used', () => {
    expect(evaluateReward(reward, { ...context, balance: 9 }).reason).toBe('NOT_ENOUGH_POINTS');
    expect(evaluateReward({ ...reward, maxPerMember: 1 }, { ...context, redeemedCount: 1 }).reason).toBe('LIMIT_REACHED');
    expect(evaluateReward(reward, { ...context, order: { type: 'DINE_IN', lines: [] } }).reason).toBe('ORDER_TYPE');
    expect(evaluateReward(reward, context)).toEqual({ reason: null, discountPiastres: 0 });
  });

  it('settles where an order’s points stand from its state and the reversal rules', () => {
    expect(loyaltyTargets(order, settings)).toEqual({ earned: true, held: true });
    expect(loyaltyTargets({ ...order, status: 'READY' }, settings)).toEqual({ earned: false, held: true });
    expect(loyaltyTargets(order, { ...settings, earnOn: 'PAID' }).earned).toBe(false);
    expect(loyaltyTargets({ ...order, paidAt: new Date() }, { ...settings, earnOn: 'PAID' }).earned).toBe(true);
    expect(loyaltyTargets({ ...order, status: 'CANCELLED' }, settings)).toEqual({ earned: false, held: false });
    expect(loyaltyTargets({ ...order, status: 'CANCELLED' }, { ...settings, cancelReturnsRedeemed: false }).held).toBe(true);
    expect(loyaltyTargets({ ...order, refundedAt: new Date() }, settings)).toEqual({ earned: false, held: false });
    expect(loyaltyTargets({ ...order, refundedAt: new Date() }, { ...settings, refundReversesEarned: false, refundReturnsRedeemed: false })).toEqual({ earned: true, held: true });
  });
});
