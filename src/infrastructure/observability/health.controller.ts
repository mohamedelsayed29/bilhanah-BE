import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL } from '../database/pg-pool.js';
import { REDIS } from '../redis/redis.module.js';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is running and serving HTTP. */
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: required dependencies are reachable. */
  @Get('ready')
  async ready() {
    const [database, redis] = await Promise.all([
      check(() => this.pool.query('SELECT 1')),
      check(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    if (database === 'down' || redis === 'down') {
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'One or more dependencies are unavailable.',
        details: checks,
      });
    }
    return { status: 'ok', checks };
  }
}
