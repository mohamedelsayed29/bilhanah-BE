import { Injectable } from '@nestjs/common';
import { localMidnight } from '../analytics/table-analytics.service.js';
import { type AdminPosHealth, type AuditEntry, type OrderChannel, type OrderPaymentMethod, POS_STATUSES, type PosReport, type PosStatus, type posReportQuerySchema } from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { PosAccessService, posStatus } from './pos-access.service.js';

/**
 * POS reports (docs/POS.md, task 7) for the restaurant, from its orders and payments: gross and net
 * sales, tax and service kept apart, what was collected and what is still owed, by channel, method
 * and cashier, and the cash shifts. And the administrators' health view across restaurants.
 */
@Injectable()
export class PosReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly access: PosAccessService,
  ) {}

  async report(userId: string, query: z.output<typeof posReportQuerySchema>): Promise<PosReport> {
    const scope = await this.scopes.resolve(userId);
    if (!scope.permissions.has('pos.settings')) this.scopes.require(scope, 'analytics.financial');
    const { restaurantId, branchId } = await this.scopes.branchWhere(scope, query.branchId);
    const filters = Prisma.sql`o.restaurant_id = ${restaurantId}::uuid AND o.business_day BETWEEN ${query.from}::date AND ${query.to}::date AND o.status NOT IN ('REJECTED', 'CANCELLED')
      ${branchId ? Prisma.sql`AND o.branch_id = ${branchId}::uuid` : Prisma.empty}
      ${query.cashierId ? Prisma.sql`AND o.created_by_id = ${query.cashierId}::uuid` : Prisma.empty}
      ${query.channel ? Prisma.sql`AND o.channel = ${query.channel}::"OrderChannel"` : Prisma.empty}`;
    type Totals = { orders: bigint; gross: bigint | null; discount: bigint | null; service: bigint | null; tax: bigint | null; billed: bigint | null; outstanding: bigint | null };
    const [totals, channels, methods, cashiers, refunds] = await Promise.all([
      this.prisma.$queryRaw<Totals[]>`
        WITH paid AS (SELECT p.order_id, SUM(p.amount_piastres - p.refunded_piastres) AS amount FROM order_payments p WHERE p.status <> 'FAILED' GROUP BY p.order_id)
        SELECT COUNT(*) AS orders, SUM(o.subtotal_piastres) AS gross, SUM(o.discount_piastres) AS discount, SUM(o.service_charge_piastres) AS service,
               SUM(o.tax_piastres) AS tax, SUM(o.total_piastres) AS billed,
               SUM(CASE WHEN o.paid_at IS NULL THEN GREATEST(0, o.total_piastres - COALESCE(paid.amount, 0)) ELSE 0 END) AS outstanding
        FROM orders o LEFT JOIN paid ON paid.order_id = o.id WHERE ${filters}`,
      this.prisma.$queryRaw<{ channel: OrderChannel; orders: bigint; net: bigint | null }[]>`
        SELECT o.channel, COUNT(*) AS orders, SUM(o.subtotal_piastres - o.discount_piastres) AS net FROM orders o WHERE ${filters} GROUP BY o.channel ORDER BY o.channel`,
      this.prisma.$queryRaw<{ method: OrderPaymentMethod; payments: bigint; collected: bigint | null }[]>`
        SELECT p.method, COUNT(*) AS payments, SUM(p.amount_piastres - p.refunded_piastres) AS collected
        FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE ${filters} AND p.status <> 'FAILED' GROUP BY p.method ORDER BY collected DESC NULLS LAST`,
      this.prisma.$queryRaw<{ cashier_id: string | null; name: string | null; orders: bigint; net: bigint | null }[]>`
        SELECT o.created_by_id AS cashier_id, MAX(o.created_by_name) AS name, COUNT(*) AS orders, SUM(o.subtotal_piastres - o.discount_piastres) AS net
        FROM orders o WHERE ${filters} AND o.channel = 'POS' GROUP BY o.created_by_id ORDER BY net DESC NULLS LAST`,
      this.prisma.$queryRaw<{ refunded: bigint | null }[]>`
        SELECT SUM(p.refunded_piastres) AS refunded FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE ${filters}`,
    ]);
    const row = totals[0]!;
    const n = (value: bigint | null | undefined) => Number(value ?? 0);
    const collected = methods.reduce((sum, method) => sum + n(method.collected), 0);
    const shifts = await this.prisma.cashShift.findMany({
      where: { restaurantId, ...(branchId && { branchId }), ...(query.cashierId && { cashierId: query.cashierId }), openedAt: { gte: localMidnight(query.from, scope.restaurant.timezone), lt: localMidnight(nextDay(query.to), scope.restaurant.timezone) } },
      orderBy: { openedAt: 'desc' }, take: 50,
    });
    const net = n(row.gross) - n(row.discount);
    return {
      from: query.from, to: query.to, orders: n(row.orders),
      grossPiastres: n(row.gross), discountPiastres: n(row.discount), netPiastres: net, serviceChargePiastres: n(row.service), taxPiastres: n(row.tax),
      billedPiastres: n(row.billed), collectedPiastres: collected, refundedPiastres: n(refunds[0]?.refunded), outstandingPiastres: n(row.outstanding),
      averageOrderPiastres: n(row.orders) ? Math.round(net / n(row.orders)) : 0,
      byChannel: channels.map((entry) => ({ channel: entry.channel, orders: n(entry.orders), netPiastres: n(entry.net) })),
      byMethod: methods.map((entry) => ({ method: entry.method, payments: n(entry.payments), collectedPiastres: n(entry.collected) })),
      byCashier: cashiers.map((entry) => ({ cashierId: entry.cashier_id, name: entry.name ?? '—', orders: n(entry.orders), netPiastres: n(entry.net) })),
      shifts: shifts.map((shift) => ({
        id: shift.id, cashierName: shift.cashierName, openedAt: shift.openedAt.toISOString(), closedAt: shift.closedAt?.toISOString() ?? null, status: shift.status,
        expectedPiastres: shift.expectedPiastres, countedPiastres: shift.countedPiastres, discrepancyPiastres: shift.discrepancyPiastres,
      })),
    };
  }

  async health(now = new Date()): Promise<AdminPosHealth> {
    const platform = await this.access.platform();
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true, status: true, posAccount: true } });
    const counts = Object.fromEntries(POS_STATUSES.map((status) => [status, 0])) as Record<PosStatus, number>;
    for (const restaurant of restaurants) counts[posStatus(platform, await this.access.planCode(restaurant), restaurant.posAccount).status] += 1;
    const [devices, integrations, jobs, succeeded, failing] = await Promise.all([
      this.prisma.posDevice.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.posIntegration.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.posSyncJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.posSyncJob.count({ where: { status: 'SUCCEEDED', completedAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
      this.prisma.posSyncJob.groupBy({ by: ['integrationId'], where: { status: 'DEAD' }, _count: { _all: true }, orderBy: { _count: { integrationId: 'desc' } }, take: 20 }),
    ]);
    const count = <T extends { _count: { _all: number } }>(rows: (T & { status: string })[], status: string) => rows.find((row) => row.status === status)?._count._all ?? 0;
    const failingRows = await this.prisma.posIntegration.findMany({ where: { id: { in: failing.map((row) => row.integrationId) } }, include: { restaurant: { select: { name: true } } } });
    return {
      restaurants: counts,
      devices: { active: count(devices, 'ACTIVE'), revoked: count(devices, 'REVOKED') },
      integrations: { active: count(integrations, 'ACTIVE'), paused: count(integrations, 'PAUSED'), disconnected: count(integrations, 'DISCONNECTED') },
      jobs: { pending: count(jobs, 'PENDING') + count(jobs, 'RUNNING'), dead: count(jobs, 'DEAD'), succeededLastDay: succeeded },
      failing: failing.map((row) => {
        const integration = failingRows.find((entry) => entry.id === row.integrationId)!;
        return { integrationId: row.integrationId, restaurantId: integration.restaurantId, restaurantName: integration.restaurant.name, name: integration.name, provider: integration.provider, dead: row._count._all, lastError: integration.lastError };
      }),
    };
  }

  /** POS entries of the audit log (activation, access, settings, devices, refunds, integrations, rejected webhooks). */
  async audit(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({ where: { action: { startsWith: 'pos.' } }, orderBy: { createdAt: 'desc' }, take: limit, include: { actor: { select: { id: true, fullName: true, email: true, role: true } } } });
    const names = new Map((await this.prisma.restaurant.findMany({ where: { id: { in: rows.map((row) => row.restaurantId).filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]));
    return rows.map((row) => ({
      id: row.id, action: row.action, targetType: row.targetType, targetId: row.targetId, metadata: row.metadata, ipAddress: row.ipAddress, createdAt: row.createdAt.toISOString(),
      actor: row.actor ? { id: row.actor.id, name: row.actor.fullName, email: row.actor.email } : null,
      scope: row.actor?.role === 'ADMIN' || !row.restaurantId ? 'platform' : 'restaurant',
      restaurant: row.restaurantId ? { id: row.restaurantId, name: names.get(row.restaurantId) ?? '—' } : null,
    }));
  }
}

/** The calendar day after `day` (YYYY-MM-DD). */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
