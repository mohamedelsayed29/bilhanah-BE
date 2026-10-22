import { z } from 'zod';
import { emailSchema, type Language, languageSchema } from './common.js';

export const AUTH_ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_INVALID: 'SESSION_INVALID',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
} as const;

export const userRoleSchema = z.enum(['OWNER', 'ADMIN']);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Restaurant-owner password. Administrators have a longer minimum (see the backend admin command). */
export const passwordSchema = z.string().min(8).max(128);

/** Single-use tokens from email links. */
const linkTokenSchema = z.string().min(1).max(256);

export const registerOwnerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100),
  preferredLanguage: languageSchema.default('ar'),
});

export const loginSchema = z.object({
  email: emailSchema,
  // Not checked against the password policy, so a policy change never locks anyone out.
  password: z.string().min(1).max(128),
});

export const emailOnlySchema = z.object({ email: emailSchema });

export const verifyEmailSchema = z.object({ token: linkTokenSchema });

export const resetPasswordSchema = z.object({ token: linkTokenSchema, password: passwordSchema });

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  preferredLanguage: Language;
  role: UserRole;
  emailVerified: boolean;
};

export type VerifyEmailResponse = {
  /**
   * True when the account has no usable password yet (it was registered more
   * than once before confirmation). A link to set one has been emailed.
   */
  passwordSetupRequired: boolean;
};

export type SessionResponse = {
  accessToken: string;
  /** Seconds. */
  accessTokenExpiresIn: number;
  user: AuthUser;
};
