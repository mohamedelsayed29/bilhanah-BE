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

/** The owner signs a kitchen screen in with these; no email is sent to the address. */
export const createKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const updateKitchenAccountSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100).optional(),
  /** False suspends the account and signs its screens out. */
  active: z.boolean().optional(),
});

/** Sets a new password and signs the account's screens out. */
export const setKitchenPasswordSchema = z.strictObject({ password: passwordSchema });

/** A kitchen account, as the owner sees it. */
export type KitchenAccount = {
  id: string;
  fullName: string;
  email: string;
  active: boolean;
  createdAt: string;
  /** The most recent use of any of its sessions. */
  lastSeenAt: string | null;
};

/** What a kitchen screen needs to know about its restaurant. */
export type KitchenContext = {
  restaurant: { name: string; subdomain: string };
  ordering: OrderingSettings;
};
