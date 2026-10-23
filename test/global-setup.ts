import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

/** Creates the test database if needed and applies all migrations to it. */
export default async function setup(): Promise<void> {
  const testUrl = new URL(process.env['DATABASE_URL']!);
  const name = testUrl.pathname.slice(1);
  if (!/^[a-z_]+_test$/.test(name)) throw new Error(`Refusing to use non-test database "${name}"`);

  const admin = new pg.Client({ connectionString: process.env['TEST_ADMIN_DATABASE_URL'] });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '../packages/database'),
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: 'pipe',
  });
}
