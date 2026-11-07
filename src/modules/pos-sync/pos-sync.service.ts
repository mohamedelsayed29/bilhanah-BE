import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PosProviderInfo, PosWebhookConfig } from '@bilhanah/contracts';
import type { PosIntegration, PosSyncJob, Prisma } from '@bilhanah/database';
import { SecretBox } from '../../common/crypto/secret-box.js';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { type PosCredentials, type PosProviderAdapter, PROVIDERS, ProviderError, UnsupportedCapability } from './providers.js';

const MINUTE = 60_000;
/** Backoff: 30 s, 1, 2, 4, 8 min… capped at an hour. */
export const backoffMs = (attempt: number) => Math.min(60 * MINUTE, 30_000 * 2 ** Math.max(0, attempt - 1));
/** A job left RUNNING this long (a worker died) is picked up again. */
const STUCK_MS = 5 * MINUTE;

/**
 * Sync with external POS systems (docs/POS.md, task 6): order events become jobs, one per
 * integration, run by the worker with retries and backoff until the provider confirms them. A job
 * that runs out of retries, or that the provider refuses, is kept (DEAD) for a manual retry; an
 * order is never marked synced before the provider answered.
 */
@Injectable()
export class PosSyncService {
  private readonly logger = new Logger(PosSyncService.name);
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    config: ConfigService<Env, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  providers(): PosProviderInfo[] {
    return [...PROVIDERS.values()].map((provider) => provider.info);
  }

  adapter(key: string): PosProviderAdapter | null {
    return PROVIDERS.get(key) ?? null;
  }

  seal(credentials: PosCredentials): string {
    return this.box.seal(JSON.stringify(credentials));
  }

  credentials(integration: Pick<PosIntegration, 'credentialsSealed'>): PosCredentials {
    return JSON.parse(this.box.open(integration.credentialsSealed)) as PosCredentials;
  }

  /** Endpoints must be HTTPS and public in production (no requests into private networks). */
  endpointAllowed(url: string): boolean {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (!this.production) return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return !(host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/.test(host));
  }

  // --- Order events ------------------------------------------------------------------

  /**
   * An order was placed or cancelled: one job per ACTIVE integration that sends this kind of order
   * (its channel, its branch). Idempotent per order and event. Never fails the order.
   */
  async orderEvent(restaurantId: string, orderId: string, kind: 'order.create' | 'order.cancel'): Promise<void> {
    try {
      // Paused integrations queue too: their orders go out once resumed.
      const integrations = await this.prisma.posIntegration.findMany({ where: { restaurantId, status: { in: ['ACTIVE', 'PAUSED'] } } });
      if (!integrations.length) return;
      const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId }, include: { items: { orderBy: { sortOrder: 'asc' } }, branch: { select: { id: true, name: true } } } });
      if (!order) return;
      for (const integration of integrations) {
        const config = integration.config as PosWebhookConfig;
        if (integration.branchId && integration.branchId !== order.branchId) continue;
        if (!config.pushChannels?.includes(order.channel)) continue;
        if (kind === 'order.cancel') {
          if (!config.pushCancellations) continue;
          // Only orders the POS was sent.
          const sent = await this.prisma.posSyncJob.count({ where: { integrationId: integration.id, kind: 'order.create', entityId: orderId } });
          if (!sent) continue;
        }
        const payload = kind === 'order.create' ? await this.orderPayload(integration.id, order) : { orderId: order.id, number: order.number, status: order.status, reason: order.rejectionReason };
        await this.prisma.posSyncJob.createMany({
          data: [{ integrationId: integration.id, restaurantId, kind, entityId: orderId, idempotencyKey: `${kind}:${orderId}`, payload: payload as Prisma.InputJsonValue }],
          skipDuplicates: true,
        });
      }
    } catch (error) {
      this.logger.error({ err: error, orderId }, 'Could not queue POS sync');
    }
  }

  private async orderPayload(integrationId: string, order: Prisma.OrderGetPayload<{ include: { items: true; branch: { select: { id: true; name: true } } } }>) {
    const mappings = await this.prisma.posMapping.findMany({ where: { integrationId, OR: [{ entity: 'BRANCH', localId: order.branchId }, { localId: { in: order.items.flatMap((item) => [item.menuItemId, item.variantId].filter((id): id is string => Boolean(id))) } }] } });
    const external = (entity: string, id: string | null) => (id ? mappings.find((row) => row.entity === entity && row.localId === id)?.externalId ?? null : null);
    return {
      orderId: order.id, number: order.number, channel: order.channel, type: order.type, status: order.status, placedAt: order.placedAt.toISOString(),
      branch: { id: order.branch.id, name: order.branch.name, externalId: external('BRANCH', order.branch.id) },
      tableLabel: order.tableLabel, customerName: order.customerName, customerPhone: order.customerPhone, note: order.note,
      items: order.items.map((item) => ({
        menuItemId: item.menuItemId, externalItemId: external('MENU_ITEM', item.menuItemId), variantId: item.variantId, externalVariantId: external('VARIANT', item.variantId),
        name: item.nameAr, nameEn: item.nameEn, variant: item.variantNameAr, quantity: item.quantity, unitPricePiastres: item.unitPricePiastres, note: item.note,
      })),
      subtotalPiastres: order.subtotalPiastres, discountPiastres: order.discountPiastres, serviceChargePiastres: order.serviceChargePiastres, taxPiastres: order.taxPiastres, totalPiastres: order.totalPiastres,
      currency: 'EGP',
    };
  }

  // --- Running jobs ------------------------------------------------------------------

  /** Claims due jobs (SKIP LOCKED: several workers never run one twice) and runs them. Returns how many ran. */
  async runDue(now = new Date(), limit = 25): Promise<number> {
    await this.prisma.posSyncJob.updateMany({ where: { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, data: { status: 'PENDING' } });
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE pos_sync_jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (SELECT id FROM pos_sync_jobs WHERE status = 'PENDING' AND next_run_at <= ${now} ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    for (const { id } of claimed) await this.run(id, now);
    return claimed.length;
  }

  private async run(jobId: string, now: Date): Promise<void> {
    const job = await this.prisma.posSyncJob.findUniqueOrThrow({ where: { id: jobId }, include: { integration: true } });
    const integration = job.integration;
    if (integration.status === 'PAUSED') {
      // Paused: kept for when it resumes, without spending an attempt.
      await this.prisma.posSyncJob.update({ where: { id: jobId }, data: { status: 'PENDING', attempts: { decrement: 1 }, nextRunAt: new Date(now.getTime() + 5 * MINUTE) } });
      return;
    }
    if (integration.status === 'DISCONNECTED') return this.finish(job, now, { ok: false, retryable: false, error: 'The integration was disconnected.' });
    const adapter = this.adapter(integration.provider);
    if (!adapter) return this.finish(job, now, { ok: false, retryable: false, error: `No adapter for ${integration.provider}.` });
    const context = { config: integration.config as PosWebhookConfig, credentials: this.credentials(integration), deliveryId: `${integration.id}:${job.idempotencyKey}` };
    try {
      if (job.kind === 'order.create') {
        const { externalId } = await adapter.createOrder(context, job.payload);
        if (externalId && job.entityId) {
          await this.prisma.posMapping.upsert({
            where: { integrationId_entity_localId: { integrationId: integration.id, entity: 'ORDER', localId: job.entityId } },
            create: { integrationId: integration.id, restaurantId: integration.restaurantId, entity: 'ORDER', localId: job.entityId, externalId },
            update: { externalId },
          }).catch(() => undefined);
        }
      } else if (job.kind === 'order.cancel') {
        await adapter.cancelOrder(context, job.payload);
      } else {
        throw new ProviderError(`Unknown job kind ${job.kind}.`, false);
      }
      await this.finish(job, now, { ok: true, statusCode: 200 });
    } catch (error) {
      if (error instanceof UnsupportedCapability) return this.finish(job, now, { ok: false, retryable: false, error: `The provider does not support ${error.capability}.` });
      if (error instanceof ProviderError) return this.finish(job, now, { ok: false, retryable: error.retryable, error: error.message, statusCode: error.statusCode, retryAfterMs: error.retryAfterMs });
      return this.finish(job, now, { ok: false, retryable: true, error: (error as Error).message?.slice(0, 300) ?? 'Unexpected error' });
    }
  }

  private async finish(job: PosSyncJob, now: Date, outcome: { ok: true; statusCode: number } | { ok: false; retryable: boolean; error: string; statusCode?: number | null; retryAfterMs?: number | null }): Promise<void> {
    if (outcome.ok) {
      await this.prisma.$transaction([
        this.prisma.posSyncJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', completedAt: now, lastError: null, lastStatusCode: outcome.statusCode } }),
        this.prisma.posIntegration.update({ where: { id: job.integrationId }, data: { lastSyncAt: now, lastError: null } }),
      ]);
      return;
    }
    const dead = !outcome.retryable || job.attempts >= job.maxAttempts;
    await this.prisma.$transaction([
      this.prisma.posSyncJob.update({
        where: { id: job.id },
        data: { status: dead ? 'DEAD' : 'PENDING', lastError: outcome.error.slice(0, 500), lastStatusCode: outcome.statusCode ?? null, nextRunAt: new Date(now.getTime() + (outcome.retryAfterMs ?? backoffMs(job.attempts))) },
      }),
      this.prisma.posIntegration.update({ where: { id: job.integrationId }, data: { lastError: outcome.error.slice(0, 500) } }),
    ]);
    if (dead) this.logger.warn({ jobId: job.id, integrationId: job.integrationId, error: outcome.error }, 'POS sync job failed for good');
  }

  /** A DEAD job back in the queue, from the start. */
  async retry(integrationId: string, jobId: string): Promise<boolean> {
    const { count } = await this.prisma.posSyncJob.updateMany({ where: { id: jobId, integrationId, status: 'DEAD' }, data: { status: 'PENDING', attempts: 0, nextRunAt: new Date(), lastError: null } });
    return count === 1;
  }
}
