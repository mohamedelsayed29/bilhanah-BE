import type { LoyaltySettings } from '@bilhanah/contracts';
import type { LoyaltyMember, LoyaltyTransactionKind, Prisma, PrismaClient } from '@bilhanah/database';

type Tx = Prisma.TransactionClient;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PostEntry = {
  kind: LoyaltyTransactionKind;
  points: number;
  reason: string;
  orderId?: string | null;
  rewardId?: string | null;
  actor?: { id: string; name: string | null } | null;
  /** Counts towards lifetime points (earning and its reversal). */
  lifetime?: boolean;
  /** An earning or redemption: resets the expiry clock. */
  activity?: boolean;
  /** Refuses (returns null) instead of taking the balance below zero. */
  requireBalance?: boolean;
};

/**
 * The only way a balance changes: moves it and records the transaction, atomically. The UPDATE
 * locks the member's row, so concurrent changes queue; the member must belong to the restaurant.
 * Returns the new balance, or null when `requireBalance` refused (or the member is not the restaurant's).
 */
export async function postLoyalty(tx: Tx, memberId: string, restaurantId: string, entry: PostEntry, now = new Date()): Promise<number | null> {
  const lifetime = entry.lifetime ? entry.points : 0;
  const rows = await tx.$queryRaw<{ balance: number }[]>`
    UPDATE loyalty_members
    SET balance = balance + ${entry.points},
        lifetime_points = GREATEST(0, lifetime_points + ${lifetime}),
        last_activity_at = CASE WHEN ${entry.activity ?? false} THEN ${now} ELSE last_activity_at END,
        updated_at = ${now}
    WHERE id = ${memberId}::uuid AND restaurant_id = ${restaurantId}::uuid
      AND (${!entry.requireBalance} OR balance + ${entry.points} >= 0)
    RETURNING balance`;
  const balance = rows[0]?.balance;
  if (balance === undefined) return null;
  await tx.loyaltyTransaction.create({
    data: {
      restaurantId,
      memberId,
      kind: entry.kind,
      points: entry.points,
      balanceAfter: balance,
      orderId: entry.orderId ?? null,
      rewardId: entry.rewardId ?? null,
      reason: entry.reason.slice(0, 200),
      actorId: entry.actor?.id ?? null,
      actorName: entry.actor?.name?.slice(0, 100) ?? null,
      createdAt: now,
    },
  });
  return balance;
}

/** When a balance expires: `expiryDays` after the member's last earning or redemption; null when it never does. */
export function expiresAt(member: Pick<LoyaltyMember, 'balance' | 'lastActivityAt'>, settings: Pick<LoyaltySettings, 'expiryDays'>): Date | null {
  if (!settings.expiryDays || member.balance <= 0) return null;
  return new Date(member.lastActivityAt.getTime() + settings.expiryDays * DAY_MS);
}

/**
 * Expires the balances of members inactive for longer than their restaurant allows: one EXPIRE
 * transaction each, for the whole balance. Run hourly by the worker; `only` limits it to one member.
 * Returns how many balances expired.
 */
export async function expireDue(prisma: Pick<PrismaClient, 'loyaltySettings' | 'loyaltyMember' | '$transaction'>, now = new Date(), only?: { restaurantId: string; memberId: string }): Promise<number> {
  const programs = await prisma.loyaltySettings.findMany({
    where: { expiryDays: { not: null }, ...(only && { restaurantId: only.restaurantId }) },
    select: { restaurantId: true, expiryDays: true },
  });
  let expired = 0;
  for (const program of programs) {
    const cutoff = new Date(now.getTime() - program.expiryDays! * DAY_MS);
    const due = await prisma.loyaltyMember.findMany({
      where: { restaurantId: program.restaurantId, balance: { gt: 0 }, lastActivityAt: { lt: cutoff }, ...(only && { id: only.memberId }) },
      select: { id: true },
      take: 1000,
    });
    for (const member of due) {
      await prisma.$transaction(async (tx) => {
        // Re-read under the lock: an order may have just earned points.
        const [row] = await tx.$queryRaw<{ balance: number; last_activity_at: Date }[]>`
          SELECT balance, last_activity_at FROM loyalty_members WHERE id = ${member.id}::uuid FOR UPDATE`;
        if (!row || row.balance <= 0 || row.last_activity_at >= cutoff) return;
        await postLoyalty(tx, member.id, program.restaurantId, { kind: 'EXPIRE', points: -row.balance, reason: `No activity for ${program.expiryDays} days` }, now);
        expired += 1;
      });
    }
  }
  return expired;
}
