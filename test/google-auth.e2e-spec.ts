import request from 'supertest';
import { vi } from 'vitest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

// Google sign-in is on for this file only; Google's token endpoint is replaced by a fake below.
process.env['GOOGLE_CLIENT_ID'] = 'test-client-id.apps.googleusercontent.com';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-client-secret';
process.env['GOOGLE_REDIRECT_URI'] = 'http://api.test/v1/auth/google/callback';

let t: TestApp;
const http = () => request(t.app.getHttpServer());

type Claims = Record<string, unknown>;
const realFetch = globalThis.fetch;
let nextClaims: (nonce: string) => Claims;
let tokenRequests: URLSearchParams[] = [];
let challenge = '';

const idToken = (claims: Claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const googleUser = (overrides: Claims = {}) => (nonce: string): Claims => ({
  iss: 'https://accounts.google.com', aud: process.env['GOOGLE_CLIENT_ID'], sub: '1234567890', email: 'Mona@Gmail.com', email_verified: true,
  name: 'منى أحمد', nonce, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
});

/** Starts at /google/start, then plays Google: returns to the callback with a code. */
async function signInWithGoogle(options: { claims?: (nonce: string) => Claims; tamperState?: boolean; withoutCookie?: boolean } = {}) {
  nextClaims = options.claims ?? googleUser();
  const start = await http().get('/v1/auth/google/start?lang=ar').expect(302);
  const google = new URL(start.headers['location'] as string);
  expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(google.searchParams.get('code_challenge_method')).toBe('S256');
  expect(google.searchParams.get('redirect_uri')).toBe('http://api.test/v1/auth/google/callback');
  challenge = google.searchParams.get('code_challenge')!;
  const cookie = (start.headers['set-cookie'] as unknown as string[]).find((entry) => entry.startsWith('bh_oauth='))!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  const nonce = google.searchParams.get('nonce')!;
  pendingNonce = nonce;
  const state = options.tamperState ? 'not-the-state' : google.searchParams.get('state')!;
  const callback = http().get(`/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state)}`);
  if (!options.withoutCookie) callback.set('Cookie', cookie.split(';')[0]!);
  return callback.expect(302);
}
let pendingNonce = '';

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== 'https://oauth2.googleapis.com/token') return realFetch(input, init);
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    return new Response(JSON.stringify({ access_token: 'x', id_token: idToken(nextClaims(pendingNonce)) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  t = await createTestApp();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t.app.close();
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete process.env[key];
});
beforeEach(async () => { await t.reset(); tokenRequests = []; });

describe('continue with Google', () => {
  it('says it is offered, creates a verified owner on first sign-in, and signs the same Google account in again', async () => {
    expect((await http().get('/v1/auth/providers').expect(200)).body).toEqual({ google: true });

    const first = await signInWithGoogle();
    expect(first.headers['location']).toBe('http://dashboard.test/');
    const refresh = (first.headers['set-cookie'] as unknown as string[]).find((entry) => entry.startsWith('bh_refresh='))!;
    expect(refresh).toContain('HttpOnly');
    // The code was exchanged with the PKCE verifier that matches the challenge sent to Google.
    const verifier = tokenRequests[0]!.get('code_verifier')!;
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(tokenRequests[0]!.get('client_secret')).toBe('test-client-secret');

    // The dashboard restores the session from the refresh cookie.
    const session = await http().post('/v1/auth/refresh').set('Origin', DASHBOARD_ORIGIN).set('Cookie', refresh.split(';')[0]!).expect(200);
    expect(session.body.user).toMatchObject({ email: 'mona@gmail.com', fullName: 'منى أحمد', role: 'OWNER' });
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: 'mona@gmail.com' }, include: { identities: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toBeNull();
    expect(user.identities).toMatchObject([{ provider: 'GOOGLE', subject: '1234567890' }]);

    // Signing in again finds the account by Google's id, even if the Google email changed.
    expect((await signInWithGoogle({ claims: googleUser({ email: 'mona.new@gmail.com' }) })).headers['location']).toBe('http://dashboard.test/');
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('links an existing account by its verified email, and drops a password nobody confirmed', async () => {
    const owner = await signUpOwner(t, 'mona@gmail.com');
    expect(owner).toBeTruthy();
    await signInWithGoogle();
    expect(await t.prisma.userIdentity.count({ where: { user: { email: 'mona@gmail.com' } } })).toBe(1);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email: 'mona@gmail.com' } })).passwordHash).not.toBeNull();

    // Someone registered this email with a password but never confirmed it: Google proves the inbox,
    // so that password is dropped.
    await t.reset();
    await http().post('/v1/auth/register').send({ email: 'mona@gmail.com', password: 'someone-elses-password', fullName: 'Someone Else' }).expect(202);
    await signInWithGoogle();
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: 'mona@gmail.com' } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toBeNull();
    await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email: 'mona@gmail.com', password: 'someone-elses-password' }).expect(401);
  });

  it('refuses a forged or replayed answer, an unverified Google email, a wrong audience or nonce, and administrators', async () => {
    expect((await signInWithGoogle({ tamperState: true })).headers['location']).toBe('http://dashboard.test/login?oauth_error=expired');
    expect((await signInWithGoogle({ withoutCookie: true })).headers['location']).toBe('http://dashboard.test/login?oauth_error=expired');
    expect((await signInWithGoogle({ claims: googleUser({ email_verified: false }) })).headers['location']).toBe('http://dashboard.test/login?oauth_error=email_unverified');
    expect((await signInWithGoogle({ claims: googleUser({ aud: 'someone-else' }) })).headers['location']).toBe('http://dashboard.test/login?oauth_error=failed');
    expect((await signInWithGoogle({ claims: googleUser({ nonce: 'old' }) })).headers['location']).toBe('http://dashboard.test/login?oauth_error=failed');
    expect(await t.prisma.user.count()).toBe(0);

    await t.prisma.user.create({ data: { email: 'mona@gmail.com', fullName: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() } });
    expect((await signInWithGoogle()).headers['location']).toBe('http://dashboard.test/login?oauth_error=not_allowed');
    expect(await t.prisma.userIdentity.count()).toBe(0);

    // Declining at Google comes back as cancelled.
    const declined = await http().get('/v1/auth/google/callback?error=access_denied&state=x').expect(302);
    expect(declined.headers['location']).toBe('http://dashboard.test/login?oauth_error=cancelled');
  });

  it('refuses suspended accounts', async () => {
    await signInWithGoogle();
    await t.prisma.user.update({ where: { email: 'mona@gmail.com' }, data: { status: 'SUSPENDED' } });
    expect((await signInWithGoogle()).headers['location']).toBe('http://dashboard.test/login?oauth_error=suspended');
  });
});
