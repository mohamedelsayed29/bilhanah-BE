import { z } from 'zod';

const commaSeparatedOrigins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()));

/**
 * Express "trust proxy": a hop count, or a comma-separated list of proxy
 * addresses/CIDRs (or the names loopback, linklocal, uniquelocal). Trusting
 * every proxy ("true") would let clients spoof their IP and dodge rate limits.
 */
const trustProxy = z
  .string()
  .default('loopback')
  .refine((value) => value.trim() !== '' && value.trim().toLowerCase() !== 'true', {
    message: 'Use a hop count or a list of proxy addresses, not "true".',
  })
  .transform((value) => (/^\d+$/.test(value.trim()) ? Number(value) : value.trim()));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  CORS_ORIGINS: commaSeparatedOrigins,
  /**
   * The platform admin console's origins (its own app, e.g. https://admin.bilhanah.com). Administrator
   * sign-in and sessions only work from these; restaurant dashboards cannot use them. Empty: CORS_ORIGINS.
   */
  ADMIN_ORIGINS: commaSeparatedOrigins,
  TRUST_PROXY: trustProxy,

  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Hard limit on a session's lifetime, however often it is refreshed. */
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  /** Administrator sessions end this many hours after sign-in, however often refreshed. */
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Encrypts administrators' authenticator secrets. Defaults to a key derived from JWT_ACCESS_SECRET. */
  DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
  DASHBOARD_URL: z.url(),
  /** Public restaurant address; `{subdomain}` is replaced, e.g. https://{subdomain}.bilhanah.com */
  RESTAURANT_URL_TEMPLATE: z
    .string()
    .refine((value) => value.includes('{subdomain}') && URL.canParse(value.replace('{subdomain}', 'x')), {
      message: 'Must be a URL containing {subdomain}.',
    }),

  /** Where uploaded images are stored: a local directory (served at /media) or S3-compatible storage such as Cloudflare R2. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** Local driver only. Defaults to var/media at the repository root. */
  STORAGE_LOCAL_DIR: z.string().min(1).optional(),
  /** Base URL that serves stored files, e.g. https://media.bilhanah.com */
  MEDIA_PUBLIC_URL: z.url().default('http://127.0.0.1:3000/media'),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /** Receives messages from the website's contact form. */
  CONTACT_INBOX: z.email().default('hello@bilhanah.com'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(3),

  /**
   * Web Push (order-ready alerts). Generate the pair once with
   * `npm run vapid:generate` and keep it: changing it orphans every diner's
   * subscription. Without it, push is off and the tracking page only rings.
   */
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/, 'An uncompressed P-256 public key, base64url (87 characters).').optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'A P-256 private key, base64url (43 characters).').optional(),
  /** Push services contact this if our messages misbehave: mailto: or https: */
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).default('mailto:hello@bilhanah.com'),

  /** The marketing site, where stand-shop customers return from Paymob. */
  WEBSITE_URL: z.url().default('https://bilhanah.com'),
  /** This API's public origin (e.g. https://api.bilhanah.com), for Paymob's payment callbacks. */
  API_PUBLIC_URL: z.url().optional(),

  /**
   * Online payments with Paymob (Dashboard → Settings / Developers). Without
   * them, owners pay by transfer and the shop takes cash on delivery only.
   */
  PAYMOB_SECRET_KEY: z.string().min(10).optional(),
  PAYMOB_PUBLIC_KEY: z.string().min(10).optional(),
  PAYMOB_HMAC_SECRET: z.string().min(10).optional(),
  /** Integration ids to offer at checkout, comma-separated (e.g. card and wallet). */
  PAYMOB_INTEGRATION_IDS: z
    .string()
    .regex(/^\d+(\s*,\s*\d+)*$/, 'Comma-separated integration ids.')
    .transform((value) => value.split(',').map((id) => Number(id.trim())))
    .optional(),
  PAYMOB_API_URL: z.url().default('https://accept.paymob.com'),
  /** Paymob's hosted checkout; publicKey and clientSecret are added as query parameters. */
  PAYMOB_CHECKOUT_URL: z.url().default('https://eg.checkout.paymob.com/'),
});

export type Env = z.infer<typeof envSchema>;

const envSchemaChecked = envSchema
  .refine((env) => env.SESSION_MAX_DAYS >= env.REFRESH_TOKEN_TTL_DAYS, {
    message: 'SESSION_MAX_DAYS must be at least REFRESH_TOKEN_TTL_DAYS.',
    path: ['SESSION_MAX_DAYS'],
  })
  .superRefine((env, context) => {
    const paymob = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_HMAC_SECRET', 'PAYMOB_INTEGRATION_IDS', 'API_PUBLIC_URL'] as const;
    if (!paymob.slice(0, 4).some((key) => env[key])) return;
    for (const key of paymob) {
      if (!env[key]) context.addIssue({ code: 'custom', path: [key], message: 'Required with the other PAYMOB_* settings.' });
    }
  })
  .refine((env) => !env.VAPID_PUBLIC_KEY === !env.VAPID_PRIVATE_KEY, {
    message: 'Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither.',
    path: ['VAPID_PRIVATE_KEY'],
  })
  .superRefine((env, context) => {
    if (env.STORAGE_DRIVER !== 's3') return;
    for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!env[key]) context.addIssue({ code: 'custom', path: [key], message: 'Required when STORAGE_DRIVER is s3.' });
    }
  });

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchemaChecked.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
