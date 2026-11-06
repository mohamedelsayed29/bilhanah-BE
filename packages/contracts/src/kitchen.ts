import { z } from 'zod';
import { emailSchema } from './common.js';
import { passwordSchema } from './auth.js';
import type { PlanFeatures } from './plans.js';
import type { OrderingSettings } from './restaurants.js';
import { PERMISSIONS, type Permission, STAFF_ROLES, type StaffRole } from './permissions.js';

export const KITCHEN_ERROR_CODES = {
  KITCHEN_ACCOUNT_NOT_FOUND: 'KITCHEN_ACCOUNT_NOT_FOUND',
  /** Another account (of any kind) already uses this email. */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  KITCHEN_ACCOUNT_LIMIT_REACHED: 'KITCHEN_ACCOUNT_LIMIT_REACHED',
  /** 403: the caller may not give this role, or manage an account with the role it has. details: { role, assignable } */
  ROLE_NOT_ASSIGNABLE: 'ROLE_NOT_ASSIGNABLE',
  /** 403: an extra permission the role cannot have, or the caller does not hold. details: { permissions } */
  PERMISSION_NOT_GRANTABLE: 'PERMISSION_NOT_GRANTABLE',
  /** 403: staff cannot change their own role, permissions or status. */
  SELF_CHANGE_FORBIDDEN: 'SELF_CHANGE_FORBIDDEN',
} as const;

export const KITCHEN_LIMITS = { accounts: 10 } as const;

/** Staff accounts per restaurant (kitchen screens and branch managers together). */
export const STAFF_LIMITS = { accounts: 60 } as const;

export { STAFF_ROLES, type StaffRole };

/** Extra permissions on top of the role's (see GRANTABLE_PERMISSIONS); [] or omitted for none. */
const grantsSchema = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).transform((list) => [...new Set(list)]);

/** The owner signs a kitchen screen in with these; no email is sent to the address. */
export const createKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(STAFF_ROLES).default('KITCHEN'),
  /** The branch the account works at; every branch when null or omitted. */
  branchId: z.uuid().nullable().optional(),
  permissions: grantsSchema.default([]),
});

export const updateKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100).optional(),
  /** False suspends the account and signs its screens out. */
  active: z.boolean().optional(),
  /** Changing the role or branch signs the account's screens out. */
  role: z.enum(STAFF_ROLES).optional(),
  branchId: z.uuid().nullable().optional(),
  /** Replaces the extra permissions; grants the new role cannot have are dropped when only the role changes. */
  permissions: grantsSchema.optional(),
});

/** Sets a new password and signs the account's screens out. */
export const setKitchenPasswordSchema = z.strictObject({ password: passwordSchema });

/** A kitchen account, as the owner sees it. */
export type KitchenAccount = {
  id: string;
  fullName: string;
  email: string;
  role: StaffRole;
  /** Extra permissions granted on top of the role's. */
  grants: Permission[];
  /** Everything the account may do (the role's and the grants). */
  permissions: Permission[];
  /** null: every branch. */
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  createdAt: string;
  /** The most recent use of any of its sessions. */
  lastSeenAt: string | null;
};

/** What a kitchen screen needs to know about its restaurant. */
export type KitchenContext = {
  role: StaffRole;
  permissions: Permission[];
  restaurant: { name: string; subdomain: string };
  /** The account's branch; null when it works at every branch. */
  branch: { id: string; name: string; slug: string } | null;
  /** Branches the account may see (one, or all active ones). */
  branches: { id: string; name: string; slug: string; isMain: boolean }[];
  /** The account's branch's settings (the main branch's for all-branch accounts). */
  ordering: OrderingSettings;
  /** The restaurant's usual preparation time, offered when accepting an order; null without one. */
  orderPrepMinutes: number | null;
  /**
   * What the restaurant's plan includes right now (all off without access: expired or suspended),
   * so staff screens can offer inventory and the rest without probing their routes.
   */
  features: PlanFeatures;
};

/** GET /v1/kitchen-accounts/options: what the caller may do on the staff page. */
export type StaffOptions = {
  /** Roles the caller may give and whose accounts they may manage. */
  roles: StaffRole[];
  /** Per role, the extra permissions the caller may grant. */
  grantable: Record<StaffRole, Permission[]>;
  /** A branch-tied manager only manages staff of their branch. */
  branchId: string | null;
};

/** One change on the staff page, for the owner's log: who did what to whom. */
export type StaffAuditEntry = {
  id: string;
  action: 'staff.created' | 'staff.updated' | 'staff.role_changed' | 'staff.permissions_changed' | 'staff.activated' | 'staff.deactivated' | 'staff.password_reset' | 'staff.deleted';
  actorName: string | null;
  targetName: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
};
