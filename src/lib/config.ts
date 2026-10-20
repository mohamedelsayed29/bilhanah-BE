/** NestJS API origin. */
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

/** Dashboard origin. Unset until registration is live, so the landing keeps its "coming soon" notice. */
export const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL?.replace(/\/$/, '') || null;

/** Restaurants live at `{subdomain}.{ROOT_DOMAIN}`; locally `{subdomain}.localhost`. */
const ROOT_DOMAIN = (import.meta.env.VITE_ROOT_DOMAIN ?? 'localhost').toLowerCase();

/** The restaurant subdomain for this hostname, or null on the marketing site. */
export function restaurantSubdomain(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${ROOT_DOMAIN}`)) return null;
  const label = host.slice(0, -(ROOT_DOMAIN.length + 1));
  if (!label || label.includes('.') || label === 'www') return null;
  return label;
}

/** Public contact channels shown on the contact page. WhatsApp is hidden until a number is configured. */
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || 'hello@bilhanah.com';
export const CONTACT_WHATSAPP = import.meta.env.VITE_CONTACT_WHATSAPP?.replace(/\D/g, '') || null;
