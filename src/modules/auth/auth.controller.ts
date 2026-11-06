import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  adminLoginSchema,
  type AuthProviders,
  type AuthSession,
  type AuthUser,
  changePasswordSchema,
  emailOnlySchema,
  loginSchema,
  registerOwnerSchema,
  resetPasswordSchema,
  sessionIdParamSchema,
  updateProfileSchema,
  type SessionResponse,
  verifyEmailSchema,
  type VerifyEmailResponse,
} from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { TrustedOriginGuard } from '../../common/guards/trusted-origin.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { Env } from '../../config/env.schema.js';
import { ADMIN_REFRESH_COOKIE, REFRESH_COOKIE, refreshCookieOptions } from './auth-cookies.js';
import { AdminOriginGuard } from '../../common/guards/admin-origin.guard.js';

/** The admin cookie only travels to the admin session routes. */
const ADMIN_COOKIE_PATH = '/v1/auth/admin';
import { AuthService, type IssuedSession } from './auth.service.js';
import { GoogleAuthService, GoogleSignInError } from './google-auth.service.js';

/** Ties Google's answer to the browser that started the sign-in (path-limited to the callback). */
const OAUTH_COOKIE = 'bh_oauth';
const OAUTH_COOKIE_PATH = '/v1/auth/google';

const HOUR = 60 * 60;

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  private readonly secureCookies: boolean;

  private readonly dashboardUrl: string;
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleAuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookies = ['production', 'staging'].includes(config.get('NODE_ENV', { infer: true }));
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '');
  }

  /** Which sign-in providers this server offers (Google only when configured). */
  @Get('providers')
  @Header('Cache-Control', 'no-store')
  providers(): AuthProviders {
    return { google: this.google.enabled };
  }

  /**
   * "Continue with Google": sends the browser to Google, with a cookie tying Google's answer to this
   * browser. Signing up and signing in are the same trip.
   */
  @Get('google/start')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'google-start:ip', limit: 30, windowSeconds: 15 * 60, by: 'ip' })
  async googleStart(@Query('remember') remember: unknown, @Query('lang') lang: unknown, @Res() response: Response): Promise<void> {
    try {
      const { url, browserSecret } = await this.google.start({ remember: remember !== '0', language: lang === 'en' ? 'en' : 'ar' });
      // Lax: the cookie must come back on Google's top-level redirect to the callback.
      response.cookie(OAUTH_COOKIE, browserSecret, { httpOnly: true, secure: this.secureCookies, sameSite: 'lax', path: OAUTH_COOKIE_PATH, maxAge: 10 * 60 * 1000 });
      response.redirect(302, url);
    } catch (error) {
      response.redirect(302, this.loginWithError(error));
    }
  }

  /** Google's redirect back: opens a session (the dashboard restores it from the refresh cookie) or explains why not. */
  @Get('google/callback')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'google-callback:ip', limit: 30, windowSeconds: 15 * 60, by: 'ip' })
  async googleCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.clearCookie(OAUTH_COOKIE, { httpOnly: true, secure: this.secureCookies, sameSite: 'lax', path: OAUTH_COOKIE_PATH });
    try {
      const issued = await this.google.finish({
        code: typeof code === 'string' ? code : undefined,
        state: typeof state === 'string' ? state : undefined,
        error: typeof error === 'string' ? error : undefined,
        browserSecret: request.cookies?.[OAUTH_COOKIE],
      }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] });
      this.withRefreshCookie(response, issued);
      response.redirect(302, `${this.dashboardUrl}/`);
    } catch (caught) {
      response.redirect(302, this.loginWithError(caught));
    }
  }

  private loginWithError(error: unknown): string {
    if (!(error instanceof GoogleSignInError)) this.logger.error(error);
    const reason = error instanceof GoogleSignInError ? error.reason : 'failed';
    return `${this.dashboardUrl}/login?oauth_error=${reason}`;
  }

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(
    { name: 'register:ip', limit: 10, windowSeconds: HOUR, by: 'ip' },
    { name: 'register:email', limit: 3, windowSeconds: HOUR, by: 'email' },
  )
  async register(@Body(new ZodValidationPipe(registerOwnerSchema)) body: z.output<typeof registerOwnerSchema>) {
    await this.auth.register(body);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(
    { name: 'resend:ip', limit: 10, windowSeconds: HOUR, by: 'ip' },
    { name: 'resend:email', limit: 3, windowSeconds: HOUR, by: 'email' },
  )
  async resendVerification(@Body(new ZodValidationPipe(emailOnlySchema)) body: z.output<typeof emailOnlySchema>) {
    await this.auth.resendVerification(body.email);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'verify:ip', limit: 20, windowSeconds: 15 * 60, by: 'ip' })
  verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.output<typeof verifyEmailSchema>,
  ): Promise<VerifyEmailResponse> {
    return this.auth.verifyEmail(body.token);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(TrustedOriginGuard)
  @RateLimit(
    { name: 'login:ip', limit: 30, windowSeconds: 15 * 60, by: 'ip' },
    { name: 'login:ip-email', limit: 5, windowSeconds: 15 * 60, by: 'ip+email' },
    { name: 'login:email', limit: 20, windowSeconds: HOUR, by: 'email' },
  )
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.output<typeof loginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const issued = await this.auth.login(body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return this.withRefreshCookie(response, issued);
  }

  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminOriginGuard)
  @RateLimit(
    { name: 'admin-login:ip', limit: 20, windowSeconds: HOUR, by: 'ip' },
    { name: 'admin-login:email', limit: 5, windowSeconds: 15 * 60, by: 'email' },
  )
  async adminLogin(
    @Body(new ZodValidationPipe(adminLoginSchema)) body: z.output<typeof adminLoginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const issued = await this.auth.adminLogin(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return this.withAdminCookie(response, issued);
  }

  /** The admin console's own refresh: only administrator sessions, from its own cookie. */
  @Post('admin/refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminOriginGuard)
  @RateLimit({ name: 'refresh:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  async adminRefresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<SessionResponse> {
    const issued = await this.auth.refresh(request.cookies?.[ADMIN_REFRESH_COOKIE], 'admin');
    return this.withAdminCookie(response, issued);
  }

  @Post('admin/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminOriginGuard)
  async adminLogout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(request.cookies?.[ADMIN_REFRESH_COOKIE]);
    response.clearCookie(ADMIN_REFRESH_COOKIE, refreshCookieOptions(this.secureCookies, undefined, ADMIN_COOKIE_PATH));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(TrustedOriginGuard)
  @RateLimit({ name: 'refresh:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<SessionResponse> {
    // Restaurant dashboards never carry an administrator session.
    const issued = await this.auth.refresh(request.cookies?.[REFRESH_COOKIE], 'restaurant');
    return this.withRefreshCookie(response, issued);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TrustedOriginGuard)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(request.cookies?.[REFRESH_COOKIE]);
    response.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.secureCookies));
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(
    { name: 'forgot:ip', limit: 10, windowSeconds: HOUR, by: 'ip' },
    { name: 'forgot:email', limit: 3, windowSeconds: HOUR, by: 'email' },
  )
  async forgotPassword(@Body(new ZodValidationPipe(emailOnlySchema)) body: z.output<typeof emailOnlySchema>) {
    await this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'reset:ip', limit: 10, windowSeconds: 15 * 60, by: 'ip' })
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: z.output<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessTokenGuard)
  me(@CurrentAuth() auth: AuthContext): Promise<AuthUser> {
    return this.auth.me(auth.userId);
  }

  @Patch('me')
  @UseGuards(AccessTokenGuard)
  updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: z.output<typeof updateProfileSchema>,
  ): Promise<AuthUser> {
    return this.auth.updateProfile(auth.userId, body);
  }

  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessTokenGuard)
  sessions(@CurrentAuth() auth: AuthContext): Promise<AuthSession[]> {
    return this.auth.listSessions(auth.userId, auth.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(sessionIdParamSchema)) id: string,
  ): Promise<void> {
    await this.auth.revokeSession(auth.userId, id);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @RateLimit({ name: 'change-password:ip', limit: 10, windowSeconds: 15 * 60, by: 'ip' })
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.output<typeof changePasswordSchema>,
  ): Promise<void> {
    await this.auth.changePassword(auth, body);
  }

  private withAdminCookie(response: Response, issued: IssuedSession): SessionResponse {
    response.cookie(ADMIN_REFRESH_COOKIE, issued.refreshToken, refreshCookieOptions(this.secureCookies, issued.refreshTokenMaxAgeMs, ADMIN_COOKIE_PATH));
    return issued.response;
  }

  private withRefreshCookie(response: Response, issued: IssuedSession): SessionResponse {
    response.cookie(
      REFRESH_COOKIE,
      issued.refreshToken,
      refreshCookieOptions(this.secureCookies, issued.refreshTokenMaxAgeMs),
    );
    return issued.response;
  }
}
