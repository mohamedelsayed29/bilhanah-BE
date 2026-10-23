import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, Worker } from 'bullmq';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { type PushOutcome, PushService } from '../infrastructure/push/push.service.js';
import { PUSH_QUEUE, type PushJob, queueConnection } from '../infrastructure/queues/queues.js';
import { MediaService } from '../modules/media/media.service.js';
import { orderPushPayload, orderPushTopic } from '../modules/orders/order-push.js';
import { TrackingTokens } from '../modules/orders/tracking-token.js';

/** The push service keeps trying an offline phone this long; an older "ready" is not worth delivering. */
const PUSH_TTL_SECONDS = 60 * 60;

/** Sends order updates to diners' browsers; BullMQ retries temporary failures with backoff. */
@Injectable()
export class PushProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PushProcessor.name);
  private readonly urlTemplate: string;
  private worker?: Worker<PushJob>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly media: MediaService,
    private readonly trackingTokens: TrackingTokens,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker<PushJob>(PUSH_QUEUE, (job) => this.process(job), {
      connection: queueConnection(this.config.get('REDIS_URL', { infer: true })),
      concurrency: 10,
    });
    this.worker.on('failed', (job, error) => {
      // Push endpoints identify a browser; log the subscription id only.
      this.logger.warn({ err: error, subscriptionId: job?.data.subscriptionId, attempt: job?.attemptsMade }, 'Push delivery attempt failed');
    });
  }

  async process(job: Pick<Job<PushJob>, 'data'>): Promise<PushOutcome | 'skipped'> {
    const { subscriptionId, status } = job.data;
    const subscription = await this.prisma.pushSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        order: {
          select: { id: true, number: true, type: true, rejectionReason: true, restaurant: { select: { name: true, subdomain: true, logo: true } } },
        },
      },
    });
    // Unsubscribed, or purged with its order, since the job was queued.
    if (!subscription) return 'skipped';

    const { order } = subscription;
    const logo = order.restaurant.logo ? this.media.toImageSet(order.restaurant.logo) : null;
    const payload = orderPushPayload({
      orderId: order.id,
      number: order.number,
      type: order.type,
      status,
      rejectionReason: order.rejectionReason,
      restaurantName: order.restaurant.name,
      language: subscription.language,
      url: `${this.urlTemplate.replace('{subdomain}', order.restaurant.subdomain)}/order/${this.trackingTokens.issue(order.id)}`,
      icon: logo?.sources[0]?.url ?? null,
    });

    const outcome = await this.push.send(subscription, JSON.stringify(payload), { topic: orderPushTopic(order.id), ttlSeconds: PUSH_TTL_SECONDS });
    if (outcome === 'gone') await this.prisma.pushSubscription.deleteMany({ where: { id: subscriptionId } });
    if (outcome === 'rejected') this.logger.warn({ subscriptionId, status }, 'The push service refused an order notification');
    return outcome;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
