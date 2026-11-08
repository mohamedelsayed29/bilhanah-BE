import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type PosDeviceInfo, type PosPinStaff, posPinLoginSchema, type SessionResponse } from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { TrustedOriginGuard } from '../../common/guards/trusted-origin.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { Env } from '../../config/env.schema.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../auth/auth-cookies.js';
import { PosAuthService } from './pos-auth.service.js';

/**
 * The POS device itself, before anyone signs in: which device this is, who may sign in on it, and PIN
 * sign-in. Authorised by the device key (X-Pos-Device), not by a user's token.
 */
@Controller('pos/device')
@UseGuards(RateLimitGuard)
export class PosDeviceController {
  private readonly secureCookies: boolean;

  constructor(private readonly posAuth: PosAuthService, config: ConfigService<Env, true>) {
    this.secureCookies = ['production', 'staging'].includes(config.get('NODE_ENV', { infer: true }));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'pos-device:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  info(@Headers('x-pos-device') device: string | undefined): Promise<{ device: PosDeviceInfo; staff: PosPinStaff[] }> {
    return this.posAuth.info(device);
  }

  /** PIN sign-in: a session like a password sign-in, not remembered (POS_PIN_POLICY). */
  @Post('pin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(TrustedOriginGuard)
  @RateLimit({ name: 'pos-pin:ip', limit: 20, windowSeconds: 15 * 60, by: 'ip' })
  async pin(
    @Headers('x-pos-device') device: string | undefined,
    @Body(new ZodValidationPipe(posPinLoginSchema)) body: z.output<typeof posPinLoginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const issued = await this.posAuth.pinLogin(device, body.userId, body.pin, { ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    response.cookie(REFRESH_COOKIE, issued.refreshToken, refreshCookieOptions(this.secureCookies, issued.refreshTokenMaxAgeMs));
    return issued.response;
  }
}
