import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTIVE_ORDER_STATUSES,
  isOpenAt,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  ORDER_TRANSITIONS,
  type OrderStatus,
  type OpeningHours,
  type OwnerOrder,
  type Paginated,
  type placeOrderSchema,
  type PlaceOrderResponse,
  type PublicOrder,
  RESTAURANT_ERROR_CODES,
  type ordersQuerySchema,
  type updateOrderStatusSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MediaService } from '../media/media.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { businessDay } from './business-day.js';
import { TrackingTokens } from './tracking-token.js';

const orderInclude = {
  items: { orderBy: { sortOrder: 'asc' } },
  restaurant: { select: { name: true, subdomain: true, phone: true, brandColor: true, logo: true } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

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

    const access = await this.subscriptions.accessFor(restaurant, now);
    if (!hasAccess(access) || !access.features.ordering || !restaurant.orderingEnabled || restaurant.ordersPaused) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.ORDERING_UNAVAILABLE, message: 'This restaurant is not taking orders right now.' });
    }
    if ((input.type === 'DINE_IN' && !restaurant.acceptsDineIn) || (input.type === 'PICKUP' && !restaurant.acceptsPickup)) {
      throw new BadRequestException({ code: ORDER_ERROR_CODES.ORDER_TYPE_UNAVAILABLE, message: 'This restaurant does not take this kind of order.' });
    }
    const hours = restaurant.openingHours as OpeningHours | null;
    if (hours && Object.values(hours).some((ranges) => ranges.length) && !isOpenAt(hours, now, restaurant.timezone)) {
      throw new ConflictException({ code: ORDER_ERROR_CODES.RESTAURANT_CLOSED, message: 'The restaurant is closed right now.' });
    }

    let table: { id: string; label: string } | null = null;
    if (input.type === 'DINE_IN' && input.tableCode) {
      table = await this.prisma.table.findFirst({
        where: { publicCode: input.tableCode, restaurantId: restaurant.id, isActive: true },
        select: { id: true, label: true },
      });
      if (!table) throw new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'This table was not found. Scan the QR code again.' });
    }

    const lines = await this.priceLines(restaurant.id, input.items);
    const subtotalPiastres = lines.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
    const day = businessDay(now, restaurant.timezone);

    let order: OrderRow;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        const [counter] = await tx.$queryRaw<{ last_number: number }[]>`
          INSERT INTO order_counters (restaurant_id, business_day, last_number)
          VALUES (${restaurant.id}::uuid, ${day}::date, 1)
          ON CONFLICT (restaurant_id, business_day) DO UPDATE SET last_number = order_counters.last_number + 1
          RETURNING last_number`;
        return tx.order.create({
          data: {
            restaurantId: restaurant.id,
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
    return this.toPublicOrder(order);
  }

  // --- Restaurants ---------------------------------------------------------

  async list(ownerId: string, query: z.output<typeof ordersQuerySchema>): Promise<Paginated<OwnerOrder>> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const active = query.view === 'active';
    const where: Prisma.OrderWhereInput = {
      restaurantId,
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

  async get(ownerId: string, orderId: string): Promise<OwnerOrder> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId }, include: orderInclude });
    if (!order) throw orderNotFound();
    return this.toOwnerOrder(order);
  }

  /** Moves an order along; only the transitions in ORDER_TRANSITIONS are allowed. */
  async updateStatus(ownerId: string, orderId: string, input: z.output<typeof updateOrderStatusSchema>): Promise<OwnerOrder> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const current = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId }, select: { status: true } });
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
    // Compare-and-swap on the status, so two devices cannot both move the same order.
    const changed = await this.prisma.order.updateMany({
      where: { id: orderId, restaurantId, status: current.status },
      data: {
        status: input.status,
        ...(timestamp && { [timestamp]: now }),
        ...(closing && { rejectionReason: input.reason ?? null }),
      },
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
    return ownerView;
  }

  // --- Helpers -------------------------------------------------------------

  /** Current names and prices for the ordered dishes; rejects dishes that are sold out, hidden or gone. */
  private async priceLines(restaurantId: string, items: z.output<typeof placeOrderSchema>['items']) {
    const menuItems = await this.prisma.menuItem.findMany({
      where: {
        id: { in: [...new Set(items.map((item) => item.menuItemId))] },
        restaurantId,
        isVisible: true,
        isAvailable: true,
        category: { isVisible: true },
      },
      include: { variants: true },
    });
    const byId = new Map(menuItems.map((item) => [item.id, item]));
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
    return lines;
  }

  private async restaurantIdFor(ownerId: string): Promise<string> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true } });
    if (!restaurant) throw restaurantNotFound();
    return restaurant.id;
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
      })),
      placedAt: order.placedAt.toISOString(),
      acceptedAt: order.acceptedAt?.toISOString() ?? null,
      readyAt: order.readyAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      closedAt: order.closedAt?.toISOString() ?? null,
      rejectionReason: order.rejectionReason,
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  private toOwnerOrder(order: OrderRow): OwnerOrder {
    return { id: order.id, customerPhone: order.customerPhone, ...this.core(order) };
  }

  private toPublicOrder(order: OrderRow): PublicOrder {
    return {
      ...this.core(order),
      restaurant: {
        name: order.restaurant.name,
        subdomain: order.restaurant.subdomain,
        phone: order.restaurant.phone,
        brandColor: order.restaurant.brandColor,
        logo: order.restaurant.logo ? this.media.toImageSet(order.restaurant.logo) : null,
      },
    };
  }
}
