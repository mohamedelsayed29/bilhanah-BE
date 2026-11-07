import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type { Env } from '../config/env.schema.js';
import { MAINTENANCE_QUEUE, queueConnection } from '../infrastructure/queues/queues.js';
import { ExpiryRemindersService } from '../modules/billing/expiry-reminders.service.js';
import { VisitsService } from '../modules/analytics/visits.service.js';
import { MediaService } from '../modules/media/media.service.js';
import { SupportAttachmentsService } from '../modules/support/tickets/support-attachments.service.js';
import { expireDue } from '../modules/loyalty/loyalty-ledger.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { ShopMaintenanceService } from './shop-maintenance.service.js';

const PURGE_EXPIRED = 'purge-expired';
const HOUR_MS = 60 * 60 * 1000;

/** Runs periodic housekeeping. The schedule lives in Redis, so it runs once however many workers there are. */
@Injectable()
export class MaintenanceProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly media: MediaService,
    private readonly supportAttachments: SupportAttachmentsService,
    private readonly reminders: ExpiryRemindersService,
    private readonly shop: ShopMaintenanceService,
    private readonly visits: VisitsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const connection = queueConnection(this.config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection });
    await this.queue.upsertJobScheduler(
      PURGE_EXPIRED,
      { every: HOUR_MS },
      { name: PURGE_EXPIRED, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );

    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        if (job.name !== PURGE_EXPIRED) return;
        const result = await this.maintenance.purgeExpired();
        // Uploads get a day to be attached to an item or the restaurant.
        const images = await this.media.purgeUnused(new Date(Date.now() - 24 * HOUR_MS));
        // Support screenshots never sent with a ticket or reply, likewise.
        const attachments = await this.supportAttachments.purgeUnlinked(new Date(Date.now() - 24 * HOUR_MS));
        const shop = await this.shop.run();
        // Loyalty balances past their inactivity expiry (docs/LOYALTY.md).
        const loyaltyExpired = await expireDue(this.prisma);
        this.logger.log({ ...result, unusedImages: images, unlinkedSupportAttachments: attachments, ...shop, loyaltyExpired }, 'Purged expired records');
        await this.reminders.sendDue();
        // Visit counters, Redis to Postgres.
        await this.visits.flush();
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, job: job?.name }, 'Maintenance job failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
