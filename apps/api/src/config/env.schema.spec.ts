import { validateEnv } from './env.schema.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  DASHBOARD_URL: 'http://localhost:5174',
  RESTAURANT_URL_TEMPLATE: 'https://{subdomain}.bilhanah.com',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Bilhanah <no-reply@bilhanah.com>',
};

describe('validateEnv', () => {
  it('applies defaults and parses origins', () => {
    const env = validateEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects a missing database URL', () => {
    const { DATABASE_URL: _, ...withoutDatabase } = valid;
    expect(() => validateEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('requires the {subdomain} placeholder in the restaurant URL template', () => {
    expect(() => validateEnv({ ...valid, RESTAURANT_URL_TEMPLATE: 'https://bilhanah.com' })).toThrow(
      /RESTAURANT_URL_TEMPLATE/,
    );
  });

  it('rejects a non-postgres database URL', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('reads TRUST_PROXY as a hop count or an address list', () => {
    expect(validateEnv(valid).TRUST_PROXY).toBe('loopback');
    expect(validateEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(validateEnv({ ...valid, TRUST_PROXY: '10.0.0.0/8, loopback' }).TRUST_PROXY).toBe('10.0.0.0/8, loopback');
  });

  it('refuses to trust every proxy', () => {
    expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('keeps the session cap at or above the refresh lifetime', () => {
    expect(validateEnv(valid).SESSION_MAX_DAYS).toBe(90);
    expect(() => validateEnv({ ...valid, REFRESH_TOKEN_TTL_DAYS: '30', SESSION_MAX_DAYS: '7' })).toThrow(
      /SESSION_MAX_DAYS/,
    );
  });
});
