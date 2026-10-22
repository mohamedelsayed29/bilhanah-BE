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
  TRUST_PROXY: trustProxy,

  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Hard limit on a session's lifetime, however often it is refreshed. */
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  DASHBOARD_URL: z.url(),
  /** Public restaurant address; `{subdomain}` is replaced, e.g. https://{subdomain}.bilhanah.com */
  RESTAURANT_URL_TEMPLATE: z
    .string()
    .refine((value) => value.includes('{subdomain}') && URL.canParse(value.replace('{subdomain}', 'x')), {
      message: 'Must be a URL containing {subdomain}.',
    }),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(3),
});

export type Env = z.infer<typeof envSchema>;

const envSchemaChecked = envSchema.refine((env) => env.SESSION_MAX_DAYS >= env.REFRESH_TOKEN_TTL_DAYS, {
  message: 'SESSION_MAX_DAYS must be at least REFRESH_TOKEN_TTL_DAYS.',
  path: ['SESSION_MAX_DAYS'],
});

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchemaChecked.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
