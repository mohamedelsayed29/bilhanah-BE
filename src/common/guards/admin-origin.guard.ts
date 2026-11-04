import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_ERROR_CODES } from '@bilhanah/contracts';
import type { Request } from 'express';
import type { Env } from '../../config/env.schema.js';

/**
 * CSRF protection for the administrators' session endpoints: the Origin must be the admin console
 * (ADMIN_ORIGINS), not a restaurant dashboard. Without ADMIN_ORIGINS, the dashboard origins are used.
 */
@Injectable()
export class AdminOriginGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor(config: ConfigService<Env, true>) {
    const admin = config.get('ADMIN_ORIGINS', { infer: true });
    this.allowed = new Set((admin.length ? admin : config.get('CORS_ORIGINS', { infer: true })).map((url) => new URL(url).origin));
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().headers.origin;
    if (origin && this.allowed.has(origin)) return true;
    throw new ForbiddenException({
      code: AUTH_ERROR_CODES.ORIGIN_NOT_ALLOWED,
      message: 'Administrators sign in from the Bilhanah admin console.',
    });
  }
}
