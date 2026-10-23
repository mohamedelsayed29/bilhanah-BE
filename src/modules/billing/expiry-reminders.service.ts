import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { expiryReminderEmail } from './billing-emails.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 7, 3 or 1 days before a period ends; 0 once it has ended. */
export function reminderBucket(endsAt: Date, now: Date): 0 | 1 | 3 | 7 | null {
  const left = endsAt.getTime() - now.getTime();
  if (left <= 0) return left > -2 * DAY_MS ? 0 : null;
  if (left <= DAY_MS) return 1;
  if (left <= 3 * DAY_MS) return 3;
  if (left <= 7 * DAY_MS) return 7;
  return null;
}

/**
 * Emails owners before their trial or paid period runs out, and once when it
 * has. Skipped when another period follows (already renewed) or the
 * restaurant is suspended. Each reminder is recorded first, so overlapping
 * runs never send it twice.
 */
@Injectable()
export class ExpiryRemindersService {
  private readonly logger = new Logger(ExpiryRemindersService.name);
  private readonly dashboardUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    config: ConfigService<Env, true>,
  ) {
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '');
  }

  async sendDue(now = new Date()): Promise<number> {
    const ending = await this.prisma.entitlement.findMany({
      where: { endsAt: { gt: new Date(now.getTime() - 2 * DAY_MS), lte: new Date(now.getTime() + 7 * DAY_MS) } },
      include: {
        reminders: { select: { daysBefore: true } },
        restaurant: {
          select: {
            status: true,
            owner: { select: { email: true, fullName: true, preferredLanguage: true } },
            entitlements: { select: { id: true, endsAt: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const entitlement of ending) {
      const bucket = reminderBucket(entitlement.endsAt, now);
      if (bucket === null || entitlement.restaurant.status === 'SUSPENDED') continue;
      const renewed = entitlement.restaurant.entitlements.some((other) => other.id !== entitlement.id && other.endsAt > entitlement.endsAt);
      // A smaller bucket already sent means this one is out of date (e.g. the worker was down).
      if (renewed || entitlement.reminders.some((reminder) => reminder.daysBefore <= bucket)) continue;

      try {
        await this.prisma.expiryReminder.create({
          data: { restaurantId: entitlement.restaurantId, entitlementId: entitlement.id, daysBefore: bucket },
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      this.mailer.sendInBackground(
        expiryReminderEmail(entitlement.restaurant.owner, entitlement.kind, bucket, entitlement.endsAt, this.dashboardUrl),
        `expiry-reminder-${bucket}`,
      );
      sent += 1;
    }
    if (sent) this.logger.log({ sent }, 'Sent expiry reminders');
    return sent;
  }
}
