import { Inject, Injectable } from '@nestjs/common';
import { createPgAdapter, PrismaClient } from '@bilhanah/database';
import type pg from 'pg';
import { PG_POOL } from './pg-pool.js';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor(@Inject(PG_POOL) pool: pg.Pool) {
    // The adapter borrows the shared pool and does not close it;
    // DatabaseModule ends the pool on shutdown.
    super({ adapter: createPgAdapter(pool) });
  }
}
