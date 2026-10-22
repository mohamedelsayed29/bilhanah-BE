import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ended sessions stay listed this long for support questions. */
const ENDED_SESSION_RETENTION_DAYS = 30;
/** Accounts never confirmed within this many days are removed, freeing the email. */
const UNVERIFIED_ACCOUNT_DAYS = 30;

export type PurgeResult = {
  sessions: number;
  verificationTokens: number;
  resetTokens: number;
  unverifiedAccounts: number;
};

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Deletes rows that can no longer be used. Safe to run at any time. */
  async purgeExpired(now = new Date()): Promise<PurgeResult> {
    const sessionCutoff = new Date(now.getTime() - ENDED_SESSION_RETENTION_DAYS * DAY_MS);
    const unverifiedCutoff = new Date(now.getTime() - UNVERIFIED_ACCOUNT_DAYS * DAY_MS);
    const spentToken = { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] };

    const [sessions, verificationTokens, resetTokens, unverifiedAccounts] = await this.prisma.$transaction([
      this.prisma.session.deleteMany({
        where: { OR: [{ expiresAt: { lte: sessionCutoff } }, { revokedAt: { lte: sessionCutoff } }] },
      }),
      this.prisma.emailVerificationToken.deleteMany({ where: spentToken }),
      this.prisma.passwordResetToken.deleteMany({ where: spentToken }),
      // Unconfirmed owners cannot sign in or create a restaurant, so nothing else is lost.
      this.prisma.user.deleteMany({
        where: { role: 'OWNER', emailVerifiedAt: null, createdAt: { lte: unverifiedCutoff } },
      }),
    ]);
    return {
      sessions: sessions.count,
      verificationTokens: verificationTokens.count,
      resetTokens: resetTokens.count,
      unverifiedAccounts: unverifiedAccounts.count,
    };
  }
}
