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
  await http().post('/v1/auth/verify-email').send({ token: t.mailer.tokenFor(email) }).expect(200);
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
    const verified = await http().post('/v1/auth/verify-email').send({ token }).expect(200);
    expect(verified.body).toEqual({ passwordSetupRequired: false });
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

  it('keeps no password when an unconfirmed email is registered twice', async () => {
    // Someone without access to the inbox registers it first...
    await http()
      .post('/v1/auth/register')
      .send({ email: EMAIL, password: 'attacker-chosen-password', fullName: 'Someone' })
      .expect(202);
    // ...then the real owner registers and confirms.
    await http().post('/v1/auth/register').send({ email: EMAIL, password: PASSWORD, fullName: 'Om Hassan' }).expect(202);
    const verified = await http()
      .post('/v1/auth/verify-email')
      .send({ token: t.mailer.tokenFor(EMAIL) })
      .expect(200);

    expect(verified.body).toEqual({ passwordSetupRequired: true });
    await login(EMAIL, 'attacker-chosen-password').expect(401);
    await login().expect(401);

    // Only the inbox owner can set a password.
    expect(t.mailer.lastTo(EMAIL)?.text).toContain('http://dashboard.test/reset-password#token=');
    await http()
      .post('/v1/auth/reset-password')
      .send({ token: t.mailer.tokenFor(EMAIL), password: NEW_PASSWORD })
      .expect(204);
    await login(EMAIL, NEW_PASSWORD).expect(200);
  });

  it('keeps the password when an unconfirmed email is registered again with it', async () => {
    await http().post('/v1/auth/register').send({ email: EMAIL, password: PASSWORD, fullName: 'Om Hassan' }).expect(202);
    await registerAndVerify();
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

  it('never extends a session past its absolute lifetime', async () => {
    const loggedIn = await login().expect(200);
    const cookie = refreshCookie(loggedIn);
    const [session] = await t.prisma.session.findMany();

    // Signed in 89 days ago: the next refresh may only reach day 90.
    const createdAt = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    await t.prisma.session.update({ where: { id: session!.id }, data: { createdAt } });
    const refreshed = await refresh(cookie).expect(200);
    const capped = await t.prisma.session.findUniqueOrThrow({ where: { id: session!.id } });
    expect(capped.expiresAt.getTime()).toBe(createdAt.getTime() + 90 * 24 * 60 * 60 * 1000);
    const maxAge = Number(/Max-Age=(\d+)/.exec(refreshCookie(refreshed))?.[1]);
    expect(maxAge).toBeGreaterThan(86_000);
    expect(maxAge).toBeLessThanOrEqual(86_400);

    // Past day 90 the session is over, even though its sliding expiry is not.
    await t.prisma.session.update({
      where: { id: session!.id },
      data: { createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    });
    await refresh(refreshCookie(refreshed)).expect(401);
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

describe('account security', () => {
  const OTHER = 'other@koshary.test';

  beforeEach(async () => {
    await registerAndVerify();
  });

  const bearer = (response: request.Response) => `Bearer ${response.body.accessToken}`;

  it('lists active sessions and marks the current one', async () => {
    await login().expect(200);
    const current = await login().expect(200);

    const response = await http().get('/v1/auth/sessions').set('Authorization', bearer(current)).expect(200);
    expect(response.body).toHaveLength(2);
    expect(response.body.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
    expect(response.body[0]).not.toHaveProperty('tokenHash');
  });

  it('signs out another device', async () => {
    const phone = await login().expect(200);
    const laptop = await login().expect(200);
    const sessions = await http().get('/v1/auth/sessions').set('Authorization', bearer(laptop)).expect(200);
    const phoneSession = sessions.body.find((session: { current: boolean }) => !session.current);

    await http().delete(`/v1/auth/sessions/${phoneSession.id}`).set('Authorization', bearer(laptop)).expect(204);

    await http().get('/v1/auth/me').set('Authorization', bearer(phone)).expect(401);
    await http().get('/v1/auth/me').set('Authorization', bearer(laptop)).expect(200);
  });

  it("cannot sign out another account's session", async () => {
    const mine = await login().expect(200);
    await registerAndVerify(OTHER);
    const theirs = await login(OTHER).expect(200);
    const [theirSession] = (await http().get('/v1/auth/sessions').set('Authorization', bearer(theirs))).body;

    const response = await http()
      .delete(`/v1/auth/sessions/${theirSession.id}`)
      .set('Authorization', bearer(mine))
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    await http().get('/v1/auth/me').set('Authorization', bearer(theirs)).expect(200);
  });

  it('changes the password and signs out other sessions only', async () => {
    const other = await login().expect(200);
    const current = await login().expect(200);
    await http().post('/v1/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const pendingReset = t.mailer.tokenFor(EMAIL);

    await http()
      .post('/v1/auth/change-password')
      .set('Authorization', bearer(current))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);

    await http().get('/v1/auth/me').set('Authorization', bearer(current)).expect(200);
    await http().get('/v1/auth/me').set('Authorization', bearer(other)).expect(401);
    await login().expect(401);
    await login(EMAIL, NEW_PASSWORD).expect(200);
    // A reset link sent before the change no longer works.
    await http().post('/v1/auth/reset-password').send({ token: pendingReset, password: 'another-password-1' }).expect(400);
  });

  it('requires the current password', async () => {
    const current = await login().expect(200);
    const response = await http()
      .post('/v1/auth/change-password')
      .set('Authorization', bearer(current))
      .send({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD })
      .expect(400);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    await login().expect(200);
  });

  it('requires a signed-in caller', async () => {
    await http().get('/v1/auth/sessions').expect(401);
    await http().post('/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
  });
});

describe('profile', () => {
  it('updates the name and email language', async () => {
    await registerAndVerify();
    const token = (await login().expect(200)).body.accessToken;

    const updated = await http()
      .patch('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: '  Hassan Ali ', preferredLanguage: 'en' })
      .expect(200);
    expect(updated.body).toMatchObject({ fullName: 'Hassan Ali', preferredLanguage: 'en', email: EMAIL });

    await http().post('/v1/auth/forgot-password').send({ email: EMAIL }).expect(202);
    expect(t.mailer.lastTo(EMAIL)?.subject).toBe('Reset your Bilhanah password');

    // Email and role are not editable here.
    await http().patch('/v1/auth/me').set('Authorization', `Bearer ${token}`).send({ email: 'x@y.test' }).expect(400);
    await http().patch('/v1/auth/me').set('Authorization', `Bearer ${token}`).send({ role: 'ADMIN' }).expect(400);
    await http().patch('/v1/auth/me').send({ fullName: 'Nope' }).expect(401);
  });
});
