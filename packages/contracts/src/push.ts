// Order-ready alerts (the Full Experience plan). Free of zod, so the website can
// import it without the schema library.
import type { OrderStatus } from './orders.js';

export const ALERT_ERROR_CODES = {
  /** details.reason: PLAN (the plan has no ready alerts), NOT_CONFIGURED (the server has no push keys) or ORDER_FINISHED. */
  PUSH_UNAVAILABLE: 'PUSH_UNAVAILABLE',
} as const;

export const PUSH_LIMITS = { subscriptionsPerOrder: 5 } as const;

/**
 * The browsers' push services. The API only delivers to these, so a diner
 * cannot make the server send requests to other hosts.
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Android, Samsung Internet, Opera
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS, and iOS Home Screen apps)
  '.notify.windows.com', // Edge (WNS: wns2-*.notify.windows.com)
] as const;

/** True for an https URL on one of PUSH_SERVICE_HOSTS (a leading dot matches subdomains). */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => (allowed.startsWith('.') ? host.endsWith(allowed) && host.length > allowed.length : host === allowed));
}

/** GET /v1/public/orders/:token/alerts */
export type OrderAlerts = {
  /** The restaurant's plan includes ready alerts: sound and vibration on the tracking page. */
  readyAlerts: boolean;
  /** Web Push, when readyAlerts is on and the server can send it: subscribe with this VAPID key. */
  push: { publicKey: string } | null;
};

/** The JSON a push message carries; the service worker shows it as a notification. */
export type OrderPushPayload = {
  title: string;
  body: string;
  /** The order's tracking page. */
  url: string;
  /** One notification per order: a newer status replaces the older one. */
  tag: string;
  status: OrderStatus;
  /** The restaurant's logo (a square rendition), if it has one. */
  icon: string | null;
};
