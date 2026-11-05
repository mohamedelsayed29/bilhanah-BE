import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  cashCorrectionSchema,
  type CashRegister,
  type CashReport,
  cashReportQuerySchema,
  type CashSettings,
  cashSettingsSchema,
  type CashShift,
  type CashShiftDetail,
  cashShiftsQuerySchema,
  cashTransactionSchema,
  closeCashShiftSchema,
  createCashRegisterSchema,
  type MyCashDrawer,
  openCashShiftSchema,
  type Paginated,
  type PendingCashAdjustment,
  reviewCashSchema,
  updateCashRegisterSchema,
} from '@bilhanah/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CashService } from './cash.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const branchQuery = new ZodValidationPipe(z.object({ branchId: z.uuid().optional() }));
const WRITE_LIMIT = { name: 'cash-write:ip', limit: 240, windowSeconds: 60, by: 'ip' } as const;

/**
 * Cashier shifts and cash reconciliation. cash.operate opens, works and closes one's own shift;
 * cash.adjust adds adjustments; cash.view reads every shift and the reports; cash.approve reviews
 * discrepancies and adjustments and corrects closed shifts; cash.settings manages registers and rules.
 * The service checks which shift the caller may touch.
 */
@Controller('cash')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('cash.operate', 'cash.view', 'cash.approve', 'cash.settings')
export class CashController {
  constructor(private readonly cash: CashService) {}

  // --- Settings and registers ---

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(@CurrentAuth() auth: AuthContext): Promise<CashSettings> {
    return this.cash.getSettings(auth.userId);
  }

  @Put('settings')
  @RequirePermission('cash.settings')
  @RateLimit(WRITE_LIMIT)
  updateSettings(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(cashSettingsSchema)) body: z.output<typeof cashSettingsSchema>): Promise<CashSettings> {
    return this.cash.updateSettings(auth.userId, body, request.ip);
  }

  @Get('registers')
  @Header('Cache-Control', 'no-store')
  registers(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: { branchId?: string }): Promise<CashRegister[]> {
    return this.cash.registers(auth.userId, query.branchId);
  }

  @Post('registers')
  @RequirePermission('cash.settings')
  @RateLimit(WRITE_LIMIT)
  createRegister(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createCashRegisterSchema)) body: z.output<typeof createCashRegisterSchema>): Promise<CashRegister> {
    return this.cash.createRegister(auth.userId, body, request.ip);
  }

  @Patch('registers/:id')
  @RequirePermission('cash.settings')
  @RateLimit(WRITE_LIMIT)
  updateRegister(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCashRegisterSchema)) body: z.output<typeof updateCashRegisterSchema>,
  ): Promise<CashRegister> {
    return this.cash.updateRegister(auth.userId, id, body, request.ip);
  }

  // --- The caller's drawer ---

  @Get('me')
  @RequirePermission('cash.operate')
  @Header('Cache-Control', 'no-store')
  me(@CurrentAuth() auth: AuthContext): Promise<MyCashDrawer> {
    return this.cash.myDrawer(auth.userId);
  }

  @Post('shifts')
  @RequirePermission('cash.operate')
  @RateLimit(WRITE_LIMIT)
  open(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(openCashShiftSchema)) body: z.output<typeof openCashShiftSchema>): Promise<CashShift> {
    return this.cash.open(auth.userId, body, request.ip);
  }

  // --- Shifts ---

  @Get('shifts')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(cashShiftsQuerySchema)) query: z.output<typeof cashShiftsQuerySchema>): Promise<Paginated<CashShift>> {
    return this.cash.list(auth.userId, query);
  }

  @Get('report')
  @RequirePermission('cash.view')
  @Header('Cache-Control', 'no-store')
  report(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(cashReportQuerySchema)) query: z.output<typeof cashReportQuerySchema>): Promise<CashReport> {
    return this.cash.report(auth.userId, query);
  }

  @Get('adjustments/pending')
  @RequirePermission('cash.approve')
  @Header('Cache-Control', 'no-store')
  pendingAdjustments(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: { branchId?: string }): Promise<PendingCashAdjustment[]> {
    return this.cash.pendingAdjustments(auth.userId, query.branchId);
  }

  @Post('adjustments/:id/review')
  @RequirePermission('cash.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  reviewAdjustment(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(reviewCashSchema)) body: z.output<typeof reviewCashSchema>,
  ): Promise<CashShiftDetail> {
    return this.cash.reviewTransaction(auth.userId, id, body, request.ip);
  }

  @Get('shifts/:id')
  @Header('Cache-Control', 'no-store')
  detail(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<CashShiftDetail> {
    return this.cash.detail(auth.userId, id);
  }

  @Post('shifts/:id/transactions')
  @RateLimit(WRITE_LIMIT)
  addTransaction(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(cashTransactionSchema)) body: z.output<typeof cashTransactionSchema>,
  ): Promise<CashShiftDetail> {
    return this.cash.addTransaction(auth.userId, id, body, request.ip);
  }

  @Post('shifts/:id/closing')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  startClosing(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<CashShift> {
    return this.cash.startClosing(auth.userId, id, request.ip);
  }

  @Post('shifts/:id/reopen')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  cancelClosing(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<CashShift> {
    return this.cash.cancelClosing(auth.userId, id, request.ip);
  }

  @Post('shifts/:id/close')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  close(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(closeCashShiftSchema)) body: z.output<typeof closeCashShiftSchema>,
  ): Promise<CashShift> {
    return this.cash.close(auth.userId, id, body, request.ip);
  }

  @Post('shifts/:id/review')
  @RequirePermission('cash.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  review(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(reviewCashSchema)) body: z.output<typeof reviewCashSchema>,
  ): Promise<CashShift> {
    return this.cash.reviewShift(auth.userId, id, body, request.ip);
  }

  @Post('shifts/:id/corrections')
  @RequirePermission('cash.approve')
  @RateLimit(WRITE_LIMIT)
  correct(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(cashCorrectionSchema)) body: z.output<typeof cashCorrectionSchema>,
  ): Promise<CashShiftDetail> {
    return this.cash.correct(auth.userId, id, body, request.ip);
  }
}
