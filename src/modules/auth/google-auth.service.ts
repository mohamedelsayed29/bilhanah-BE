import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Language, OAuthError } from '@bilhanah/contracts';
import type { User } from '@bilhanah/database';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { AuthService, type ClientMeta, type IssuedSession } from './auth.service.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** How long the trip to Google may take. */
const FLOW_SECONDS = 10 * 60;

const base64url = (buffer: Buffer) => buffer.toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** What we keep while the browser is at Google: one use, bound to that browser by a cookie. */
type Flow = { verifier: string; nonce: string; browser: string; remember: boolean; language: Language };

/** The claims we use from Google's ID token. */
type GoogleClaims = { iss: string; aud: string; sub: string; email?: string; email_verified?: boolean; name?: string; nonce?: string; exp: number };

export class GoogleSignInError extends Error {
  constructor(readonly reason: OAuthError) {
    super(reason);
  }
}

/**
 * "Continue with Google" for restaurant accounts: OpenID Connect with the authorisation code flow,
 * PKCE, a one-time state bound to the browser, and a nonce. Off until GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set.
 *
 * Google's account id (`sub`) identifies the account. A first sign-in links to the account with
 * the same email (Google has verified it) or creates an owner account; administrators never sign
 * in with Google.
 */
@Injectable()
export class GoogleAuthService {
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    const apiUrl = config.get('API_PUBLIC_URL', { infer: true });
    this.redirectUri = config.get('GOOGLE_REDIRECT_URI', { infer: true }) ?? (apiUrl ? `${apiUrl.replace(/\/$/, '')}/v1/auth/google/callback` : undefined);
  }

  get enabled(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /** Starts a sign-in: where to send the browser, and the cookie that ties the answer to it. */
  async start(options: { remember: boolean; language: Language }): Promise<{ url: string; browserSecret: string }> {
    if (!this.enabled) throw new GoogleSignInError('disabled');
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const browserSecret = base64url(randomBytes(32));
    const flow: Flow = { verifier, nonce, browser: base64url(sha256(browserSecret)), ...options };
    await this.redis.set(this.key(state), JSON.stringify(flow), 'EX', FLOW_SECONDS);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri!,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: base64url(sha256(verifier)),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      hl: options.language,
    }).toString();
    return { url: url.toString(), browserSecret };
  }

  /** Google's answer: checks it, finds or creates the account, and opens a session. */
  async finish(input: { code?: string; state?: string; error?: string; browserSecret?: string }, meta: ClientMeta): Promise<IssuedSession> {
    if (!this.enabled) throw new GoogleSignInError('disabled');
    // The state is used once, whatever happens next.
    const raw = input.state && input.state.length <= 128 ? await this.redis.getdel(this.key(input.state)) : null;
    if (input.error) throw new GoogleSignInError(input.error === 'access_denied' ? 'cancelled' : 'failed');
    if (!raw || !input.code || !input.browserSecret) throw new GoogleSignInError('expired');
    const flow = JSON.parse(raw) as Flow;
    const presented = sha256(input.browserSecret);
    const expected = Buffer.from(flow.browser, 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw new GoogleSignInError('expired');

    const claims = await this.exchange(input.code, flow);
    if (!claims.email || claims.email_verified !== true) throw new GoogleSignInError('email_unverified');
    const user = await this.accountFor(claims, flow.language);
    if (user.role === 'ADMIN') throw new GoogleSignInError('not_allowed');
    if (user.status !== 'ACTIVE') throw new GoogleSignInError('suspended');
    return this.auth.startExternalSession(user, meta, flow.remember);
  }

  /**
   * The code for tokens at Google's token endpoint (with the PKCE verifier). The ID token comes
   * straight from Google over TLS, so its claims are checked rather than its signature
   * (OpenID Connect Core §3.1.3.7).
   */
  private async exchange(code: string, flow: Flow): Promise<GoogleClaims> {
    let body: { id_token?: string };
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: this.clientId!,
          client_secret: this.clientSecret!,
          redirect_uri: this.redirectUri!,
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      body = (await response.json()) as { id_token?: string };
      if (!response.ok || !body.id_token) {
        this.logger.warn(`Google token exchange failed with status ${response.status}`);
        throw new GoogleSignInError('failed');
      }
    } catch (error) {
      if (error instanceof GoogleSignInError) throw error;
      this.logger.warn(`Google token exchange failed: ${(error as Error).message}`);
      throw new GoogleSignInError('failed');
    }
    const claims = decodeClaims(body.id_token);
    const now = Math.floor(Date.now() / 1000);
    if (!claims || !ISSUERS.has(claims.iss) || claims.aud !== this.clientId || !claims.sub || claims.exp <= now - 60 || claims.nonce !== flow.nonce) {
      throw new GoogleSignInError('failed');
    }
    return claims;
  }

  private async accountFor(claims: GoogleClaims, language: Language): Promise<User> {
    const email = claims.email!.trim().toLowerCase();
    const linked = await this.prisma.userIdentity.findUnique({ where: { provider_subject: { provider: 'GOOGLE', subject: claims.sub } }, include: { user: true } });
    if (linked) {
      await this.prisma.userIdentity.update({ where: { id: linked.id }, data: { lastUsedAt: new Date(), email } });
      return linked.user;
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email } });
        if (existing?.role === 'ADMIN') return existing;
        const user = existing
          // Google has proved the inbox. A password set before the inbox was confirmed may be
          // someone else's (see AuthService.register), so it is dropped; a reset sets a new one.
          ? existing.emailVerifiedAt ? existing : await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date(), passwordHash: null } })
          : await tx.user.create({
            data: { email, fullName: (claims.name?.trim() || email.split('@')[0]!).slice(0, 100), preferredLanguage: language, role: 'OWNER', emailVerifiedAt: new Date(), passwordHash: null },
          });
        await tx.userIdentity.create({ data: { userId: user.id, provider: 'GOOGLE', subject: claims.sub, email } });
        return user;
      });
    } catch (error) {
      // The same Google account finished twice at once: the other request linked it.
      if (!isUniqueViolation(error)) throw error;
      const identity = await this.prisma.userIdentity.findUnique({ where: { provider_subject: { provider: 'GOOGLE', subject: claims.sub } }, include: { user: true } });
      if (!identity) throw new GoogleSignInError('failed');
      return identity.user;
    }
  }

  private key(state: string): string {
    return `oauth:google:${state}`;
  }
}

function decodeClaims(idToken: string): GoogleClaims | null {
  const [, payload] = idToken.split('.');
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleClaims;
  } catch {
    return null;
  }
}
