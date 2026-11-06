import { z } from 'zod';
import { emailSchema, type Language, languageSchema } from './common.js';
import type { Permission } from './permissions.js';

export const AUTH_ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_INVALID: 'SESSION_INVALID',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  /** Google sign-in is not configured on this server. */
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
} as const;

/** Sign-in providers besides email and password; each is on only when the server is configured for it. */
export const AUTH_PROVIDERS = ['GOOGLE'] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];
/** GET /v1/auth/providers */
export type AuthProviders = { google: boolean };

/**
 * Why "Continue with Google" did not sign someone in, sent back to the dashboard's login page as
 * ?oauth_error=… (never details from Google).
 */
export const OAUTH_ERRORS = ['cancelled', 'failed', 'expired', 'email_unverified', 'suspended', 'not_allowed', 'disabled'] as const;
export type OAuthError = (typeof OAUTH_ERRORS)[number];

export const userRoleSchema = z.enum(['OWNER', 'ADMIN', 'KITCHEN', 'MANAGER', 'CASHIER', 'WAITER']);
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
  /** "Keep me signed in": true for REMEMBER_ME_DAYS (14), false until the browser closes. Omitted: the standard session. */
  remember: z.boolean().optional(),
});

export const emailOnlySchema = z.object({ email: emailSchema });

export const verifyEmailSchema = z.object({ token: linkTokenSchema });

export const resetPasswordSchema = z.object({ token: linkTokenSchema, password: passwordSchema });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const sessionIdParamSchema = z.uuid();

/** The owner's own name and the language of the emails Bilhanah sends them. */
export const updateProfileSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100).optional(),
  preferredLanguage: languageSchema.optional(),
});

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  preferredLanguage: Language;
  role: UserRole;
  emailVerified: boolean;
  /** What a restaurant account may do (see permissions.ts); [] for administrators. */
  permissions: Permission[];
};

/** A signed-in device, as listed on the account page. */
export type AuthSession = {
  id: string;
  /** True for the session making the request. */
  current: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
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
