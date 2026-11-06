import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type SupportNotification, type SupportNotificationKind, type SupportNotifications, ticketReference } from '@bilhanah/contracts';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';

/** One notification as delivered, for channels beyond the dashboard (email, push, ...). */
export type DeliveredNotification = { recipientId: string; kind: SupportNotificationKind; ticketId: string; restaurantId: string };

/**
 * A delivery channel besides the dashboard. None is registered today; an email or push channel
 * implements this and is provided under SUPPORT_NOTIFICATION_CHANNELS, without touching tickets.
 */
export interface SupportNotificationChannel {
  readonly name: string;
  deliver(notifications: DeliveredNotification[]): Promise<void>;
}
export const SUPPORT_NOTIFICATION_CHANNELS = Symbol('SUPPORT_NOTIFICATION_CHANNELS');

const LIST_SIZE = 30;

/**
 * In-dashboard support notifications for restaurant users and Bilhanah agents. There is one row per
 * recipient, ticket and kind: a new event on an unread one counts up instead of adding a duplicate, and
 * one already read comes back as unread.
 */
@Injectable()
export class SupportNotificationsService {
  private readonly logger = new Logger(SupportNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SUPPORT_NOTIFICATION_CHANNELS) private readonly channels: SupportNotificationChannel[] = [],
  ) {}

  /** Notifies `recipients` (never the person who caused it). */
  async notify(input: { kind: SupportNotificationKind; ticketId: string; restaurantId: string; recipients: string[]; actorId?: string | null }): Promise<void> {
    const recipients = [...new Set(input.recipients)].filter((id) => id !== input.actorId);
    if (!recipients.length) return;
    await this.prisma.$executeRaw`
      INSERT INTO "support_notifications" ("id", "recipient_id", "restaurant_id", "ticket_id", "kind", "count", "updated_at")
      SELECT gen_random_uuid(), recipient, ${input.restaurantId}::uuid, ${input.ticketId}::uuid, ${input.kind}::"support_notification_kind", 1, now()
      FROM unnest(${recipients}::uuid[]) AS recipient
      ON CONFLICT ("recipient_id", "ticket_id", "kind") DO UPDATE SET
        "count" = CASE WHEN "support_notifications"."read_at" IS NULL THEN "support_notifications"."count" + 1 ELSE 1 END,
        "read_at" = NULL,
        "updated_at" = now()`;
    const delivered = recipients.map((recipientId) => ({ recipientId, kind: input.kind, ticketId: input.ticketId, restaurantId: input.restaurantId }));
    for (const channel of this.channels) {
      await channel.deliver(delivered).catch((error: unknown) => this.logger.warn({ err: error, channel: channel.name }, 'Support notification channel failed'));
    }
  }

  /** Active Bilhanah support agents (administrators). */
  async agentIds(): Promise<string[]> {
    const agents = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
    return agents.map((agent) => agent.id);
  }

  async list(recipientId: string): Promise<SupportNotifications> {
    const [rows, unread] = await Promise.all([
      this.prisma.supportNotification.findMany({
        where: { recipientId },
        orderBy: [{ updatedAt: 'desc' }],
        take: LIST_SIZE,
        include: { ticket: { select: { number: true, subject: true, restaurant: { select: { name: true } } } } },
      }),
      this.prisma.supportNotification.count({ where: { recipientId, readAt: null } }),
    ]);
    return {
      unread,
      items: rows.map((row): SupportNotification => ({
        id: row.id,
        kind: row.kind,
        ticketId: row.ticketId,
        reference: ticketReference(row.ticket.number),
        subject: row.ticket.subject,
        restaurantName: row.ticket.restaurant.name,
        count: row.count,
        read: row.readAt !== null,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /** Marks the recipient's own notifications read (others' ids are ignored). */
  async markRead(recipientId: string, input: { ids?: string[]; all?: boolean; ticketId?: string }): Promise<void> {
    await this.prisma.supportNotification.updateMany({
      where: {
        recipientId,
        readAt: null,
        ...(input.all ? {} : input.ticketId ? { ticketId: input.ticketId } : { id: { in: input.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
  }
}
