import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// E2E tests use the local Docker services but an isolated database
// (bilhanah_test) and Redis logical database 1, so development data is untouched.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '.env'));
} catch {
  // CI provides variables directly.
}

const databaseUrl = new URL(process.env['DATABASE_URL'] ?? 'postgresql://bilhanah:bilhanah_dev_password@127.0.0.1:55432/bilhanah');
process.env['TEST_ADMIN_DATABASE_URL'] = databaseUrl.toString();
databaseUrl.pathname = '/bilhanah_test';
const redisUrl = new URL(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:56379');
redisUrl.pathname = '/1';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL: databaseUrl.toString(),
  REDIS_URL: redisUrl.toString(),
  CORS_ORIGINS: 'http://dashboard.test',
  DASHBOARD_URL: 'http://dashboard.test',
  RESTAURANT_URL_TEMPLATE: 'https://{subdomain}.bilhanah.test',
  JWT_ACCESS_SECRET: 'e2e-test-secret-that-is-at-least-32-characters',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: join(tmpdir(), 'bilhanah-e2e-media'),
  MEDIA_PUBLIC_URL: 'http://api.test/media',
  CONTACT_INBOX: 'hello@bilhanah.test',
  // Required by config validation; tests swap in a fake mailer, so nothing connects here.
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  MAIL_FROM: 'Bilhanah <no-reply@bilhanah.test>',
  // A key pair for tests only; nothing is sent to real push services.
  VAPID_PUBLIC_KEY: 'BAfI8Tl9_-bPlhQIo7Mgxk1GQSgEAaDVUqTTI9kCxL0juiQEsndj7EWoYK9lUcOd0HiOiMD9zET1D5Yx2doIdww',
  VAPID_PRIVATE_KEY: 'W9y_cQ21fMIS6IClYdCWrANBKzgEm2SuG_yxCSXzxV8',
  VAPID_SUBJECT: 'mailto:ops@bilhanah.test',
});

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
