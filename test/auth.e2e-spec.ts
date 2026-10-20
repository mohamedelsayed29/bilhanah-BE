import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, type TestApp } from './test-app.js';

const EMAIL = 'owner@koshary.test';
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'new-staple-password-42';

let t: TestApp;
const http = () => request(t.app.getHttpServer());

function refreshCookie(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((value) => value.startsWith('bh_refresh='));
  if (!cookie) throw new Error('No refresh cookie set');
  return cookie;
}

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;

async function registerAndVerify(email = EMAIL, password = PASSWORD) {
  await http().post('/v1/auth/register').send({ email, password, fullName: 'Om Hassan' }).expect(202);
  await http().post('/v1/auth/verify-email').send({ token: t.mailer.tokenFor(email) }).expect(204);
}

function login(email = EMAIL, password = PASSWORD) {
  return http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password });
}

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('registration and email verification', () => {
  it('requires a verified email before login', async () => {
    await http()
      .post('/v1/auth/register')
      .send({ email: '  Owner@Koshary.TEST ', password: PASSWORD, fullName: 'Om Hassan', preferredLanguage: 'en' })
      .expect(202);

    const email = t.mailer.lastTo(EMAIL);
    expect(email?.subject).toBe('Confirm your Bilhanah account');
    expect(email?.text).toContain('http://dashboard.test/verify-email#token=');

    const blocked = await login().expect(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = t.mailer.tokenFor(EMAIL);
    await http().post('/v1/auth/verify-email').send({ token }).expect(204);
    await login().expect(200);

    const reused = await http().post('/v1/auth/verify-email').send({ token }).expect(400);
    expect(reused.body.error.code).toBe('INVALID_TOKEN');
  });

  it('defaults to Arabic emails', async () => {
    await http().post('/v1/auth/register').send({ email: EMAIL, password: PASSWORD, fullName: 'أم حسن' }).expect(202);
    expect(t.mailer.lastTo(EMAIL)?.subject).toBe('فعّل حسابك في بالهنا');
  });

  it('does not reveal or alter an existing account', async () => {
    await registerAndVerify();
    await http()
      .post('/v1/auth/register')
      .send({ email: EMAIL, password: 'attacker-chosen-password', fullName: 'Someone' })
      .expect(202);

    expect(t.mailer.lastTo(EMAIL)?.subject).toBe('حسابك في بالهنا موجود بالفعل');
    await login(EMAIL, 'attacker-chosen-password').expect(401);
    await login().expect(200);
  });

  it('only stores a hash of the password and tokens', async () => {
    await http().post('/v1/auth/register').send({ email: EMAIL, password: PASSWORD, fullName: 'Om Hassan' }).expect(202);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const token = t.mailer.tokenFor(EMAIL);
    const stored = await t.prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toHaveLength(64);
  });

  it('rejects invalid input with field details', async () => {
    const response = await http()
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', fullName: 'O' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'email',
      'fullName',
      'password',
    ]);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await registerAndVerify();
  });

  it('returns an access token and sets a restricted refresh cookie', async () => {
    const response = await login().expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      accessTokenExpiresIn: 900,
      user: { email: EMAIL, fullName: 'Om Hassan', role: 'OWNER', preferredLanguage: 'ar', emailVerified: true },
    });

    const cookie = refreshCookie(response);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/v1\/auth/);

    const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(200);
    expect(me.body.email).toBe(EMAIL);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login(EMAIL, 'wrong-password-123').expect(401);
    const unknownEmail = await login('nobody@koshary.test', PASSWORD).expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('rejects requests from untrusted origins', async () => {
    const missing = await http().post('/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(403);
    expect(missing.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    await http()
      .post('/v1/auth/login')
      .set('Origin', 'https://evil.test')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(403);
  });

  it('rate-limits repeated attempts for one email', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await login(EMAIL, 'wrong-password-123').expect(401);
    }
    const limited = await login().expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('blocks suspended accounts, including existing sessions', async () => {
    const { body } = await login().expect(200);
    await t.prisma.user.update({ where: { email: EMAIL }, data: { status: 'SUSPENDED' } });

    const blocked = await login().expect(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${body.accessToken}`).expect(401);
  });

  it('does not let administrators use the owner login', async () => {
    await t.prisma.user.update({ where: { email: EMAIL }, data: { role: 'ADMIN' } });
    await login().expect(401);
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await registerAndVerify();
  });

  const refresh = (cookie: string) =>
    http().post('/v1/auth/refresh').set('Origin', DASHBOARD_ORIGIN).set('Cookie', cookiePair(cookie));

  it('rotates the refresh token on every use', async () => {
    const first = refreshCookie(await login().expect(200));
    const refreshed = await refresh(first).expect(200);
    const second = refreshCookie(refreshed);
    expect(cookiePair(second)).not.toBe(cookiePair(first));
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    await refresh(second).expect(200);
  });

  it('revokes the session when a rotated-out token is reused', async () => {
    const loggedIn = await login().expect(200);
    const stolen = refreshCookie(loggedIn);
    const current = refreshCookie(await refresh(stolen).expect(200));

    const reuse = await refresh(stolen).expect(401);
    expect(reuse.body.error.code).toBe('SESSION_INVALID');

    // The legitimate holder is signed out too.
    await refresh(current).expect(401);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${loggedIn.body.accessToken}`).expect(401);
  });

  it('logout ends the session and clears the cookie', async () => {
    const loggedIn = await login().expect(200);
    const cookie = refreshCookie(loggedIn);

    const response = await http()
      .post('/v1/auth/logout')
      .set('Origin', DASHBOARD_ORIGIN)
      .set('Cookie', cookiePair(cookie))
      .expect(204);
    expect(refreshCookie(response)).toMatch(/bh_refresh=;/);

    await refresh(cookie).expect(401);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${loggedIn.body.accessToken}`).expect(401);
  });

  it('requires a valid bearer token for /me', async () => {
    await http().get('/v1/auth/me').expect(401);
    const response = await http().get('/v1/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    await registerAndVerify();
  });

  it('does not reveal whether an email is registered', async () => {
    await http().post('/v1/auth/forgot-password').send({ email: 'nobody@koshary.test' }).expect(202);
    expect(t.mailer.lastTo('nobody@koshary.test')).toBeUndefined();
  });

  it('sets a new password and signs out every session', async () => {
    const existing = await login().expect(200);

    await http().post('/v1/auth/forgot-password').send({ email: EMAIL }).expect(202);
    expect(t.mailer.lastTo(EMAIL)?.text).toContain('http://dashboard.test/reset-password#token=');
    const token = t.mailer.tokenFor(EMAIL);

    await http().post('/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }).expect(204);

    await http().get('/v1/auth/me').set('Authorization', `Bearer ${existing.body.accessToken}`).expect(401);
    await login().expect(401);
    await login(EMAIL, NEW_PASSWORD).expect(200);

    const reused = await http().post('/v1/auth/reset-password').send({ token, password: 'another-password-1' }).expect(400);
    expect(reused.body.error.code).toBe('INVALID_TOKEN');
  });

  it('only the newest reset link works', async () => {
    await http().post('/v1/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const older = t.mailer.tokenFor(EMAIL);
    await http().post('/v1/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const newer = t.mailer.tokenFor(EMAIL);

    await http().post('/v1/auth/reset-password').send({ token: older, password: NEW_PASSWORD }).expect(400);
    await http().post('/v1/auth/reset-password').send({ token: newer, password: NEW_PASSWORD }).expect(204);
  });
});
