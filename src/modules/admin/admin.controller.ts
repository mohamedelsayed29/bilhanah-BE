import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import {
  adminAuditQuerySchema,
  type AdminEntitlement,
  type AdminOverview,
  type AdminPayment,
  adminPaymentsQuerySchema,
  type AdminRestaurantDetail,
  type AdminRestaurantRow,
  adminRestaurantsQuerySchema,
  type AdminSettings,
  type AuditEntry,
  grantEntitlementSchema,
  type OwnerPayment,
  type Paginated,
  paymentIdParamSchema,
  planCodeParamSchema,
  rejectPaymentSchema,
  suspendRestaurantSchema,
  updatePaymentSettingsSchema,
  updatePlanPriceSchema,
  updateTrialSettingsSchema,
} from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { sendReceipt } from '../billing/billing.controller.js';
import { BillingService } from '../billing/billing.service.js';
import { AdminService } from './admin.service.js';

const idParam = new ZodValidationPipe(paymentIdParamSchema);
const WRITE_LIMIT = { name: 'admin-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** Platform administration. Administrators sign in with a password and an authenticator code. */
@Controller('admin')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('ADMIN')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly billing: BillingService,
  ) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  overview(): Promise<AdminOverview> {
    return this.admin.overview();
  }

  @Get('restaurants')
  @Header('Cache-Control', 'no-store')
  restaurants(
    @Query(new ZodValidationPipe(adminRestaurantsQuerySchema)) query: z.output<typeof adminRestaurantsQuerySchema>,
  ): Promise<Paginated<AdminRestaurantRow>> {
    return this.admin.restaurants(query);
  }

  @Get('restaurants/:id')
  @Header('Cache-Control', 'no-store')
  restaurant(@Param('id', idParam) id: string): Promise<AdminRestaurantDetail> {
    return this.admin.restaurant(id);
  }

  @Post('restaurants/:id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(suspendRestaurantSchema)) body: z.output<typeof suspendRestaurantSchema>,
    @Req() request: Request,
  ): Promise<void> {
    await this.admin.setSuspended(auth.userId, id, true, body.reason, request.ip);
  }

  @Post('restaurants/:id/unsuspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async unsuspend(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Req() request: Request): Promise<void> {
    await this.admin.setSuspended(auth.userId, id, false, null, request.ip);
  }

  @Post('restaurants/:id/entitlements')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  grant(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(grantEntitlementSchema)) body: z.output<typeof grantEntitlementSchema>,
    @Req() request: Request,
  ): Promise<AdminEntitlement> {
    return this.billing.grant(auth.userId, id, body, request.ip);
  }

  @Get('payments')
  @Header('Cache-Control', 'no-store')
  payments(@Query(new ZodValidationPipe(adminPaymentsQuerySchema)) query: z.output<typeof adminPaymentsQuerySchema>): Promise<Paginated<AdminPayment>> {
    return this.admin.payments(query);
  }

  @Get('payments/:id')
  @Header('Cache-Control', 'no-store')
  payment(@Param('id', idParam) id: string): Promise<AdminPayment> {
    return this.admin.payment(id);
  }

  @Get('payments/:id/proof')
  async proof(@Param('id', idParam) id: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    return sendReceipt(response, await this.billing.adminProof(id));
  }

  @Post('payments/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  approve(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Req() request: Request): Promise<OwnerPayment> {
    return this.billing.approve(auth.userId, id, request.ip);
  }

  @Post('payments/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(rejectPaymentSchema)) body: z.output<typeof rejectPaymentSchema>,
    @Req() request: Request,
  ): Promise<OwnerPayment> {
    return this.billing.reject(auth.userId, id, body.reason, request.ip);
  }

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(): Promise<AdminSettings> {
    return this.admin.settings();
  }

  @Put('settings/payment')
  @RateLimit(WRITE_LIMIT)
  updatePaymentSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updatePaymentSettingsSchema)) body: z.output<typeof updatePaymentSettingsSchema>,
    @Req() request: Request,
  ): Promise<AdminSettings> {
    return this.admin.updatePaymentSettings(auth.userId, body, request.ip);
  }

  @Put('settings/trial')
  @RateLimit(WRITE_LIMIT)
  updateTrialSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateTrialSettingsSchema)) body: z.output<typeof updateTrialSettingsSchema>,
    @Req() request: Request,
  ): Promise<AdminSettings> {
    return this.admin.updateTrialSettings(auth.userId, body, request.ip);
  }

  @Put('plans/:code')
  @RateLimit(WRITE_LIMIT)
  updatePlanPrice(
    @CurrentAuth() auth: AuthContext,
    @Param('code', new ZodValidationPipe(planCodeParamSchema)) code: z.output<typeof planCodeParamSchema>,
    @Body(new ZodValidationPipe(updatePlanPriceSchema)) body: z.output<typeof updatePlanPriceSchema>,
    @Req() request: Request,
  ): Promise<AdminSettings> {
    return this.admin.updatePlanPrice(auth.userId, code, body.priceMonthlyPiastres, request.ip);
  }

  @Get('audit')
  @Header('Cache-Control', 'no-store')
  audit(@Query(new ZodValidationPipe(adminAuditQuerySchema)) query: z.output<typeof adminAuditQuerySchema>): Promise<Paginated<AuditEntry>> {
    return this.admin.auditLog(query);
  }
}
