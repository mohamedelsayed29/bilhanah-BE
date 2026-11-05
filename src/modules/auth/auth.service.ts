import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AUTH_ERROR_CODES,
  type AuthSession,
  type AuthUser,
  ADMIN_ERROR_CODES,
  type adminLoginSchema,
  type changePasswordSchema,
  type updateProfileSchema,
  COMMON_ERROR_CODES,
  type loginSchema,
  type registerOwnerSchema,
  type SessionResponse,
  type VerifyEmailResponse,
  effectivePermissions,
} from '@bilhanah/contracts';
import type { User, UserRole } from '@bilhanah/database';
import { SecretBox } from '../../common/crypto/secret-box.js';
import { verifyTotp } from '../../common/crypto/totp.js';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { AccessTokenService } from './access-token.service.js';
import { existingAccountEmail, passwordResetEmail, verificationEmail } from './auth-emails.js';
import { PasswordService } from './password.service.js';
import { formatRefreshToken, generateToken, hashesEqual, hashToken, parseRefreshToken } from './tokens.js';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ClientMeta = { ipAddress?: string; userAgent?: string };

export type IssuedSession = {
  response: SessionResponse;
  refreshToken: string;
  /** Undefined: a browser-session cookie (the user did not ask to stay signed in). */
  refreshTokenMaxAgeMs: number | undefined;
};

const invalidCredentials = () =>
  new UnauthorizedException({
    code: AUTH_ERROR_CODES.INVALID_CREDENTIALS,
    message: 'The email or password is incorrect.',
  });

const sessionInvalid = () =>
  new UnauthorizedException({
    code: AUTH_ERROR_CODES.SESSION_INVALID,
    message: 'Your session has ended. Please sign in again.',
  });

const invalidToken = () =>
  new BadRequestException({
    code: AUTH_ERROR_CODES.INVALID_TOKEN,
    message: 'This link is invalid or has expired.',
  });

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    preferredLanguage: user.preferredLanguage,
    role: user.role,
    permissions: effectivePermissions(user.role, user.permissionGrants),
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/**
 * Restaurant-owner authentication. Responses for registration, resend and
 * password recovery are identical whether or not the email is registered.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly dashboardUrl: string;
  private readonly refreshTtlMs: number;
  private readonly sessionMaxMs: number;
  private readonly adminSessionMaxMs: number;
  private readonly rememberMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly mailer: MailerService,
    private readonly secrets: SecretBox,
    config: ConfigService<Env, true>,
  ) {
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '');
    this.refreshTtlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * DAY_MS;
    this.sessionMaxMs = config.get('SESSION_MAX_DAYS', { infer: true }) * DAY_MS;
    this.adminSessionMaxMs = config.get('ADMIN_SESSION_HOURS', { infer: true }) * 60 * 60 * 1000;
    this.rememberMs = config.get('REMEMBER_ME_DAYS', { infer: true }) * DAY_MS;
  }

  async register(input: z.output<typeof registerOwnerSchema>): Promise<void> {
    // Hash before the lookup so new and existing emails take similar time.
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // Never change an existing account's password from the registration form.
      if (existing.emailVerifiedAt) {
        this.mailer.sendInBackground(
          existingAccountEmail(existing.email, existing.fullName, existing.preferredLanguage, this.dashboardUrl),
          'existing-account',
        );
        return;
      }
      // Either registration may have come from someone other than the inbox
      // owner, so keeping either password would let them sign in once the
      // owner confirms. Keep neither; verifyEmail then sends a link to set one.
      if (existing.passwordHash && !(await this.passwords.verify(existing.passwordHash, input.password))) {
        await this.prisma.user.updateMany({
          where: { id: existing.id, emailVerifiedAt: null },
          data: { passwordHash: null },
        });
      }
      await this.sendVerification(existing);
      return;
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          preferredLanguage: input.preferredLanguage,
          role: 'OWNER',
        },
      });
      await this.sendVerification(user);
    } catch (error) {
      // A concurrent registration claimed the email first.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.status === 'ACTIVE' && user.role === 'OWNER') {
      await this.sendVerification(user);
    }
  }

  async verifyEmail(token: string): Promise<VerifyEmailResponse> {
    const now = new Date();
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.usedAt || record.expiresAt <= now) throw invalidToken();

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalidToken();
      await tx.user.updateMany({
        where: { id: record.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return tx.user.findUniqueOrThrow({ where: { id: record.userId } });
    });

    const passwordSetupRequired = user.passwordHash === null;
    if (passwordSetupRequired) await this.sendPasswordReset(user);
    return { passwordSetupRequired };
  }

  async login(input: z.output<typeof loginSchema>, meta: ClientMeta): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const passwordValid = await this.passwords.verify(user?.passwordHash ?? undefined, input.password);
    // Platform administrators sign in through a separate MFA flow.
    if (!user || !passwordValid || user.role === 'ADMIN') throw invalidCredentials();
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        message: 'This account is suspended. Please contact Bilhanah support.',
      });
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
        message: 'Confirm your email address before signing in.',
      });
    }

    return this.startSession(user, meta, input.remember ?? null);
  }

  /**
   * Administrator sign-in: password plus a code from their authenticator app.
   * Wrong password and wrong code give the same answer.
   */
  async adminLogin(input: z.output<typeof adminLoginSchema>, meta: ClientMeta): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const passwordValid = await this.passwords.verify(user?.passwordHash ?? undefined, input.password);
    if (!user || !passwordValid || user.role !== 'ADMIN') throw invalidCredentials();
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, message: 'This account is suspended.' });
    }
    if (!user.totpSecret) {
      throw new ForbiddenException({
        code: ADMIN_ERROR_CODES.MFA_NOT_SET_UP,
        message: 'Two-factor sign-in is not set up for this account. Ask an operator to run admin:reset-mfa.',
      });
    }

    const step = verifyTotp(this.secrets.open(user.totpSecret), input.code, new Date(), user.totpLastStep);
    if (step === null) throw invalidCredentials();
    // Claim the step atomically, so two concurrent requests cannot both use one code.
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    if (claimed.count !== 1) throw invalidCredentials();
    return this.startSession(user, meta);
  }

  private async startSession(user: User, meta: ClientMeta, remember: boolean | null = null): Promise<IssuedSession> {
    const secret = generateToken();
    const now = new Date();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(secret),
        createdAt: now,
        remember,
        expiresAt: this.nextExpiry(now, now, user.role, remember),
        userAgent: meta.userAgent?.slice(0, 512),
        ipAddress: meta.ipAddress?.slice(0, 64),
      },
    });
    return this.issue(user, session.id, secret, session.expiresAt, remember);
  }

  /**
   * Rotates the refresh token. Presenting a token that was already rotated
   * out revokes the session, since the token may have been stolen. Clients
   * must therefore never refresh concurrently with the same token.
   */
  /** `app`: which app is refreshing; an administrator session only renews in the admin console, and only there. */
  async refresh(cookie: unknown, app: 'restaurant' | 'admin' = 'restaurant'): Promise<IssuedSession> {
    const parsed = parseRefreshToken(cookie);
    if (!parsed) throw sessionInvalid();

    const now = new Date();
    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      this.nextExpiry(session.createdAt, now, session.user.role, session.remember) <= now ||
      session.user.status !== 'ACTIVE' ||
      (session.user.role === 'ADMIN') !== (app === 'admin')
    ) {
      throw sessionInvalid();
    }

    if (!hashesEqual(hashToken(parsed.secret), session.tokenHash)) {
      await this.prisma.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'REFRESH_TOKEN_REUSE' },
      });
      this.logger.warn({ sessionId: session.id, userId: session.userId }, 'Refresh token reuse; session revoked');
      throw sessionInvalid();
    }

    const nextSecret = generateToken();
    const nextExpiresAt = this.nextExpiry(session.createdAt, now, session.user.role, session.remember);
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, tokenHash: session.tokenHash, revokedAt: null },
      data: {
        tokenHash: hashToken(nextSecret),
        lastUsedAt: now,
        expiresAt: nextExpiresAt,
      },
    });
    // Another request rotated this token between our read and write.
    if (rotated.count !== 1) throw sessionInvalid();

    return this.issue(session.user, session.id, nextSecret, nextExpiresAt, session.remember);
  }

  /** Ends the session identified by the cookie. Silently ignores unknown or stale tokens. */
  async logout(cookie: unknown): Promise<void> {
    const parsed = parseRefreshToken(cookie);
    if (!parsed) return;
    const session = await this.prisma.session.findUnique({ where: { id: parsed.sessionId } });
    if (!session || !hashesEqual(hashToken(parsed.secret), session.tokenHash)) return;
    await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || user.role !== 'OWNER') return;
    await this.sendPasswordReset(user);
  }

  /** Sets a new password and signs the account out everywhere. */
  async resetPassword(token: string, password: string): Promise<void> {
    const now = new Date();
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.usedAt || record.expiresAt <= now) throw invalidToken();

    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalidToken();

      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: now } });
      // The reset link proves control of the inbox.
      await tx.user.updateMany({
        where: { id: record.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await tx.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'PASSWORD_RESET' },
      });
    });
  }

  /** Active sessions, most recently used first. */
  async listSessions(userId: string, currentSessionId: string): Promise<AuthSession[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return sessions.map((session) => ({
      id: session.id,
      current: session.id === currentSessionId,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
      expiresAt: session.expiresAt.toISOString(),
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
    }));
  }

  /** Signs out one of the caller's own sessions; other users' IDs look unknown. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const revoked = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
    });
    if (revoked.count === 0) {
      throw new NotFoundException({ code: COMMON_ERROR_CODES.NOT_FOUND, message: 'Session not found.' });
    }
  }

  /** Requires the current password and signs out every other session. */
  async changePassword(
    auth: { userId: string; sessionId: string },
    input: z.output<typeof changePasswordSchema>,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.passwords.verify(user.passwordHash ?? undefined, input.currentPassword))) {
      // 400 rather than 401, so clients do not treat it as an expired session.
      throw new BadRequestException({
        code: AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        message: 'The current password is incorrect.',
      });
    }

    const now = new Date();
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now } }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: auth.sessionId } },
        data: { revokedAt: now, revokedReason: 'PASSWORD_CHANGE' },
      }),
      // Outstanding reset links would otherwise still set a password.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
    ]);
  }

  async updateProfile(userId: string, input: z.output<typeof updateProfileSchema>): Promise<AuthUser> {
    return toAuthUser(await this.prisma.user.update({ where: { id: userId }, data: input }));
  }

  async me(userId: string): Promise<AuthUser> {
    return toAuthUser(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  /** Each use extends a session, but never past SESSION_MAX_DAYS (ADMIN_SESSION_HOURS for administrators) from sign-in. */
  /**
   * `remember`: true lasts REMEMBER_ME_DAYS from sign-in; false at most a day (its cookie also ends with the browser);
   * null is the standard session, sliding by REFRESH_TOKEN_TTL_DAYS up to SESSION_MAX_DAYS.
   */
  private nextExpiry(createdAt: Date, now: Date, role: UserRole, remember: boolean | null = null): Date {
    const maxMs = role === 'ADMIN' ? this.adminSessionMaxMs
      : remember === true ? Math.min(this.rememberMs, this.sessionMaxMs)
      : remember === false ? Math.min(DAY_MS, this.sessionMaxMs)
      : this.sessionMaxMs;
    return new Date(Math.min(now.getTime() + this.refreshTtlMs, createdAt.getTime() + maxMs));
  }

  private async issue(user: User, sessionId: string, secret: string, expiresAt: Date, remember: boolean | null = null): Promise<IssuedSession> {
    return {
      response: {
        accessToken: await this.accessTokens.sign(user.id, sessionId, user.role),
        accessTokenExpiresIn: this.accessTokens.ttlSeconds,
        user: toAuthUser(user),
      },
      refreshToken: formatRefreshToken(sessionId, secret),
      refreshTokenMaxAgeMs: remember === false ? undefined : Math.max(0, expiresAt.getTime() - Date.now()),
    };
  }

  /** Only the newest reset link works. */
  private async sendPasswordReset(user: User): Promise<void> {
    const token = generateToken();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) },
      }),
    ]);
    this.mailer.sendInBackground(
      passwordResetEmail(user.email, user.fullName, user.preferredLanguage, this.dashboardUrl, token),
      'password-reset',
    );
  }

  private async sendVerification(user: User): Promise<void> {
    const token = generateToken();
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.emailVerificationToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) },
      }),
    ]);
    this.mailer.sendInBackground(
      verificationEmail(user.email, user.fullName, user.preferredLanguage, this.dashboardUrl, token),
      'email-verification',
    );
  }
}
