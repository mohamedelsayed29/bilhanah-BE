// Subdomain rules without zod, so web apps can use them without bundling the schemas.

/** Platform and infrastructure names that can never be a restaurant address. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'api', 'app', 'assets', 'auth', 'billing', 'blog', 'cdn', 'dashboard', 'dev',
  'docs', 'help', 'login', 'mail', 'media', 'menu', 'ns1', 'ns2', 'pay', 'payments', 'portal', 'root',
  'shop', 'signup', 'smtp', 'staging', 'static', 'status', 'store', 'support', 'test', 'www', 'bilhanah',
]);

export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 40;
// Lowercase letters and digits, with single hyphens only between them.
const SUBDOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SubdomainProblem = 'INVALID' | 'RESERVED';

export function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why a normalized subdomain cannot be used, or null when its format is acceptable. */
export function subdomainProblem(subdomain: string): SubdomainProblem | null {
  if (
    subdomain.length < SUBDOMAIN_MIN_LENGTH ||
    subdomain.length > SUBDOMAIN_MAX_LENGTH ||
    !SUBDOMAIN_PATTERN.test(subdomain)
  ) {
    return 'INVALID';
  }
  return RESERVED_SUBDOMAINS.has(subdomain) ? 'RESERVED' : null;
}
