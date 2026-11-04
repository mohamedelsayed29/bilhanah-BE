import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTIVE_ORDER_STATUSES,
  isOpenAt,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  ORDER_TRANSITIONS,
  ORDER_STATUS_PERMISSION as STATUS_PERMISSION,
  KITCHEN_DISPLAY_ERROR_CODES,
  ORDER_ITEM_STATUS_PERMISSION,
  ORDER_ITEM_TRANSITIONS,
  type OrderItemEvent,
  type OrderItemStatus,
  type OrderPriority,
  type updateOrderItemsStatusSchema,
  type OrderStatus,
  type OpeningHours,
  type OrderTrackingStats,
  type OwnerOrder,
  type Paginated,
  type placeOrderSchema,
  type PlaceOrderResponse,
  type PublicOrder,
  RESTAURANT_ERROR_CODES,
  TABLE_OCCUPANCY_HOURS,
  TABLE_RESERVED_WINDOW,
  UPCOMING_RESERVATION_STATUSES,
  type TableOccupancy,
  type ordersQuerySchema,
  type trackingStatsQuerySchema,
  type updateOrderStatusSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MediaService } from '../media/media.service.js';
import { effectiveItem } from '../branches/branch-menu.js';
import { BranchScopeService, branchNotFound } from '../branches/branch-scope.service.js';
import { MenusService } from '../menus/menus.service.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import { KitchenStationsService } from '../kitchen-display/kitchen-stations.service.js';
import { forwardSteps, itemCascade, itemTimestamps, orderTargetFromItems } from './order-items.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { businessDay } from './business-day.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { TrackingTokens } from './tracking-token.js';

const orderInclude = {
  items: { orderBy: { sortOrder: 'asc' } },
  restaurant: { select: { name: true, subdomain: true, phone: true, brandColor: true, logo: true } },
  branch: { select: { id: true, name: true, slug: true, phone: true, city: true, address: true, mapUrl: true, isMain: true } },
  statusEvents: { orderBy: { createdAt: 'asc' }, select: { status: true, createdAt: true, reason: true, actorName: true } },
  _count: { select: { pushSubscriptions: true } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** Rejected and cancelled orders have no bill, so they never keep a table occupied. */
const UNBILLED_STATUSES: OrderStatus[] = ['REJECTED', 'CANCELLED'];

const orderNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.ORDER_NOT_FOUND, message: 'Order not found.' });
const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

/** Timestamps recorded when an order enters each status. */
const STATUS_TIMESTAMP: Partial<Record<OrderStatus, 'acceptedAt' | 'readyAt' | 'completedAt' | 'closedAt'>> = {
  ACCEPTED: 'acceptedAt',
  READY: 'readyAt',
  COMPLETED: 'completedAt',
  REJECTED: 'closedAt',
  CANCELLED: 'closedAt',
};

/**
 * Orders from diners' phones, and the restaurant's handling of them. Prices
 * and names are taken from the menu at placement and copied onto the order.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
    private readonly trackingTokens: TrackingTokens,
    private readonly alerts: OrderAlertsService,
    private readonly scopes: BranchScopeService,
    private readonly menus: MenusService,
    private readonly recommendations: RecommendationsService,
    private readonly stations: KitchenStationsService,
  ) {}

  // --- Diners --------------------------------------------------------------

  async place(
    rawSubdomain: string,
    idempotencyKey: string,
    input: z.output<typeof placeOrderSchema>,
    now = new Date(),
  ): Promise<PlaceOrderResponse> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain: normalizeSubdomain(rawSubdomain) } });
    if (!restaurant) throw restaurantNotFound();

    // A retried submission (same key) returns the order it already created.
    const existing = await this.prisma.order.findUnique({
      where: { restaurantId_idempotencyKey: { restaurantId: restaurant.id, idempotencyKey } },
      include: orderInclude,
    });
    if (existing) return this.placed(existing);

    // A table QR code decides the branch; otherwise the chosen branch, or the main one.
    let table: { id: string; label: string; branchId: string } | null = null;
    if (input.type === 'DINE_IN' && input.tableCode) {
      table = await this.prisma.table.findFirst({
        where: { publicCode: input.tableCode, restaurantId: restaurant.id, isActive: true },
        select: { id: true, label: true, branchId: true },
      });
      if (!table) throw new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'This table was not found. Scan the QR code again.' });
    }
    const branch = await this.prisma.branch.findFirst({
      where: {
        restaurantId: restaurant.id,
        isActive: true,
        ...(table ? { id: table.branchId } : input.branch ? { slug: input.branch } : { isMain: true }),
      },
    });
    if (!branch) throw branchNotFound();

    const access = await this.subscriptions.accessFor(restaurant, now);
    if (!hasAccess(access) || !access.features.ordering || !branch.orderingEnabled || branch.ordersPaused) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.ORDERING_UNAVAILABLE, message: 'This branch is not taking orders right now.' });
    }
    if ((input.type === 'DINE_IN' && !branch.acceptsDineIn) || (input.type === 'PICKUP' && !branch.acceptsPickup)) {
      throw new BadRequestException({ code: ORDER_ERROR_CODES.ORDER_TYPE_UNAVAILABLE, message: 'This branch does not take this kind of order.' });
    }
    const hours = branch.openingHours as OpeningHours | null;
    if (hours && Object.values(hours).some((ranges) => ranges.length) && !isOpenAt(hours, now, restaurant.timezone)) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.RESTAURANT_CLOSED, message: 'This branch is closed right now.' });
    }

    const lines = await this.priceLines(restaurant.id, branch.id, input.items);
    const subtotalPiastres = lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
    const day = businessDay(now, restaurant.timezone);

    let order: OrderRow;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        const [counter] = await tx.$queryRaw<{ last_number: number }[]>`
          INSERT INTO order_counters (branch_id, business_day, last_number)
          VALUES (${branch.id}::uuid, ${day}::date, 1)
          ON CONFLICT (branch_id, business_day) DO UPDATE SET last_number = order_counters.last_number + 1
          RETURNING last_number`;
        return tx.order.create({
          data: {
            restaurantId: restaurant.id,
            branchId: branch.id,
            number: counter!.last_number,
            businessDay: day,
            type: input.type,
            tableId: table?.id ?? null,
            tableLabel: input.type === 'DINE_IN' ? (table?.label ?? input.tableLabel ?? null) : null,
            customerName: input.customerName,
            customerPhone: input.customerPhone ?? null,
            note: input.note ?? null,
            subtotalPiastres,
            idempotencyKey,
            placedAt: now,
            items: { create: lines.map((line, sortOrder) => ({ ...line, sortOrder })) },
            statusEvents: { create: { status: 'PLACED', createdAt: now } },
          },
          include: orderInclude,
        });
      });
    } catch (error) {
      // Two concurrent submissions with the same key: return the one that won.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.prisma.order.findUnique({
        where: { restaurantId_idempotencyKey: { restaurantId: restaurant.id, idempotencyKey } },
        include: orderInclude,
      });
      if (!winner) throw error;
      return this.placed(winner);
    }

    this.realtime.emitOrderCreated(restaurant.id, this.toOwnerOrder(order));
    return this.placed(order);
  }

  async track(token: string): Promise<PublicOrder> {
    const orderId = this.trackingTokens.verify(token);
    const order = orderId ? await this.prisma.order.findUnique({ where: { id: orderId }, include: orderInclude }) : null;
    if (!order) throw orderNotFound();
    // Tracking usage: the first time the diner opens the page. Never fails the page.
    if (!order.trackedAt) void this.prisma.order.updateMany({ where: { id: order.id, trackedAt: null }, data: { trackedAt: new Date() } }).catch(() => undefined);
    return this.toPublicOrder(order);
  }

  // --- Restaurants ---------------------------------------------------------

  async list(userId: string, query: z.output<typeof ordersQuerySchema>): Promise<Paginated<OwnerOrder>> {
    const scope = await this.scopes.resolve(userId);
    const active = query.view === 'active';
    const where: Prisma.OrderWhereInput = {
      ...(await this.scopes.branchWhere(scope, query.branchId)),
      status: active ? { in: [...ACTIVE_ORDER_STATUSES] } : { notIn: [...ACTIVE_ORDER_STATUSES] },
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: orderInclude,
        // The board is worked oldest first; history reads newest first.
        orderBy: { placedAt: active ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: items.map((order) => this.toOwnerOrder(order)), total, page: query.page, pageSize: query.pageSize };
  }

  async get(userId: string, orderId: string): Promise<OwnerOrder> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, ...(await this.ownWhere(userId)) }, include: orderInclude });
    if (!order) throw orderNotFound();
    return this.toOwnerOrder(order);
  }

  /** Moves an order along; only the transitions in ORDER_TRANSITIONS are allowed. */
  async updateStatus(userId: string, orderId: string, input: z.output<typeof updateOrderStatusSchema>): Promise<OwnerOrder> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, STATUS_PERMISSION[input.status]);
    const own = await this.scopes.branchWhere(scope);
    const restaurantId = own.restaurantId;
    const current = await this.prisma.order.findFirst({
      where: { id: orderId, ...own },
      select: { status: true, restaurant: { select: { orderPrepMinutes: true } } },
    });
    if (!current) throw orderNotFound();
    const allowed = ORDER_TRANSITIONS[current.status];
    if (!allowed.includes(input.status)) {
      throw new ConflictException({
        code: ORDER_ERROR_CODES.INVALID_STATUS_CHANGE,
        message: `An order that is ${current.status.toLowerCase()} cannot become ${input.status.toLowerCase()}.`,
        details: { from: current.status, to: input.status, allowed },
      });
    }

    const now = new Date();
    const timestamp = STATUS_TIMESTAMP[input.status];
    const closing = input.status === 'REJECTED' || input.status === 'CANCELLED';
    // Accepting uses the restaurant's usual time unless the staff gave one; preparing may revise it.
    const prepMinutes = input.prepMinutes ?? (input.status === 'ACCEPTED' ? current.restaurant.orderPrepMinutes : null);
    const actor = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    // Compare-and-swap on the status, so two devices cannot both move the same order.
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: orderId, restaurantId, status: current.status },
        data: {
          status: input.status,
          ...(timestamp && { [timestamp]: now }),
          ...(closing && { rejectionReason: input.reason ?? null }),
          ...(prepMinutes && { estimatedReadyAt: new Date(now.getTime() + prepMinutes * 60_000) }),
        },
      });
      if (result.count === 1) {
        await tx.orderStatusEvent.create({
          data: { orderId, status: input.status, actorId: userId, actorName: actor?.fullName ?? null, reason: closing ? (input.reason ?? null) : null, createdAt: now },
        });
        // The dishes follow the order (accepting accepts them, ready makes them ready...).
        await this.cascadeItems(tx, orderId, input.status, { id: userId, name: actor?.fullName ?? null }, now);
      }
      return result;
    });
    if (changed.count !== 1) {
      throw new ConflictException({
        code: ORDER_ERROR_CODES.INVALID_STATUS_CHANGE,
        message: 'This order was just updated on another device.',
        details: { from: current.status, to: input.status, allowed },
      });
    }

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    const ownerView = this.toOwnerOrder(order);
    this.realtime.emitOrderUpdated(restaurantId, ownerView, this.toPublicOrder(order));
    await this.alerts.queueStatus(orderId, input.status);
    return ownerView;
  }

  // --- Kitchen display ---------------------------------------------------------

  /**
   * Moves dishes of one order to a step (a station bumping its part, or one dish). Dishes already
   * there are left alone, so a repeated request changes nothing; any other dish must be allowed to
   * make the move. The order then follows its dishes (see orderTargetFromItems), and everyone's
   * screens and the diner hear about it once.
   */
  async updateItems(userId: string, orderId: string, input: z.output<typeof updateOrderItemsStatusSchema>, now = new Date()): Promise<OwnerOrder> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, ORDER_ITEM_STATUS_PERMISSION[input.status]);
    const own = await this.scopes.branchWhere(scope);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...own },
      select: { status: true, restaurantId: true, restaurant: { select: { kitchenReadyRule: true, orderPrepMinutes: true } }, items: { select: { id: true, prepStatus: true } } },
    });
    if (!order) throw orderNotFound();
    const invalid = (itemId: string, from: OrderItemStatus | null, message: string) => new ConflictException({
      code: KITCHEN_DISPLAY_ERROR_CODES.INVALID_ITEM_STATUS_CHANGE,
      message,
      details: { itemId, from, to: input.status, allowed: from ? ORDER_ITEM_TRANSITIONS[from] : [] },
    });
    if (!ACTIVE_ORDER_STATUSES.includes(order.status as (typeof ACTIVE_ORDER_STATUSES)[number])) {
      throw invalid(input.itemIds[0]!, null, 'This order is closed.');
    }
    const changes: { id: string; from: OrderItemStatus }[] = [];
    for (const itemId of input.itemIds) {
      const item = order.items.find((entry) => entry.id === itemId);
      if (!item) throw new NotFoundException({ code: KITCHEN_DISPLAY_ERROR_CODES.ORDER_ITEM_NOT_FOUND, message: 'This dish is not part of the order.' });
      if (item.prepStatus === input.status) continue;
      if (!ORDER_ITEM_TRANSITIONS[item.prepStatus].includes(input.status)) {
        throw invalid(itemId, item.prepStatus, `A ${item.prepStatus.toLowerCase()} dish cannot become ${input.status.toLowerCase()}.`);
      }
      // A dish goes back to the stove only while the order is not out yet.
      if (item.prepStatus === 'READY' && input.status === 'PREPARING' && order.status === 'READY') {
        throw invalid(itemId, item.prepStatus, 'The order is already ready; it cannot take a dish back.');
      }
      changes.push({ id: itemId, from: item.prepStatus });
    }
    if (!changes.length) return this.get(userId, orderId);

    const actor = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    const steps = await this.prisma.$transaction(async (tx) => {
      for (const change of changes) {
        // Compare-and-swap per dish: two screens cannot both move it.
        const moved = await tx.orderItem.updateMany({
          where: { id: change.id, orderId, prepStatus: change.from },
          data: { prepStatus: input.status, ...itemTimestamps(input.status, now, change.from), ...(input.status === 'PREPARING' && change.from === 'NEW' && { acceptedAt: now }) },
        });
        if (moved.count !== 1) throw invalid(change.id, change.from, 'This dish was just updated on another screen.');
      }
      await tx.orderItemEvent.createMany({
        data: changes.map((change) => ({ orderId, orderItemId: change.id, status: input.status, actorId: userId, actorName: actor?.fullName ?? null, createdAt: now })),
      });
      const items = await tx.orderItem.findMany({ where: { orderId }, select: { prepStatus: true } });
      const target = orderTargetFromItems(items.map((item) => item.prepStatus), order.restaurant.kitchenReadyRule, order.status);
      const path = forwardSteps(order.status, target);
      let previous = order.status;
      for (const step of path) {
        const timestamp = STATUS_TIMESTAMP[step];
        const prepMinutes = step === 'ACCEPTED' ? order.restaurant.orderPrepMinutes : null;
        const result = await tx.order.updateMany({
          where: { id: orderId, status: previous },
          data: { status: step, ...(timestamp && { [timestamp]: now }), ...(prepMinutes && { estimatedReadyAt: new Date(now.getTime() + prepMinutes * 60_000) }) },
        });
        if (result.count !== 1) throw invalid(changes[0]!.id, changes[0]!.from, 'This order was just updated on another screen.');
        await tx.orderStatusEvent.create({ data: { orderId, status: step, actorId: userId, actorName: actor?.fullName ?? null, createdAt: now } });
        previous = step;
      }
      // Serving the last dishes completes the order: anything still waiting is served with it.
      if (previous === 'COMPLETED') await this.cascadeItems(tx, orderId, 'COMPLETED', { id: userId, name: actor?.fullName ?? null }, now);
      return path;
    });

    const full = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    const ownerView = this.toOwnerOrder(full);
    this.realtime.emitOrderUpdated(order.restaurantId, ownerView, this.toPublicOrder(full));
    for (const step of steps) await this.alerts.queueStatus(orderId, step);
    return ownerView;
  }

  /** Rush orders go first on every kitchen screen. */
  async setPriority(userId: string, orderId: string, priority: OrderPriority): Promise<OwnerOrder> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'orders.update');
    const own = await this.scopes.branchWhere(scope);
    const updated = await this.prisma.order.updateMany({ where: { id: orderId, ...own }, data: { priority } });
    if (!updated.count) throw orderNotFound();
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    const ownerView = this.toOwnerOrder(order);
    this.realtime.emitOrderUpdated(order.restaurantId, ownerView, this.toPublicOrder(order));
    return ownerView;
  }

  /** Every preparation step of the order's dishes, oldest first. */
  async itemHistory(userId: string, orderId: string): Promise<OrderItemEvent[]> {
    const own = await this.ownWhere(userId);
    const order = await this.prisma.order.findFirst({ where: { id: orderId, ...own }, select: { id: true } });
    if (!order) throw orderNotFound();
    const events = await this.prisma.orderItemEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    return events.map((event) => ({ itemId: event.orderItemId, status: event.status, actorName: event.actorName, at: event.createdAt.toISOString() }));
  }

  /** Moves the dishes along with an order's own status change, recording each move. */
  private async cascadeItems(tx: Prisma.TransactionClient, orderId: string, status: OrderStatus, actor: { id: string; name: string | null }, now: Date): Promise<void> {
    const cascade = itemCascade(status);
    if (!cascade) return;
    const items = await tx.orderItem.findMany({ where: { orderId, prepStatus: { in: cascade.from } }, select: { id: true, prepStatus: true } });
    if (!items.length) return;
    for (const from of new Set(items.map((item) => item.prepStatus))) {
      await tx.orderItem.updateMany({
        where: { orderId, prepStatus: from },
        data: {
          prepStatus: cascade.to,
          ...itemTimestamps(cascade.to, now, from),
          // Skipped steps still get a time, so preparation times stay measurable.
          ...(from === 'NEW' && cascade.to !== 'CANCELLED' && cascade.to !== 'ACCEPTED' && { acceptedAt: now }),
        },
      });
    }
    await tx.orderItemEvent.createMany({
      data: items.map((item) => ({ orderId, orderItemId: item.id, status: cascade.to, actorId: actor.id, actorName: actor.name, createdAt: now })),
    });
  }

  /** How diners followed their orders over the period (see OrderTrackingStats). */
  async trackingStats(userId: string, query: z.output<typeof trackingStatsQuerySchema>, now = new Date()): Promise<OrderTrackingStats> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 86_400_000);
    const branch = where.branchId ? Prisma.sql`AND o.branch_id = ${where.branchId}::uuid` : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<{
      orders: bigint; tracked: bigint; alertOrders: bigint; notified: bigint; estimated: bigint; onTime: bigint;
    }[]>`
      SELECT COUNT(*) AS orders,
        COUNT(*) FILTER (WHERE o.tracked_at IS NOT NULL) AS tracked,
        COUNT(*) FILTER (WHERE o.ready_at IS NOT NULL AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.order_id = o.id) OR o.ready_notified_at IS NOT NULL) AS "alertOrders",
        COUNT(*) FILTER (WHERE o.ready_notified_at IS NOT NULL) AS notified,
        COUNT(*) FILTER (WHERE o.estimated_ready_at IS NOT NULL AND o.ready_at IS NOT NULL) AS estimated,
        COUNT(*) FILTER (WHERE o.estimated_ready_at IS NOT NULL AND o.ready_at <= o.estimated_ready_at) AS "onTime"
      FROM orders o
      WHERE o.restaurant_id = ${where.restaurantId}::uuid ${branch} AND o.placed_at >= ${since}
        AND o.status NOT IN ('REJECTED', 'CANCELLED')`;
    // A service request from a table that had an order on its way at that moment.
    const [enquiries] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM service_requests s
      WHERE s.restaurant_id = ${where.restaurantId}::uuid ${where.branchId ? Prisma.sql`AND s.branch_id = ${where.branchId}::uuid` : Prisma.empty}
        AND s.created_at >= ${since} AND s.table_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM orders o WHERE o.table_id = s.table_id AND o.placed_at <= s.created_at
            AND COALESCE(o.ready_at, o.closed_at, o.completed_at, 'infinity'::timestamptz) > s.created_at
        )`;
    const count = (value: bigint | undefined) => Number(value ?? 0);
    const rate = (part: number, whole: number) => (whole ? part / whole : null);
    const orders = count(row?.orders);
    const tracked = count(row?.tracked);
    const readyAlertOrders = count(row?.alertOrders);
    const readyNotified = count(row?.notified);
    const estimatedOrders = count(row?.estimated);
    const readyOnTime = count(row?.onTime);
    return {
      days: query.days,
      orders,
      tracked,
      trackingRate: rate(tracked, orders),
      readyAlertOrders,
      readyNotified,
      readyDeliveryRate: rate(readyNotified, readyAlertOrders),
      estimatedOrders,
      readyOnTime,
      onTimeRate: rate(readyOnTime, estimatedOrders),
      statusEnquiries: count(enquiries?.count),
    };
  }

  /** Marks the bill paid or, to undo a mistake, unpaid. */
  async setPaid(userId: string, orderId: string, paid: boolean): Promise<OwnerOrder> {
    const scope = await this.scopes.resolve(userId);
    // Marking a paid bill unpaid again reverses a payment: a refund.
    this.scopes.require(scope, paid ? 'payments.process' : 'payments.refund');
    const own = await this.scopes.branchWhere(scope);
    const restaurantId = own.restaurantId;
    const current = await this.prisma.order.findFirst({ where: { id: orderId, ...own }, select: { status: true, paidAt: true } });
    if (!current) throw orderNotFound();
    if (paid && UNBILLED_STATUSES.includes(current.status)) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.ORDER_NOT_PAYABLE, message: 'A rejected or cancelled order has nothing to pay.' });
    }
    if (paid === Boolean(current.paidAt)) return this.get(userId, orderId);
    const order = await this.prisma.order.update({ where: { id: orderId }, data: { paidAt: paid ? new Date() : null }, include: orderInclude });
    const ownerView = this.toOwnerOrder(order);
    this.realtime.emitOrderUpdated(restaurantId, ownerView, this.toPublicOrder(order));
    return ownerView;
  }

  /** Every active table and the unpaid orders keeping it occupied. */
  /** One branch's floor: the requested one, the staff account's, or the main branch. */
  async floor(userId: string, branchId?: string, now = new Date()): Promise<TableOccupancy[]> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, branchId);
    const [tables, open, bookings] = await Promise.all([
      this.prisma.table.findMany({ where: { branchId: branch.id, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, label: true, shape: true, seats: true, location: true, areaId: true } }),
      this.prisma.order.findMany({
        where: this.openOnTableWhere(branch.id, now),
        orderBy: { placedAt: 'asc' },
        select: { id: true, number: true, status: true, subtotalPiastres: true, placedAt: true, tableId: true, tableLabel: true },
      }),
      // Bookings holding a table now: from TABLE_RESERVED_WINDOW.beforeMinutes before their time until afterMinutes after.
      this.prisma.reservation.findMany({
        where: {
          branchId: branch.id,
          tableId: { not: null },
          status: { in: [...UPCOMING_RESERVATION_STATUSES] },
          reservedAt: {
            gte: new Date(now.getTime() - TABLE_RESERVED_WINDOW.afterMinutes * 60_000),
            lte: new Date(now.getTime() + TABLE_RESERVED_WINDOW.beforeMinutes * 60_000),
          },
        },
        orderBy: { reservedAt: 'asc' },
        select: { id: true, tableId: true, customerName: true, reservedAt: true, guests: true },
      }),
    ]);
    return tables.map((table) => {
      const booking = bookings.find((entry) => entry.tableId === table.id);
      // Orders typed in by hand ("Table 5") carry only the label.
      const orders = open.filter((order) => (order.tableId ? order.tableId === table.id : order.tableLabel === table.label));
      return {
        id: table.id,
        label: table.label,
        shape: table.shape,
        seats: table.seats,
        location: table.location,
        areaId: table.areaId,
        occupied: orders.length > 0,
        reservation: booking && orders.length === 0
          ? { id: booking.id, customerName: booking.customerName, reservedAt: booking.reservedAt.toISOString(), guests: booking.guests }
          : null,
        openOrders: orders.map((order) => ({
          id: order.id,
          number: order.number,
          status: order.status,
          subtotalPiastres: order.subtotalPiastres,
          placedAt: order.placedAt.toISOString(),
        })),
        unpaidPiastres: orders.reduce((sum, order) => sum + order.subtotalPiastres, 0),
        since: orders[0]?.placedAt.toISOString() ?? null,
      };
    });
  }

  /** The guests paid and left: marks every open order on the table paid, freeing it. */
  async settleTable(userId: string, tableId: string, now = new Date()): Promise<TableOccupancy[]> {
    const own = await this.ownWhere(userId);
    const restaurantId = own.restaurantId;
    const table = await this.prisma.table.findFirst({ where: { id: tableId, ...own }, select: { id: true, label: true, branchId: true } });
    if (!table) throw new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'Table not found.' });
    const where: Prisma.OrderWhereInput = {
      ...this.openOnTableWhere(table.branchId, now),
      OR: [{ tableId: table.id }, { tableId: null, tableLabel: table.label }],
    };
    const ids = (await this.prisma.order.findMany({ where, select: { id: true } })).map((order) => order.id);
    if (ids.length) {
      await this.prisma.order.updateMany({ where: { id: { in: ids }, paidAt: null }, data: { paidAt: now } });
      const orders = await this.prisma.order.findMany({ where: { id: { in: ids } }, include: orderInclude });
      for (const order of orders) this.realtime.emitOrderUpdated(restaurantId, this.toOwnerOrder(order), this.toPublicOrder(order));
    }
    // The guests have left: their table session (and its service requests' context) ends with the bill.
    await this.prisma.tableSession.updateMany({ where: { tableId: table.id, endedAt: null }, data: { endedAt: now } });
    return this.floor(userId, table.branchId, now);
  }

  /** Something about the order changed without a status change (a diner turned alerts on or off): bump it and tell the board. */
  async touch(orderId: string): Promise<void> {
    const order = await this.prisma.order.update({ where: { id: orderId }, data: { updatedAt: new Date() }, include: orderInclude });
    this.realtime.emitOrderUpdated(order.restaurantId, this.toOwnerOrder(order), this.toPublicOrder(order));
  }

  // --- Helpers -------------------------------------------------------------

  /** Current names and prices for the ordered dishes; rejects dishes that are sold out, hidden or gone. */
  /** Current names and the branch's prices; rejects dishes sold out or hidden (shared or at this branch) or gone. */
  private async priceLines(restaurantId: string, branchId: string, items: z.output<typeof placeOrderSchema>['items']) {
    const [menuItems, overrides] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: {
          id: { in: [...new Set(items.map((item) => item.menuItemId))] },
          restaurantId,
          isVisible: true,
          category: { isVisible: true },
        },
        include: { variants: true, category: { select: { stationId: true } } },
      }),
      this.menus.branchOverrides(branchId),
    ]);
    // Each dish goes to its kitchen station (its own, its category's, or the default).
    const route = await this.stations.router(restaurantId);
    const byId = new Map(
      menuItems.flatMap((item) => {
        const effective = effectiveItem(item, overrides);
        return effective.visible && effective.available ? [[item.id, { ...item, variants: item.variants.map((variant, index) => ({ ...variant, pricePiastres: effective.variants[index]!.pricePiastres })) }] as const] : [];
      }),
    );
    const unavailable = new Set<string>();
    const lines = items.flatMap((line) => {
      const menuItem = byId.get(line.menuItemId);
      const variant = menuItem?.variants.find((candidate) => candidate.id === line.variantId);
      if (!menuItem || !variant) {
        unavailable.add(line.menuItemId);
        return [];
      }
      return [
        {
          menuItemId: menuItem.id,
          nameAr: menuItem.nameAr,
          nameEn: menuItem.nameEn,
          // A single unnamed price has no size to show.
          variantNameAr: menuItem.variants.length > 1 ? variant.nameAr : null,
          variantNameEn: menuItem.variants.length > 1 ? variant.nameEn : null,
          unitPricePiastres: variant.pricePiastres,
          quantity: line.quantity,
          note: line.note ?? null,
          stationId: route(menuItem)?.id ?? null,
          stationName: route(menuItem)?.name ?? null,
        },
      ];
    });
    if (unavailable.size) {
      throw new ConflictException({
        code: ORDER_ERROR_CODES.ITEMS_UNAVAILABLE,
        message: 'Some dishes are no longer available.',
        details: { menuItemIds: [...unavailable] },
      });
    }
    // Lines added from a suggestion keep it when it checks out (for conversion and revenue); otherwise it is dropped.
    const attribution = await this.recommendations.attribute(restaurantId, items);
    return lines.map((line, index) => ({ ...line, ...(attribution[index] ?? {}) }));
  }

  /** Dine-in orders still on the bill: unpaid, not rejected or cancelled, and recent enough to count. */
  private openOnTableWhere(branchId: string, now: Date): Prisma.OrderWhereInput {
    return {
      branchId,
      type: 'DINE_IN',
      paidAt: null,
      status: { notIn: UNBILLED_STATUSES },
      placedAt: { gte: new Date(now.getTime() - TABLE_OCCUPANCY_HOURS * 60 * 60 * 1000) },
    };
  }

  /** Orders the caller may touch: their restaurant's, and only their branch's when tied to one. */
  private async ownWhere(userId: string): Promise<{ restaurantId: string; branchId?: string }> {
    return this.scopes.branchWhere(await this.scopes.resolve(userId));
  }

  private placed(order: OrderRow): PlaceOrderResponse {
    return { trackingToken: this.trackingTokens.issue(order.id), order: this.toPublicOrder(order) };
  }

  private core(order: OrderRow) {
    return {
      number: order.number,
      type: order.type,
      tableLabel: order.tableLabel,
      customerName: order.customerName,
      status: order.status,
      subtotalPiastres: order.subtotalPiastres,
      note: order.note,
      items: order.items.map((item) => ({
        id: item.id,
        menuItemId: item.menuItemId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        variantNameAr: item.variantNameAr,
        variantNameEn: item.variantNameEn,
        unitPricePiastres: item.unitPricePiastres,
        quantity: item.quantity,
        note: item.note,
        lineTotalPiastres: item.unitPricePiastres * item.quantity,
        stationId: item.stationId,
        stationName: item.stationName,
        prepStatus: item.prepStatus,
        startedAt: item.startedAt?.toISOString() ?? null,
        readyAt: item.readyAt?.toISOString() ?? null,
      })),
      placedAt: order.placedAt.toISOString(),
      acceptedAt: order.acceptedAt?.toISOString() ?? null,
      readyAt: order.readyAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      closedAt: order.closedAt?.toISOString() ?? null,
      rejectionReason: order.rejectionReason,
      paidAt: order.paidAt?.toISOString() ?? null,
      estimatedReadyAt: order.estimatedReadyAt?.toISOString() ?? null,
      history: order.statusEvents.map((event) => ({ status: event.status, at: event.createdAt.toISOString(), reason: event.reason })),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  private toOwnerOrder(order: OrderRow): OwnerOrder {
    return {
      id: order.id,
      branchId: order.branch.id,
      branchName: order.branch.name,
      customerPhone: order.customerPhone,
      notifiesDiner: order._count.pushSubscriptions > 0,
      priority: order.priority,
      ...this.core(order),
      history: order.statusEvents.map((event) => ({ status: event.status, at: event.createdAt.toISOString(), reason: event.reason, actorName: event.actorName })),
    };
  }

  private toPublicOrder(order: OrderRow): PublicOrder {
    return {
      ...this.core(order),
      restaurant: {
        name: order.restaurant.name,
        subdomain: order.restaurant.subdomain,
        // Diners call the branch that has their order.
        phone: order.branch.phone,
        brandColor: order.restaurant.brandColor,
        logo: order.restaurant.logo ? this.media.toImageSet(order.restaurant.logo) : null,
      },
      branch: {
        slug: order.branch.slug,
        name: order.branch.name,
        phone: order.branch.phone,
        city: order.branch.city,
        address: order.branch.address,
        mapUrl: order.branch.mapUrl,
        isMain: order.branch.isMain,
      },
    };
  }
}
