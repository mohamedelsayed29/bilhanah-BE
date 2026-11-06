import { describe, expect, it } from 'vitest';
import {
  createWasteSchema,
  DEFAULT_INVENTORY_SETTINGS,
  effectivePermissions,
  GRANTABLE_PERMISSIONS,
  inventorySettingsSchema,
  PLAN_FEATURES,
  purchaseLineSchema,
  recipeLineSchema,
} from '../src/index.js';

describe('inventory contracts', () => {
  it('is in the Menu & Orders and Full Experience plans', () => {
    expect([PLAN_FEATURES.MENU.inventory, PLAN_FEATURES.ORDERS.inventory, PLAN_FEATURES.ADVANCED.inventory]).toEqual([false, true, true]);
  });

  it('lets every staff role be granted every inventory permission', () => {
    const all = ['inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.manage', 'inventory.costs', 'inventory.approve'];
    for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
      expect(effectivePermissions(role, all)).toEqual(expect.arrayContaining(all));
      // Grantable lists hold only what the role lacks by default.
      expect(GRANTABLE_PERMISSIONS[role].filter((permission) => effectivePermissions(role).includes(permission))).toEqual([]);
    }
  });

  it('takes partial settings and normalises waste reason codes', () => {
    expect(inventorySettingsSchema.parse({ deductOn: 'READY' })).toEqual({ deductOn: 'READY' });
    expect(inventorySettingsSchema.parse({ wasteReasons: [{ code: ' burnt ', nameAr: 'اتحرق' }] }).wasteReasons).toEqual([{ code: 'BURNT', nameAr: 'اتحرق', nameEn: null }]);
    expect(inventorySettingsSchema.safeParse({ wasteReasons: [{ code: '1x', nameAr: 'x' }] }).success).toBe(false);
    expect(inventorySettingsSchema.safeParse({ branches: [{ branchId: '0f72445b-78aa-4f84-90de-538527b1fc4d', stockPolicy: 'WARN' }] }).success).toBe(true);
    expect(DEFAULT_INVENTORY_SETTINGS).toMatchObject({ enabled: false, deductOn: 'ACCEPTED', stockPolicy: 'ALLOW_NEGATIVE', autoSoldOut: true, autoRestore: true, valuationBasis: 'AVERAGE' });
    expect(createWasteSchema.parse({ reason: 'spoiled', lines: [{ variantId: '0f72445b-78aa-4f84-90de-538527b1fc4d', quantity: 2 }] }).reason).toBe('SPOILED');
  });

  it('checks quantities, decimals, waste % and purchase prices', () => {
    const id = '0f72445b-78aa-4f84-90de-538527b1fc4d';
    expect(recipeLineSchema.parse({ ingredientId: id, quantity: 0.125 })).toEqual({ ingredientId: id, quantity: 0.125, wastePercent: 0 });
    expect(recipeLineSchema.safeParse({ ingredientId: id, quantity: 0.0001 }).success).toBe(false);
    expect(recipeLineSchema.safeParse({ ingredientId: id, quantity: 1, wastePercent: 91 }).success).toBe(false);
    expect(purchaseLineSchema.safeParse({ ingredientId: id, quantity: 2, unitPrice: 75_000 }).success).toBe(true);
    expect(purchaseLineSchema.safeParse({ ingredientId: id, quantity: 2 }).success).toBe(false);
    expect(purchaseLineSchema.safeParse({ ingredientId: id, quantity: 2, unitPrice: 1, lineTotal: 2 }).success).toBe(false);
  });
});
