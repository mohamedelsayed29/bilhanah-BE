import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ALERT_ERROR_CODES,
  ORDER_ERROR_CODES,
  type OrderAlerts,
  type OrderStatus,
  PUSH_LIMITS,
  type pushSubscriptionSchema,
} from '@bilhanah/contracts';
import type { RestaurantStatus } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { PushService } from '../../infrastructure/push/push.service.js';
import { PUSH_JOBS, type PushJobs } from '../../infrastructure/queues/queues.module.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { TrackingTokens } from './tracking-token.js';

/** Order updates a diner hears about by push: the order is ready, or it will not come. */
export const PUSHED_STATUSES: ReadonlySet<OrderStatus> = new Set(['READY', 'REJECTED', 'CANCELLED']);
/** And, for diners who asked for every update, the steps on the way. */
export const PROGRESS_STATUSES: ReadonlySet<OrderStatus> = new Set(['ACCEPTED', 'PREPARING']);
/** Diners can ask for alerts until the order is ready. */
const SUBSCRIBABLE_STATUSES: ReadonlySet<OrderStatus> = new Set(['PLACED', 'ACCEPTED', 'PREPARING']);

const orderNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.ORDER_NOT_FOUND, message: 'Order not found.' });
const pushUnavailable = (reason: 'PLAN' | 'NOT_CONFIGURED' | 'ORDER_FINISHED', message: string) =>
  new ConflictException({ code: ALERT_ERROR_CODES.PUSH_UNAVAILABLE, message, details: { reason } });

/**
 * Order-ready alerts (the Full Experience plan): whether a tracking page may
 * ring, and diners' Web Push subscriptions. The worker sends the messages.
 */
@Injectable()
export class OrderAlertsService {
  private readonly logger = new Logger(OrderAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly push: PushService,
    private readonly trackingTokens: TrackingTokens,
    @Inject(PUSH_JOBS) private readonly pushJobs: PushJobs,
  ) {}

  async alerts(token: string): Promise<OrderAlerts> {
    const order = await this.orderFor(token);
    const readyAlerts = await this.planHasReadyAlerts(order.restaurant);
    const publicKey = this.push.publicKey;
    return { readyAlerts, push: readyAlerts && publicKey ? { publicKey } : null };
  }

  /** Saves (or refreshes) a browser's subscription. Returns the order id when the owner's view changed. */
  async subscribe(token: string, input: z.output<typeof pushSubscriptionSchema>): Promise<string | null> {
    const order = await this.orderFor(token);
    if (!(await this.planHasReadyAlerts(order.restaurant))) {
      throw pushUnavailable('PLAN', "This restaurant's plan does not include order-ready alerts.");
    }
    if (!this.push.publicKey) throw pushUnavailable('NOT_CONFIGURED', 'Notifications are not available right now.');
    if (!SUBSCRIBABLE_STATUSES.has(order.status)) throw pushUnavailable('ORDER_FINISHED', 'This order is already ready or closed.');

    const where = { orderId_endpoint: { orderId: order.id, endpoint: input.endpoint } };
    const data = { p256dh: input.keys.p256dh, auth: input.keys.auth, language: input.language, updates: input.updates };
    const existing = await this.prisma.pushSubscription.findUnique({ where, select: { id: true } });
    if (existing) {
      await this.prisma.pushSubscription.update({ where, data });
      return null;
    }
    // The oldest subscription makes room: a diner who keeps re-subscribing replaces their own.
    const others = await this.prisma.pushSubscription.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      skip: PUSH_LIMITS.subscriptionsPerOrder - 1,
      select: { id: true },
    });
    if (others.length) await this.prisma.pushSubscription.deleteMany({ where: { id: { in: others.map(({ id }) => id) } } });
    await this.prisma.pushSubscription.upsert({ where, create: { orderId: order.id, endpoint: input.endpoint, ...data }, update: data });
    return order.id;
  }

  /** Forgets a browser's subscription. Returns the order id when the owner's view changed. */
  async unsubscribe(token: string, endpoint: string): Promise<string | null> {
    const order = await this.orderFor(token);
    const { count } = await this.prisma.pushSubscription.deleteMany({ where: { orderId: order.id, endpoint } });
    return count ? order.id : null;
  }

  /** Queues a push to every browser subscribed to the order. Never fails the status change itself. */
  async queueStatus(orderId: string, status: OrderStatus): Promise<void> {
    const progress = PROGRESS_STATUSES.has(status);
    if (!PUSHED_STATUSES.has(status) && !progress) return;
    try {
      const targets = await this.prisma.pushSubscription.findMany({ where: { orderId, ...(progress && { updates: 'ALL' as const }) }, select: { id: true } });
      if (!targets.length) return;
      await this.pushJobs.addBulk(
        targets.map(({ id }) => ({
          name: 'order-status',
          data: { subscriptionId: id, status },
          // A repeated status change cannot notify twice. (BullMQ ids may not contain ":".)
          opts: { jobId: `${id}_${status}` },
        })),
      );
    } catch (error) {
      this.logger.warn({ err: error, orderId, status }, 'Could not queue order push notifications');
    }
  }

  private async orderFor(token: string) {
    const orderId = this.trackingTokens.verify(token);
    const order = orderId
      ? await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, restaurant: { select: { id: true, status: true } } } })
      : null;
    if (!order) throw orderNotFound();
    return order;
  }

  private async planHasReadyAlerts(restaurant: { id: string; status: RestaurantStatus }): Promise<boolean> {
    const access = await this.subscriptions.accessFor(restaurant);
    return hasAccess(access) && access.features.readyAlerts;
  }
}
