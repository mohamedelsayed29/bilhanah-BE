import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AuthSession,
  type AuthUser,
  changePasswordSchema,
  emailOnlySchema,
  loginSchema,
  registerOwnerSchema,
  resetPasswordSchema,
  sessionIdParamSchema,
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
import { REFRESH_COOKIE, refreshCookieOptions } from './auth-cookies.js';
import { AuthService, type IssuedSession } from './auth.service.js';

const HOUR = 60 * 60;

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookies = ['production', 'staging'].includes(config.get('NODE_ENV', { infer: true }));
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

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(TrustedOriginGuard)
  @RateLimit({ name: 'refresh:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<SessionResponse> {
    const issued = await this.auth.refresh(request.cookies?.[REFRESH_COOKIE]);
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

  private withRefreshCookie(response: Response, issued: IssuedSession): SessionResponse {
    response.cookie(
      REFRESH_COOKIE,
      issued.refreshToken,
      refreshCookieOptions(this.secureCookies, issued.refreshTokenMaxAgeMs),
    );
    return issued.response;
  }
}
