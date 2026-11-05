import { TABLE_SESSION_LIMITS } from '@bilhanah/contracts';
import type { Prisma, TableSession } from '@bilhanah/database';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import type { PrismaService } from '../../infrastructure/database/prisma.service.js';

type Db = Prisma.TransactionClient;

export const SESSION_IDLE_MS = TABLE_SESSION_LIMITS.idleHours * 60 * 60 * 1000;

/** Sessions that are not closed, and were used recently enough to count. */
export const liveSessionWhere = (now: Date): Prisma.TableSessionWhereInput => ({
  status: { not: 'CLOSED' },
  lastActivityAt: { gt: new Date(now.getTime() - SESSION_IDLE_MS) },
});

/**
 * The table's one open session, else a new one. Idle sessions are closed first (EXPIRED), and a
 * per-table advisory lock plus the partial unique index (one open session per table) mean two phones
 * scanning at the same moment get the same session, never two.
 */
export async function openSessionFor(
  prisma: PrismaService,
  table: { id: string; restaurantId: string; branchId: string },
  now = new Date(),
): Promise<TableSession> {
  const attempt = () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`table-session:${table.id}`}))`;
    await expireIdle(tx, { tableId: table.id }, now);
    const open = await tx.tableSession.findFirst({ where: { tableId: table.id, status: { not: 'CLOSED' } } });
    if (open) return open;
    return tx.tableSession.create({ data: { restaurantId: table.restaurantId, branchId: table.branchId, tableId: table.id, startedAt: now, lastActivityAt: now } });
  });
  try {
    return await attempt();
  } catch (error) {
    // Another process won the race (outside the lock's reach, e.g. older code): use its session.
    if (!isUniqueViolation(error)) throw error;
    return attempt();
  }
}

/** Closes open sessions nobody used for SESSION_IDLE_MS. */
export async function expireIdle(tx: Db, where: Prisma.TableSessionWhereInput, now = new Date()): Promise<number> {
  const { count } = await tx.tableSession.updateMany({
    where: { ...where, status: { not: 'CLOSED' }, lastActivityAt: { lte: new Date(now.getTime() - SESSION_IDLE_MS) } },
    data: { status: 'CLOSED', closedReason: 'EXPIRED', endedAt: now, version: { increment: 1 } },
  });
  return count;
}
