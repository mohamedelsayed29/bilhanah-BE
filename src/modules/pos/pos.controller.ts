import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  type AdminPosRestaurant, adminPosAccountSchema, adminPosRestaurantsQuerySchema, type Paginated, posActivateSchema, type PosOverview,
  type PosPlatformSettings, posPlatformSettingsSchema, posSettingsSchema, idempotencyKeySchema, type OwnerOrder, posOrderSchema, type PosTotals,
  type AdminPosHealth, type AuditEntry, type PosReport, posReportQuerySchema,
  type PosDevice, type PosDeviceRegistration, posDeviceSchema, posDeviceUpdateSchema, type PosOrderPayments, posPaymentSchema, type PosReceipt, posRefundSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PosOrdersService } from './pos-orders.service.js';
import { PosTerminalService } from './pos-terminal.service.js';
import { PosReportsService } from './pos-reports.service.js';
import { PosService } from './pos.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'pos-write:ip', limit: 60, windowSeconds: 60, by: 'ip' } as const;

/** The restaurant's POS (docs/POS.md): its status for anyone using it, activation and settings with pos.settings. */
@Controller('pos')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('pos.use', 'pos.settings')
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly orders: PosOrdersService,
    private readonly terminal: PosTerminalService,
    private readonly reports: PosReportsService,
  ) {}

  /** POS sales: pos.settings or analytics.financial. */
  @Get('reports')
  @Header('Cache-Control', 'no-store')
  report(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(posReportQuerySchema)) query: z.output<typeof posReportQuerySchema>): Promise<PosReport> {
    return this.reports.report(auth.userId, query);
  }

  // --- Payments and receipts ---------------------------------------------------------

  @Get('orders/:id/payments')
  @RequirePermission('pos.use')
  @Header('Cache-Control', 'no-store')
  payments(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosOrderPayments> {
    return this.terminal.payments(auth.userId, id);
  }

  /** A payment (part of the bill, or all of it); the same Idempotency-Key records it once. */
  @Post('orders/:id/payments')
  @RequirePermission('pos.use')
  @RateLimit({ name: 'pos-pay:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  pay(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Headers('idempotency-key') key: unknown, @Headers('x-pos-device') device: string | undefined,
    @Body(new ZodValidationPipe(posPaymentSchema)) body: z.output<typeof posPaymentSchema>): Promise<PosOrderPayments> {
    return this.terminal.pay(auth.userId, device, id, new ZodValidationPipe(idempotencyKeySchema).transform(key) as string, body);
  }

  @Post('payments/:id/refunds')
  @RequirePermission('pos.use')
  @RateLimit(WRITE_LIMIT)
  refund(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodValidationPipe(posRefundSchema)) body: z.output<typeof posRefundSchema>): Promise<PosOrderPayments> {
    return this.terminal.refund(auth.userId, id, body);
  }

  @Get('orders/:id/receipt')
  @RequirePermission('pos.use')
  @Header('Cache-Control', 'no-store')
  receipt(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosReceipt> {
    return this.terminal.receipt(auth.userId, id);
  }

  // --- Devices -------------------------------------------------------------------------

  @Get('devices')
  @RequirePermission('pos.settings')
  @Header('Cache-Control', 'no-store')
  devices(@CurrentAuth() auth: AuthContext): Promise<PosDevice[]> {
    return this.terminal.devices(auth.userId);
  }

  @Post('devices')
  @RequirePermission('pos.settings')
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  register(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posDeviceSchema)) body: z.output<typeof posDeviceSchema>): Promise<PosDeviceRegistration> {
    return this.terminal.register(auth.userId, body);
  }

  @Patch('devices/:id')
  @RequirePermission('pos.settings')
  @RateLimit(WRITE_LIMIT)
  updateDevice(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodValidationPipe(posDeviceUpdateSchema)) body: z.output<typeof posDeviceUpdateSchema>): Promise<PosDevice> {
    return this.terminal.updateDevice(auth.userId, id, body);
  }

  @Delete('devices/:id')
  @RequirePermission('pos.settings')
  @RateLimit(WRITE_LIMIT)
  revoke(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosDevice> {
    return this.terminal.revoke(auth.userId, id);
  }

  /** The bill for an order before placing it (prices and totals from the server). */
  @Post('orders/quote')
  @RequirePermission('pos.use')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'pos-quote:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  quote(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posOrderSchema)) body: z.output<typeof posOrderSchema>): Promise<PosTotals> {
    return this.orders.quote(auth.userId, body);
  }

  /** An order taken at the counter; the same Idempotency-Key returns the same order. */
  @Post('orders')
  @RequirePermission('pos.use')
  @RateLimit({ name: 'pos-order:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  place(@CurrentAuth() auth: AuthContext, @Headers('idempotency-key') key: unknown, @Headers('x-pos-device') device: string | undefined, @Body(new ZodValidationPipe(posOrderSchema)) body: z.output<typeof posOrderSchema>): Promise<OwnerOrder> {
    return this.orders.place(auth.userId, new ZodValidationPipe(idempotencyKeySchema).transform(key) as string, body, device);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentAuth() auth: AuthContext): Promise<PosOverview> {
    return this.pos.get(auth.userId);
  }

  @Post('activate')
  @RequirePermission('pos.settings')
  @RateLimit(WRITE_LIMIT)
  activate(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posActivateSchema)) body: z.output<typeof posActivateSchema>): Promise<PosOverview> {
    return this.pos.activate(auth.userId, body.mode);
  }

  @Put('settings')
  @RequirePermission('pos.settings')
  @RateLimit(WRITE_LIMIT)
  settings(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posSettingsSchema)) body: z.output<typeof posSettingsSchema>): Promise<PosOverview> {
    return this.pos.saveSettings(auth.userId, body);
  }
}

/** Administrators: the platform switch and plans, and each restaurant's POS access. */
@Controller('admin/pos')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('ADMIN')
export class AdminPosController {
  constructor(
    private readonly pos: PosService,
    private readonly reports: PosReportsService,
  ) {}

  @Get('health')
  @Header('Cache-Control', 'no-store')
  health(): Promise<AdminPosHealth> {
    return this.reports.health();
  }

  @Get('audit')
  @Header('Cache-Control', 'no-store')
  audit(): Promise<AuditEntry[]> {
    return this.reports.audit();
  }

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  platform(): Promise<PosPlatformSettings> {
    return this.pos.platform();
  }

  @Put('settings')
  @RateLimit(WRITE_LIMIT)
  savePlatform(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posPlatformSettingsSchema)) body: z.output<typeof posPlatformSettingsSchema>): Promise<PosPlatformSettings> {
    return this.pos.savePlatform(auth.userId, body);
  }

  @Get('restaurants')
  @Header('Cache-Control', 'no-store')
  restaurants(@Query(new ZodValidationPipe(adminPosRestaurantsQuerySchema)) query: z.output<typeof adminPosRestaurantsQuerySchema>): Promise<Paginated<AdminPosRestaurant>> {
    return this.pos.restaurants(query);
  }

  @Patch('restaurants/:id')
  @RateLimit(WRITE_LIMIT)
  setAccount(@CurrentAuth() auth: AuthContext, @Param('id', new ZodValidationPipe(z.uuid())) id: string, @Body(new ZodValidationPipe(adminPosAccountSchema)) body: z.output<typeof adminPosAccountSchema>): Promise<AdminPosRestaurant> {
    return this.pos.setAccount(auth.userId, id, body);
  }
}
