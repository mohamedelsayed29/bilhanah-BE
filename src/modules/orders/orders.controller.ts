import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  branchQuerySchema,
  idempotencyKeySchema,
  type OrderAlerts,
  orderIdParamSchema,
  ordersQuerySchema,
  type OrderTrackingStats,
  trackingStatsQuerySchema,
  type OwnerOrder,
  type Paginated,
  type TableOccupancy,
  updateOrderPaymentSchema,
  settleTableSchema,
  placeOrderSchema,
  type PlaceOrderResponse,
  type PublicOrder,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  updateOrderStatusSchema,
  type OrderItemEvent,
  updateOrderItemsStatusSchema,
  updateOrderPrioritySchema,
} from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { OrdersService } from './orders.service.js';

/**
 * The restaurant's orders: the live board, history, and status changes. Owners see every branch;
 * staff tied to a branch see only its orders. Each route needs a permission (see permissions.ts);
 * which status change or payment change the caller may make is checked in the service.
 */
@Controller('orders')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('orders.view')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(ordersQuerySchema)) query: z.output<typeof ordersQuerySchema>): Promise<Paginated<OwnerOrder>> {
    return this.orders.list(auth.userId, query);
  }

  /** Which tables have guests (an unpaid order) right now. Declared before :id. */
  @Get('floor')
  @RequirePermission('tables.view')
  @Header('Cache-Control', 'no-store')
  floor(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(branchQuerySchema)) query: z.output<typeof branchQuerySchema>): Promise<TableOccupancy[]> {
    return this.orders.floor(auth.userId, query.branchId);
  }

  /** Tracking usage, ready-notification delivery and status enquiries. Declared before :id. */
  @Get('tracking-stats')
  @RequirePermission('analytics.view')
  @Header('Cache-Control', 'no-store')
  trackingStats(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(trackingStatsQuerySchema)) query: z.output<typeof trackingStatsQuerySchema>,
  ): Promise<OrderTrackingStats> {
    return this.orders.trackingStats(auth.userId, query);
  }

  /** The guests at this table paid: marks its open orders paid. Returns the whole floor. */
  @Post('tables/:tableId/settle')
  @RequirePermission('payments.process')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  settleTable(
    @CurrentAuth() auth: AuthContext,
    @Param('tableId', new ZodValidationPipe(orderIdParamSchema)) tableId: string,
    @Body(new ZodValidationPipe(settleTableSchema)) body: z.output<typeof settleTableSchema>,
  ): Promise<TableOccupancy[]> {
    return this.orders.settleTable(auth.userId, tableId, body.method);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string): Promise<OwnerOrder> {
    return this.orders.get(auth.userId, id);
  }

  /** orders.update to accept, prepare and mark ready; orders.complete to hand over; orders.cancel to reject or cancel. */
  @RequireAnyPermission('orders.update', 'orders.complete', 'orders.cancel')
  @Patch(':id/status')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderStatusSchema)) body: z.output<typeof updateOrderStatusSchema>,
  ): Promise<OwnerOrder> {
    return this.orders.updateStatus(auth.userId, id, body);
  }

  /** The kitchen display moves dishes: orders.update to start and finish them, orders.complete to serve, orders.cancel to cancel. */
  @RequireAnyPermission('orders.update', 'orders.complete', 'orders.cancel')
  @Patch(':id/items/status')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  updateItems(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderItemsStatusSchema)) body: z.output<typeof updateOrderItemsStatusSchema>,
  ): Promise<OwnerOrder> {
    return this.orders.updateItems(auth.userId, id, body);
  }

  @RequirePermission('orders.update')
  @Patch(':id/priority')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  setPriority(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderPrioritySchema)) body: z.output<typeof updateOrderPrioritySchema>,
  ): Promise<OwnerOrder> {
    return this.orders.setPriority(auth.userId, id, body.priority);
  }

  /** Who moved each dish, and when. */
  @Get(':id/kitchen-history')
  @Header('Cache-Control', 'no-store')
  kitchenHistory(@CurrentAuth() auth: AuthContext, @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string): Promise<OrderItemEvent[]> {
    return this.orders.itemHistory(auth.userId, id);
  }

  /** payments.process to mark paid; payments.refund to mark a paid bill unpaid again. */
  @Patch(':id/payment')
  @RequireAnyPermission('payments.process', 'payments.refund')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  updatePayment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderPaymentSchema)) body: z.output<typeof updateOrderPaymentSchema>,
  ): Promise<OwnerOrder> {
    return this.orders.setPaid(auth.userId, id, body.paid, body.method);
  }
}

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);

/** Ordering from a diner's phone: no account, an Idempotency-Key per checkout, and a tracking link. */
@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly alerts: OrderAlertsService,
  ) {}

  @Post('restaurants/:subdomain/orders')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  // Diners at one restaurant often share its Wi-Fi (one IP), so the main limit is per
  // restaurant; the per-IP cap stops one client spamming many restaurants.
  @RateLimit(
    { name: 'place-order:ip-restaurant', limit: 60, windowSeconds: 10 * 60, by: 'ip+path' },
    { name: 'place-order:ip', limit: 200, windowSeconds: 10 * 60, by: 'ip' },
  )
  place(
    @Param('subdomain') subdomain: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body(new ZodValidationPipe(placeOrderSchema)) body: z.output<typeof placeOrderSchema>,
  ): Promise<PlaceOrderResponse> {
    // @Headers takes no pipes, so the header is validated here.
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey) as string;
    return this.orders.place(subdomain, idempotencyKey, body);
  }

  @Get('orders/:token')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'track-order:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  // Malformed tokens are simply unknown orders (404), like forged ones.
  track(@Param('token') token: string): Promise<PublicOrder> {
    return this.orders.track(token);
  }

  /** Whether the tracking page rings when the order is ready, and the key to subscribe to push with. */
  @Get('orders/:token/alerts')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'order-alerts:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  orderAlerts(@Param('token') token: string): Promise<OrderAlerts> {
    return this.alerts.alerts(token);
  }

  @Post('orders/:token/push')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'push-subscribe:ip', limit: 60, windowSeconds: 10 * 60, by: 'ip' })
  async subscribe(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(pushSubscriptionSchema)) body: z.output<typeof pushSubscriptionSchema>,
  ): Promise<void> {
    const changed = await this.alerts.subscribe(token, body);
    if (changed) await this.orders.touch(changed);
  }

  @Delete('orders/:token/push')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'push-unsubscribe:ip', limit: 60, windowSeconds: 10 * 60, by: 'ip' })
  async unsubscribe(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(pushUnsubscribeSchema)) body: z.output<typeof pushUnsubscribeSchema>,
  ): Promise<void> {
    const changed = await this.alerts.unsubscribe(token, body.endpoint);
    if (changed) await this.orders.touch(changed);
  }
}
