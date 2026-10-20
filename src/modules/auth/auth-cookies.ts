import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'bh_refresh';

/**
 * Host-only cookie on the API host, limited to the auth routes. It is never
 * sent to restaurant subdomains or other API routes.
 */
export function refreshCookieOptions(secure: boolean, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/v1/auth',
    ...(maxAgeMs !== undefined && { maxAge: maxAgeMs }),
  };
}
