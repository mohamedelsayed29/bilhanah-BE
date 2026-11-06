import { assignableRoles, effectivePermissions, grantablePermissions, PERMISSIONS, ROLE_PERMISSIONS } from '@bilhanah/contracts';

describe('restaurant permissions', () => {
  it('gives owners everything and administrators nothing', () => {
    expect(effectivePermissions('OWNER')).toEqual([...PERMISSIONS]);
    expect(effectivePermissions('ADMIN')).toEqual([]);
  });

  it('keeps finances, settings and staff away from the floor roles', () => {
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) {
      const held = ROLE_PERMISSIONS[role];
      for (const permission of ['menu.manage', 'settings.manage', 'staff.manage', 'roles.assign', 'billing.manage', 'analytics.financial'] as const) {
        expect(held).not.toContain(permission);
      }
    }
    expect(ROLE_PERMISSIONS.WAITER).not.toContain('payments.process');
    expect(ROLE_PERMISSIONS.KITCHEN).not.toContain('payments.process');
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain('billing.manage');
    // Cashiers work their own drawer; approving cash and its rules stay with managers and owners.
    expect(ROLE_PERMISSIONS.CASHIER).toContain('cash.operate');
    for (const permission of ['cash.approve', 'cash.settings', 'cash.view'] as const) expect(ROLE_PERMISSIONS.CASHIER).not.toContain(permission);
  });

  it('only adds grants the role may have', () => {
    expect(effectivePermissions('CASHIER', ['payments.refund'])).toContain('payments.refund');
    expect(effectivePermissions('WAITER', ['payments.refund', 'settings.manage'])).toEqual(effectivePermissions('WAITER'));
  });

  it('never lets anyone give OWNER, and managers only the roles below theirs', () => {
    expect(assignableRoles('OWNER', [...PERMISSIONS])).toEqual(['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN']);
    expect(assignableRoles('MANAGER', effectivePermissions('MANAGER'))).toEqual(['CASHIER', 'WAITER', 'KITCHEN']);
    expect(assignableRoles('CASHIER', effectivePermissions('CASHIER'))).toEqual([]);
  });

  it('lets managers grant only what they hold', () => {
    const managerInventory = ['inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.costs'];
    const managerReviews = ['reviews.view', 'reviews.respond', 'reviews.moderate'];
    expect(grantablePermissions('CASHIER', effectivePermissions('MANAGER'))).toEqual(['cash.adjust', 'cash.view', 'support.use', ...managerInventory, ...managerReviews]);
    expect(grantablePermissions('CASHIER', effectivePermissions('MANAGER', ['payments.refund']))).toEqual(['payments.refund', 'cash.adjust', 'cash.view', 'support.use', ...managerInventory, ...managerReviews]);
  });

  it('lets the owner grant every inventory permission to every staff role, on top of the defaults', () => {
    const inventory = ['inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.manage', 'inventory.costs', 'inventory.approve'] as const;
    for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
      expect(effectivePermissions(role, [...inventory])).toEqual(expect.arrayContaining([...inventory]));
    }
    expect(ROLE_PERMISSIONS.MANAGER).toEqual(expect.arrayContaining(['inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.costs']));
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain('inventory.manage');
    expect(ROLE_PERMISSIONS.KITCHEN).toEqual(expect.arrayContaining(['inventory.view', 'inventory.waste']));
    expect(ROLE_PERMISSIONS.KITCHEN).not.toContain('inventory.costs');
    // A manager passes on only what they hold: not inventory.manage until granted it.
    expect(grantablePermissions('KITCHEN', effectivePermissions('MANAGER')).filter((permission) => permission.startsWith('inventory.'))).toEqual(['inventory.operate', 'inventory.costs']);
    expect(grantablePermissions('KITCHEN', effectivePermissions('MANAGER', ['inventory.manage'])).filter((permission) => permission.startsWith('inventory.'))).toEqual(['inventory.operate', 'inventory.manage', 'inventory.costs']);
  });

  it('lets the owner grant every reviews permission to every staff role; managers pass on all but the settings', () => {
    const reviews = ['reviews.view', 'reviews.respond', 'reviews.moderate', 'reviews.settings'] as const;
    for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
      expect(effectivePermissions(role, [...reviews])).toEqual(expect.arrayContaining([...reviews]));
    }
    expect(ROLE_PERMISSIONS.MANAGER).toEqual(expect.arrayContaining(['reviews.view', 'reviews.respond', 'reviews.moderate']));
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain('reviews.settings');
    expect(grantablePermissions('WAITER', effectivePermissions('MANAGER')).filter((permission) => permission.startsWith('reviews.'))).toEqual(['reviews.view', 'reviews.respond', 'reviews.moderate']);
  });
});
