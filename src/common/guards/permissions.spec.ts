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
    expect(grantablePermissions('CASHIER', effectivePermissions('MANAGER'))).toEqual(['cash.adjust', 'cash.view']);
    expect(grantablePermissions('CASHIER', effectivePermissions('MANAGER', ['payments.refund']))).toEqual(['payments.refund', 'cash.adjust', 'cash.view']);
  });
});
