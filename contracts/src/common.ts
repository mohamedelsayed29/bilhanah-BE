import { z } from 'zod';

export const COMMON_ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export const languageSchema = z.enum(['ar', 'en']);
export type Language = z.infer<typeof languageSchema>;

/** Emails are compared case-insensitively, so they are stored trimmed and lowercased. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
