import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  idempotencyKeySchema,
  type OrderAlerts,
  orderIdParamSchema,
  ordersQuerySchema,
  type OwnerOrder,
  type Paginated,
  type TableOccupancy,
  updateOrderPaymentSchema,
  placeOrderSchema,
  type PlaceOrderResponse,
  type PublicOrder,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  updateOrderStatusSchema,
} from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OrderAlertsService } from './order-alerts.service.js';
import { OrdersService } from './orders.service.js';

/** The restaurant's orders: the live board, history, and status changes. Kitchen accounts may read and move orders, nothing else. */
@Controller('orders')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequireRole('OWNER', 'KITCHEN')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(ordersQuerySchema)) query: z.output<typeof ordersQuerySchema>): Promise<Paginated<OwnerOrder>> {
    return this.orders.list(auth.userId, query);
  }

  /** Which tables have guests (an unpaid order) right now. Declared before :id. */
  @Get('floor')
  @Header('Cache-Control', 'no-store')
  floor(@CurrentAuth() auth: AuthContext): Promise<TableOccupancy[]> {
    return this.orders.floor(auth.userId);
  }

  /** The guests at this table paid: marks its open orders paid. Returns the whole floor. */
  @Post('tables/:tableId/settle')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  settleTable(@CurrentAuth() auth: AuthContext, @Param('tableId', new ZodValidationPipe(orderIdParamSchema)) tableId: string): Promise<TableOccupancy[]> {
    return this.orders.settleTable(auth.userId, tableId);
  }

  @RequireRole('OWNER', 'KITCHEN')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string): Promise<OwnerOrder> {
    return this.orders.get(auth.userId, id);
  }

  @RequireRole('OWNER', 'KITCHEN')
  @Patch(':id/status')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderStatusSchema)) body: z.output<typeof updateOrderStatusSchema>,
  ): Promise<OwnerOrder> {
    return this.orders.updateStatus(auth.userId, id, body);
  }

  @Patch(':id/payment')
  @RateLimit({ name: 'order-status:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  updatePayment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(orderIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateOrderPaymentSchema)) body: z.output<typeof updateOrderPaymentSchema>,
  ): Promise<OwnerOrder> {
    return this.orders.setPaid(auth.userId, id, body.paid);
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
