import { PrismaPg } from '@prisma/adapter-pg';
import type pg from 'pg';

export * from './generated/prisma/client.js';

/**
 * Prisma driver adapter over an existing pg pool. The caller owns the pool
 * and is responsible for ending it.
 */
export function createPgAdapter(pool: pg.Pool): PrismaPg {
  return new PrismaPg(pool);
}
