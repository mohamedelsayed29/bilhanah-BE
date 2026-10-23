import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeSubdomain, RESTAURANT_ERROR_CODES, type VisitSource } from '@bilhanah/contracts';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { businessDay } from '../orders/business-day.js';

const DAY_SECONDS = 24 * 60 * 60;
/** Counters stay in Redis this long; the worker copies them to Postgres every hour. */
const COUNTER_TTL_SECONDS = 8 * DAY_SECONDS;
const DIRTY_SET = 'stats:dirty';

const countersKey = (restaurantId: string, day: string) => `stats:${restaurantId}:${day}`;
export const dayKey = (date: Date) => date.toISOString().slice(0, 10);

type Counters = { visits: number; qrVisits: number; tableVisits: number; linkVisits: number };

/**
 * Menu visits per restaurant and local day. A visitor counts once per day:
 * they are recognised by a hash of their IP address and browser, salted with
 * a secret that changes daily, so no address is stored and visitors cannot be
 * followed from one day to the next.
 */
@Injectable()
export class VisitsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  async record(rawSubdomain: string, source: VisitSource, ip: string, userAgent: string, now = new Date()): Promise<void> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { subdomain: normalizeSubdomain(rawSubdomain) },
      select: { id: true, timezone: true },
    });
    if (!restaurant) throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

    const day = dayKey(businessDay(now, restaurant.timezone));
    const salt = createHmac('sha256', this.secret).update(`visits:${day}`).digest();
    const visitor = createHash('sha256').update(salt).update(`${ip}\n${userAgent}`).digest('base64url').slice(0, 22);
    const first = await this.redis.set(`visit:${restaurant.id}:${day}:${visitor}`, '1', 'EX', 2 * DAY_SECONDS, 'NX');
    if (first !== 'OK') return;

    const key = countersKey(restaurant.id, day);
    await this.redis
      .multi()
      .hincrby(key, 'visits', 1)
      .hincrby(key, source, 1)
      .expire(key, COUNTER_TTL_SECONDS)
      .sadd(DIRTY_SET, `${restaurant.id}|${day}`)
      .exec();
  }

  /**
   * Copies Redis counters to restaurant_daily_stats. The counters hold the
   * day's totals, so copying is idempotent; days older than two are then
   * forgotten from the dirty set. `restaurantId` limits it to one restaurant.
   */
  async flush(now = new Date(), restaurantId?: string): Promise<number> {
    const members = await this.redis.smembers(DIRTY_SET);
    const settled = dayKey(new Date(now.getTime() - 2 * DAY_SECONDS * 1000));
    let copied = 0;
    for (const member of members) {
      const [id, day] = member.split('|') as [string, string];
      if (restaurantId && id !== restaurantId) continue;
      const counters = toCounters(await this.redis.hgetall(countersKey(id, day)));
      if (counters) {
        const date = new Date(`${day}T00:00:00.000Z`);
        await this.prisma.restaurantDailyStat
          .upsert({
            where: { restaurantId_day: { restaurantId: id, day: date } },
            create: { restaurantId: id, day: date, ...counters },
            update: counters,
          })
          // The restaurant may have been deleted since.
          .catch(() => undefined);
        copied += 1;
      }
      if (day < settled || !counters) await this.redis.srem(DIRTY_SET, member);
    }
    return copied;
  }
}

function toCounters(hash: Record<string, string>): Counters | null {
  if (!hash['visits']) return null;
  const read = (field: string) => Number(hash[field] ?? 0);
  return { visits: read('visits'), qrVisits: read('qr'), tableVisits: read('table'), linkVisits: read('link') };
}
