import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_ERROR_CODES } from '@bilhanah/contracts';
import type { Request } from 'express';
import type { Env } from '../../config/env.schema.js';

/**
 * CSRF protection for endpoints that read or set the session cookie:
 * the browser-supplied Origin must be an allowed dashboard origin.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor(config: ConfigService<Env, true>) {
    this.allowed = new Set(config.get('CORS_ORIGINS', { infer: true }).map((url) => new URL(url).origin));
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().headers.origin;
    if (origin && this.allowed.has(origin)) return true;
    throw new ForbiddenException({
      code: AUTH_ERROR_CODES.ORIGIN_NOT_ALLOWED,
      message: 'This request must come from the Bilhanah dashboard.',
    });
  }
}
