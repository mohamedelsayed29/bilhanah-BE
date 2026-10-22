import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes (hex, 64 characters). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

// A refresh token is `<session id>.<secret>`: the id locates the session and
// the secret is compared against the session's current hash.
const REFRESH_TOKEN_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(value: unknown): { sessionId: string; secret: string } | null {
  if (typeof value !== 'string') return null;
  const match = REFRESH_TOKEN_PATTERN.exec(value);
  return match ? { sessionId: match[1]!, secret: match[2]! } : null;
}
