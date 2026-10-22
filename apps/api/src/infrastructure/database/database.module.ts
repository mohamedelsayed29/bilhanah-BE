import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../../config/env.schema.js';
import { PG_POOL } from './pg-pool.js';
import { PrismaService } from './prisma.service.js';

export { PG_POOL };

// One connection pool per process, shared by Prisma and health checks.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new pg.Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: 10,
          connectionTimeoutMillis: 5_000,
        }),
    },
    PrismaService,
  ],
  exports: [PG_POOL, PrismaService],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    await this.pool.end();
  }
}
