import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  ORDER_PAYMENT_METHODS, ORDER_STATUSES, POS_ERROR_CODES, POS_INTEGRATION_ERROR_CODES as CODES, type OrderPaymentMethod, type OrderStatus,
  type PosIntegration, type PosIntegrationSecrets, type PosMapping, type PosProviderInfo, type PosSyncJob, type PosWebhookConfig, type PosWebhookLog,
  type posIntegrationCreateSchema, type posIntegrationUpdateSchema, type posMappingSchema,
} from '@bilhanah/contracts';
import type { PosIntegration as IntegrationRow, Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PosSyncService } from '../pos-sync/pos-sync.service.js';
import { UnsupportedCapability } from '../pos-sync/providers.js';
import { PosAccessService } from './pos-access.service.js';

const notFound = () => new NotFoundException({ code: CODES.POS_INTEGRATION_NOT_FOUND, message: 'Integration not found.' });
const invalid = (message: string, details?: Record<string, unknown>) => new BadRequestException({ code: 'VALIDATION_FAILED', message, ...(details && { details }) });
const secret = () => randomBytes(32).toString('base64url');

/**
 * External POS integrations for the owner (pos.settings, a POS whose mode includes EXTERNAL), and
 * the providers' webhooks. Secrets are sealed at rest and shown once; disconnecting keeps every
 * order, payment, job and event.
 */
@Injectable()
export class PosIntegrationsService {
  private readonly apiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly access: PosAccessService,
    private readonly sync: PosSyncService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.apiUrl = (config.get('API_PUBLIC_URL', { infer: true }) ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  private async owner(userId: string): Promise<Scope> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'pos.settings');
    const account = await this.access.requireActive(scope.restaurant);
    if (account.mode === 'BILHANAH') {
      throw new ConflictException({ code: POS_ERROR_CODES.POS_MODE_NOT_ALLOWED, message: 'Choose a POS mode that includes an external POS first.', details: { mode: account.mode } });
    }
    return scope;
  }

  private async own(scope: Scope, id: string): Promise<IntegrationRow> {
    const row = await this.prisma.posIntegration.findFirst({ where: { id, restaurantId: scope.restaurant.id } });
    if (!row) throw notFound();
    return row;
  }

  providers(): PosProviderInfo[] {
    return this.sync.providers();
  }

  async list(userId: string): Promise<PosIntegration[]> {
    const scope = await this.owner(userId);
    const rows = await this.prisma.posIntegration.findMany({ where: { restaurantId: scope.restaurant.id }, orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((row) => this.view(row)));
  }

  /** Connects a provider. Its secrets are returned once, here. */
  async create(userId: string, input: z.output<typeof posIntegrationCreateSchema>): Promise<{ integration: PosIntegration; secrets: PosIntegrationSecrets }> {
    const scope = await this.owner(userId);
    if (!this.sync.adapter(input.provider)) throw new BadRequestException({ code: CODES.POS_PROVIDER_UNKNOWN, message: 'This POS provider is not supported.' });
    await this.checkConfig(scope, input.branchId, input.config);
    const secrets: PosIntegrationSecrets = { outboundSecret: secret(), inboundSecret: secret() };
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.posIntegration.create({
        data: { restaurantId: scope.restaurant.id, provider: input.provider, name: input.name, branchId: input.branchId, config: input.config as Prisma.InputJsonValue, credentialsSealed: this.sync.seal(secrets) },
      });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.integration.connected', targetType: 'pos-integration', targetId: created.id, metadata: { provider: input.provider, name: input.name } }, tx);
      return created;
    });
    return { integration: await this.view(row), secrets };
  }

  async update(userId: string, id: string, input: z.output<typeof posIntegrationUpdateSchema>): Promise<PosIntegration> {
    const scope = await this.owner(userId);
    const row = await this.own(scope, id);
    if (input.config || input.branchId !== undefined) await this.checkConfig(scope, input.branchId === undefined ? row.branchId : input.branchId, input.config ?? (row.config as PosWebhookConfig));
    const updated = await this.prisma.posIntegration.update({ where: { id }, data: { ...(input.name && { name: input.name }), ...(input.branchId !== undefined && { branchId: input.branchId }), ...(input.config && { config: input.config as Prisma.InputJsonValue }) } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.integration.updated', targetType: 'pos-integration', targetId: id, metadata: { previous: { name: row.name, branchId: row.branchId, config: row.config }, next: input } as unknown as Prisma.InputJsonValue });
    return this.view(updated);
  }

  async setStatus(userId: string, id: string, status: 'ACTIVE' | 'PAUSED' | 'DISCONNECTED'): Promise<PosIntegration> {
    const scope = await this.owner(userId);
    const row = await this.own(scope, id);
    if (row.status === 'DISCONNECTED' && status !== 'DISCONNECTED') throw new ConflictException({ code: 'CONFLICT', message: 'A disconnected integration cannot be resumed; connect it again.' });
    const updated = await this.prisma.posIntegration.update({ where: { id }, data: { status, ...(status === 'DISCONNECTED' && { disconnectedAt: new Date() }) } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: `pos.integration.${status === 'ACTIVE' ? 'resumed' : status.toLowerCase()}`, targetType: 'pos-integration', targetId: id });
    return this.view(updated);
  }

  async rotate(userId: string, id: string): Promise<PosIntegrationSecrets> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    const secrets: PosIntegrationSecrets = { outboundSecret: secret(), inboundSecret: secret() };
    await this.prisma.posIntegration.update({ where: { id }, data: { credentialsSealed: this.sync.seal(secrets) } });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.integration.secrets_rotated', targetType: 'pos-integration', targetId: id });
    return secrets;
  }

  /** Calls the provider now; records whether it answered. */
  async test(userId: string, id: string): Promise<PosIntegration> {
    const scope = await this.owner(userId);
    const row = await this.own(scope, id);
    const adapter = this.sync.adapter(row.provider);
    if (!adapter) throw new BadRequestException({ code: CODES.POS_PROVIDER_UNKNOWN, message: 'This POS provider is not supported.' });
    let ok = true;
    let error: string | null = null;
    try {
      await adapter.testConnection({ config: row.config as PosWebhookConfig, credentials: this.sync.credentials(row), deliveryId: `${row.id}:test:${Date.now()}` });
    } catch (failure) {
      ok = false;
      error = (failure as Error).message.slice(0, 500);
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.integration.test_failed', targetType: 'pos-integration', targetId: id, metadata: { error } });
    }
    const updated = await this.prisma.posIntegration.update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: ok, ...(error ? { lastError: error } : {}) } });
    return this.view(updated);
  }

  /** Menu sync: only where the provider has a menu API (the webhook provider does not). */
  async syncMenu(userId: string, id: string): Promise<never> {
    const scope = await this.owner(userId);
    const row = await this.own(scope, id);
    const adapter = this.sync.adapter(row.provider)!;
    try {
      return await adapter.syncMenu({ config: row.config as PosWebhookConfig, credentials: this.sync.credentials(row), deliveryId: `${row.id}:menu` });
    } catch (error) {
      if (error instanceof UnsupportedCapability) throw new ConflictException({ code: CODES.POS_CAPABILITY_UNSUPPORTED, message: 'This provider cannot sync menus.', details: { capability: error.capability } });
      throw error;
    }
  }

  async jobs(userId: string, id: string, status?: string): Promise<PosSyncJob[]> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    const rows = await this.prisma.posSyncJob.findMany({ where: { integrationId: id, ...(status && { status: status as 'PENDING' }) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((row) => ({
      id: row.id, kind: row.kind, entityId: row.entityId, status: row.status, attempts: row.attempts, maxAttempts: row.maxAttempts, nextRunAt: row.nextRunAt.toISOString(),
      lastError: row.lastError, lastStatusCode: row.lastStatusCode, completedAt: row.completedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    }));
  }

  async retry(userId: string, id: string, jobId: string): Promise<void> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    if (!(await this.sync.retry(id, jobId))) throw new ConflictException({ code: 'CONFLICT', message: 'Only failed jobs can be retried.' });
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'pos.integration.job_retried', targetType: 'pos-sync-job', targetId: jobId });
  }

  async logs(userId: string, id: string): Promise<PosWebhookLog[]> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    const rows = await this.prisma.posWebhookEvent.findMany({ where: { integrationId: id }, orderBy: { receivedAt: 'desc' }, take: 100 });
    return rows.map((row) => ({ id: row.id, eventId: row.eventId, type: row.type, outcome: row.outcome, error: row.error, receivedAt: row.receivedAt.toISOString() }));
  }

  async mappings(userId: string, id: string): Promise<PosMapping[]> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    const rows = await this.prisma.posMapping.findMany({ where: { integrationId: id }, orderBy: [{ entity: 'asc' }, { updatedAt: 'desc' }] });
    return rows.map((row) => ({ id: row.id, entity: row.entity, localId: row.localId, externalId: row.externalId, updatedAt: row.updatedAt.toISOString() }));
  }

  /** Links a Bilhanah record to its id in the external POS (it must be this restaurant's). */
  async map(userId: string, id: string, input: z.output<typeof posMappingSchema>): Promise<PosMapping> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    const restaurantId = scope.restaurant.id;
    const exists = input.entity === 'BRANCH' ? await this.prisma.branch.count({ where: { id: input.localId, restaurantId } })
      : input.entity === 'CATEGORY' ? await this.prisma.category.count({ where: { id: input.localId, restaurantId } })
        : input.entity === 'MENU_ITEM' ? await this.prisma.menuItem.count({ where: { id: input.localId, restaurantId } })
          : await this.prisma.menuItemVariant.count({ where: { id: input.localId, item: { restaurantId } } });
    if (!exists) throw invalid('That record is not on your menu.', { field: 'localId' });
    try {
      const row = await this.prisma.posMapping.upsert({
        where: { integrationId_entity_localId: { integrationId: id, entity: input.entity, localId: input.localId } },
        create: { integrationId: id, restaurantId, ...input },
        update: { externalId: input.externalId },
      });
      return { id: row.id, entity: row.entity, localId: row.localId, externalId: row.externalId, updatedAt: row.updatedAt.toISOString() };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ code: CODES.POS_MAPPING_CONFLICT, message: 'That external id is already linked to another record.' });
      throw error;
    }
  }

  async unmap(userId: string, id: string, mappingId: string): Promise<void> {
    const scope = await this.owner(userId);
    await this.own(scope, id);
    await this.prisma.posMapping.deleteMany({ where: { id: mappingId, integrationId: id } });
  }

  // --- Webhooks ------------------------------------------------------------------------

  /**
   * An event from the provider: authenticated by its signature, processed once per event id, and
   * logged. Status updates and payments apply only when the integration accepts them; they never
   * send anything back to the provider (no sync loops).
   */
  async webhook(integrationId: string, rawBody: Buffer | undefined, body: unknown, headers: Record<string, string | undefined>, now = new Date()): Promise<{ outcome: string; duplicate?: boolean }> {
    const integration = /^[0-9a-f-]{36}$/i.test(integrationId) ? await this.prisma.posIntegration.findUnique({ where: { id: integrationId } }) : null;
    const reject = () => new UnauthorizedException({ code: CODES.POS_WEBHOOK_INVALID, message: 'Invalid webhook.' });
    if (!integration || integration.status === 'DISCONNECTED' || !rawBody) throw reject();
    const adapter = this.sync.adapter(integration.provider);
    const context = { config: integration.config as PosWebhookConfig, credentials: this.sync.credentials(integration), deliveryId: '' };
    if (!adapter || !adapter.verifyWebhook(context, rawBody, headers, now)) {
      await this.audit.record({ actorId: null, restaurantId: integration.restaurantId, action: 'pos.webhook.rejected', targetType: 'pos-integration', targetId: integration.id });
      throw reject();
    }
    if (integration.status === 'PAUSED') throw new ConflictException({ code: 'CONFLICT', message: 'This integration is paused; send the event again later.' });
    const event = adapter.parseWebhook(body);
    if (!event.id) throw invalid('The event needs an id.');
    try {
      await this.prisma.posWebhookEvent.create({ data: { integrationId, restaurantId: integration.restaurantId, eventId: event.id, type: event.type === 'unknown' ? event.raw.slice(0, 60) || 'unknown' : event.type, outcome: 'RECEIVED', payload: (body ?? {}) as Prisma.InputJsonValue, receivedAt: now } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return { outcome: 'DUPLICATE', duplicate: true };
      throw error;
    }
    let outcome = 'IGNORED';
    let failure: string | null = null;
    try {
      if (event.type !== 'unknown') {
        const orderId = await this.resolveOrder(integration, event.orderId, event.externalOrderId);
        const config = integration.config as PosWebhookConfig;
        if (!orderId) failure = 'Order not found.';
        else if (event.type === 'order.status' && config.acceptStatusUpdates) {
          if (!(ORDER_STATUSES as readonly string[]).includes(event.status)) failure = `Unknown status ${event.status}.`;
          else outcome = (await this.orders.applyExternalStatus(integration.restaurantId, orderId, event.status as OrderStatus, `POS · ${integration.name}`, now)) ? 'PROCESSED' : 'IGNORED';
        } else if (event.type === 'order.paid' && config.acceptPayments) {
          if (!(ORDER_PAYMENT_METHODS as readonly string[]).includes(event.method) || !(event.amountPiastres > 0)) failure = 'Invalid payment.';
          else {
            await this.orders.recordPayment(null, integration.restaurantId, orderId, `ext:${integration.id}:${event.id}`.slice(0, 64), {
              method: event.method as OrderPaymentMethod, amountPiastres: Math.round(event.amountPiastres), reference: event.reference ?? null, integrationId: integration.id, actorName: `POS · ${integration.name}`,
            }, now);
            outcome = 'PROCESSED';
          }
        }
      }
    } catch (error) {
      failure = ((error as { response?: { message?: string } }).response?.message ?? (error as Error).message ?? 'Failed').slice(0, 500);
    }
    if (failure) outcome = 'FAILED';
    await this.prisma.posWebhookEvent.update({ where: { integrationId_eventId: { integrationId, eventId: event.id } }, data: { outcome, error: failure } });
    if (failure) await this.prisma.posIntegration.update({ where: { id: integrationId }, data: { lastError: `Webhook ${event.id}: ${failure}`.slice(0, 500) } });
    return { outcome };
  }

  private async resolveOrder(integration: IntegrationRow, orderId?: string, externalOrderId?: string): Promise<string | null> {
    if (orderId && /^[0-9a-f-]{36}$/i.test(orderId)) {
      const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId: integration.restaurantId }, select: { id: true } });
      return order?.id ?? null;
    }
    if (externalOrderId) {
      const mapping = await this.prisma.posMapping.findUnique({ where: { integrationId_entity_externalId: { integrationId: integration.id, entity: 'ORDER', externalId: externalOrderId } } });
      return mapping?.localId ?? null;
    }
    return null;
  }

  // --- Helpers ---------------------------------------------------------------------------

  private async checkConfig(scope: Scope, branchId: string | null, config: PosWebhookConfig) {
    if (branchId) await this.scopes.branch(scope, branchId);
    if (!this.sync.endpointAllowed(config.endpointUrl)) throw invalid('Use a public HTTPS address for the endpoint.', { field: 'endpointUrl' });
  }

  private async view(row: IntegrationRow): Promise<PosIntegration> {
    const [groups, mappings] = await Promise.all([
      this.prisma.posSyncJob.groupBy({ by: ['status'], where: { integrationId: row.id }, _count: { _all: true } }),
      this.prisma.posMapping.count({ where: { integrationId: row.id } }),
    ]);
    const count = (status: string) => groups.find((group) => group.status === status)?._count._all ?? 0;
    return {
      id: row.id, provider: row.provider, name: row.name, status: row.status, branchId: row.branchId, config: row.config as PosWebhookConfig,
      webhookUrl: `${this.apiUrl}/v1/public/pos/webhooks/${row.id}`,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null, lastTestAt: row.lastTestAt?.toISOString() ?? null, lastTestOk: row.lastTestOk, lastError: row.lastError,
      jobs: { pending: count('PENDING') + count('RUNNING'), dead: count('DEAD'), succeeded: count('SUCCEEDED') },
      mappings,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
