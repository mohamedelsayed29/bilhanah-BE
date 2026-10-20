import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COMMON_ERROR_CODES } from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infrastructure/redis/redis.module.js';

export type RateLimitRule = {
  /** Stable name; part of the Redis key. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What one counter is keyed by. `email` reads the raw request body. */
  by: 'ip' | 'email' | 'ip+email';
};

const RATE_LIMIT_RULES = 'rateLimitRules';

/** Fixed-window limits enforced by RateLimitGuard. All rules must pass. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT_RULES, rules);

function identity(request: Request, by: RateLimitRule['by']): string | null {
  const rawEmail: unknown = request.body?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : null;
  const ip = request.ip ?? 'unknown';
  if (by === 'ip') return ip;
  if (!email) return null;
  return by === 'email' ? email : `${ip}|${email}`;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT_RULES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rules?.length) return true;

    const request = context.switchToHttp().getRequest<Request>();
    for (const rule of rules) {
      const id = identity(request, rule.by);
      if (id === null) continue;
      // Hash identities so emails and IPs are not stored in Redis keys.
      const key = `rl:${rule.name}:${createHash('sha256').update(id).digest('hex')}`;

      let count: number;
      let ttl: number;
      try {
        const results = await this.redis
          .multi()
          .incr(key)
          .expire(key, rule.windowSeconds, 'NX')
          .ttl(key)
          .exec();
        count = Number(results?.[0]?.[1]);
        ttl = Number(results?.[2]?.[1]);
      } catch (error) {
        // Fail open: a Redis outage must not lock owners out of their accounts.
        this.logger.warn({ err: error, rule: rule.name }, 'Rate limit check skipped');
        continue;
      }

      if (count > rule.limit) {
        const retryAfter = Math.max(ttl, 1);
        context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfter));
        throw new HttpException(
          {
            code: COMMON_ERROR_CODES.RATE_LIMITED,
            message: 'Too many requests. Please try again later.',
            details: { retryAfterSeconds: retryAfter },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
