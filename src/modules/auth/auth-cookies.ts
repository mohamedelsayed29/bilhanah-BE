import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'bh_refresh';

/** The admin console's own session cookie, so a restaurant session and an admin session never share one. */
export const ADMIN_REFRESH_COOKIE = 'bh_admin_refresh';

/**
 * Host-only cookie on the API host, limited to the auth routes. It is never
 * sent to restaurant subdomains or other API routes.
 */
export function refreshCookieOptions(secure: boolean, maxAgeMs?: number, path = '/v1/auth'): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path,
    ...(maxAgeMs !== undefined && { maxAge: maxAgeMs }),
  };
}
