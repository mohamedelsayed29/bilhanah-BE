import { z } from 'zod';
import { emailSchema } from './common.js';
import { passwordSchema } from './auth.js';
import type { OrderingSettings } from './restaurants.js';

export const KITCHEN_ERROR_CODES = {
  KITCHEN_ACCOUNT_NOT_FOUND: 'KITCHEN_ACCOUNT_NOT_FOUND',
  /** Another account (of any kind) already uses this email. */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  KITCHEN_ACCOUNT_LIMIT_REACHED: 'KITCHEN_ACCOUNT_LIMIT_REACHED',
} as const;

export const KITCHEN_LIMITS = { accounts: 10 } as const;

/** Staff accounts per restaurant (kitchen screens and branch managers together). */
export const STAFF_LIMITS = { accounts: 60 } as const;

/** KITCHEN sees and moves orders; MANAGER also runs the branch (tables, floor, menu overrides, ordering switches, stats). */
export const STAFF_ROLES = ['KITCHEN', 'MANAGER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** The owner signs a kitchen screen in with these; no email is sent to the address. */
export const createKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(STAFF_ROLES).default('KITCHEN'),
  /** The branch the account works at; every branch when null or omitted. */
  branchId: z.uuid().nullable().optional(),
});

export const updateKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100).optional(),
  /** False suspends the account and signs its screens out. */
  active: z.boolean().optional(),
  /** Changing the role or branch signs the account's screens out. */
  role: z.enum(STAFF_ROLES).optional(),
  branchId: z.uuid().nullable().optional(),
});

/** Sets a new password and signs the account's screens out. */
export const setKitchenPasswordSchema = z.strictObject({ password: passwordSchema });

/** A kitchen account, as the owner sees it. */
export type KitchenAccount = {
  id: string;
  fullName: string;
  email: string;
  role: StaffRole;
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
  restaurant: { name: string; subdomain: string };
  /** The account's branch; null when it works at every branch. */
  branch: { id: string; name: string; slug: string } | null;
  /** Branches the account may see (one, or all active ones). */
  branches: { id: string; name: string; slug: string; isMain: boolean }[];
  /** The account's branch's settings (the main branch's for all-branch accounts). */
  ordering: OrderingSettings;
};
