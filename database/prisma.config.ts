import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Local development reads the workspace-root .env; CI and deployments set DATABASE_URL directly.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  // No .env file.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
});
