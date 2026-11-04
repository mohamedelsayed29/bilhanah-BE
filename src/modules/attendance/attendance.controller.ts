import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  activateKioskSchema,
  type AttendanceCorrection,
  type AttendanceKiosk,
  type AttendanceOverview,
  type AttendancePolicies,
  type AttendanceRecord,
  type AttendanceSummaryRow,
  attendancePolicySchema,
  changePinSchema,
  correctionsQuerySchema,
  createCorrectionSchema,
  createEmployeeSchema,
  createKioskSchema,
  createShiftsSchema,
  type Employee,
  type EmployeePin,
  exportQuerySchema,
  type KioskActivation,
  type KioskActivationCode,
  kioskChangePinSchema,
  kioskPunchSchema,
  type KioskState,
  type ManualAttendanceResult,
  manualRecordSchema,
  type MyAttendance,
  type Paginated,
  portalPunchSchema,
  type PunchResult,
  qrPunchSchema,
  rangeQuerySchema,
  recordsQuerySchema,
  reviewCorrectionSchema,
  type Shift,
  updateEmployeeSchema,
  updateRecordSchema,
} from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RestaurantMember, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { recordsTable, summaryTable, toCsv, toXls } from './attendance-export.js';
import { AttendanceKioskService } from './attendance-kiosk.service.js';
import { AttendanceService } from './attendance.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'attendance-write:ip', limit: 240, windowSeconds: 60, by: 'ip' } as const;
const PUNCH_LIMIT = { name: 'attendance-punch:ip', limit: 60, windowSeconds: 60, by: 'ip' } as const;
const overviewQuery = z.object({ date: z.iso.date().optional(), branchId: z.uuid().optional() });

/**
 * Attendance in the restaurant dashboard. Reading needs attendance.view; employees, shifts, kiosks
 * and manual entries attendance.manage; corrections attendance.approve; the rules attendance.settings.
 * The /me routes are the signed-in employee's own attendance. Branch-tied managers stay in their branch.
 */
@Controller('attendance')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('attendance.view')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly kiosks: AttendanceKioskService,
    private readonly scopes: BranchScopeService,
  ) {}

  // --- Policies ---

  @Get('policies')
  @RequireAnyPermission('attendance.view', 'attendance.settings')
  @Header('Cache-Control', 'no-store')
  policies(@CurrentAuth() auth: AuthContext): Promise<AttendancePolicies> {
    return this.attendance.policies(auth.userId);
  }

  @Put('policies/restaurant')
  @RequirePermission('attendance.settings')
  @RateLimit(WRITE_LIMIT)
  setRestaurantPolicy(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(attendancePolicySchema)) body: z.output<typeof attendancePolicySchema>): Promise<AttendancePolicies> {
    return this.attendance.setPolicy(auth.userId, null, body, request.ip);
  }

  @Put('policies/branches/:branchId')
  @RequirePermission('attendance.settings')
  @RateLimit(WRITE_LIMIT)
  setBranchPolicy(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('branchId', idParam) branchId: string, @Body(new ZodValidationPipe(attendancePolicySchema)) body: z.output<typeof attendancePolicySchema>): Promise<AttendancePolicies> {
    return this.attendance.setPolicy(auth.userId, branchId, body, request.ip);
  }

  /** The branch follows the restaurant's rules again. */
  @Delete('policies/branches/:branchId')
  @RequirePermission('attendance.settings')
  @RateLimit(WRITE_LIMIT)
  inheritPolicy(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('branchId', idParam) branchId: string): Promise<AttendancePolicies> {
    return this.attendance.setPolicy(auth.userId, branchId, null, request.ip);
  }

  @Post('policies/branches/:branchId/qr')
  @RequirePermission('attendance.settings')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  regenerateQr(@CurrentAuth() auth: AuthContext, @Param('branchId', idParam) branchId: string): Promise<AttendancePolicies> {
    return this.attendance.regenerateQr(auth.userId, branchId);
  }

  /** The branch's current QR (live, for dynamic mode) to show on a screen. */
  @Get('qr/:branchId')
  @RequirePermission('attendance.manage')
  @Header('Cache-Control', 'no-store')
  liveQr(@CurrentAuth() auth: AuthContext, @Param('branchId', idParam) branchId: string): Promise<{ url: string; expiresAt: string } | null> {
    return this.attendance.liveQr(auth.userId, branchId);
  }

  // --- Employees and shifts ---

  @Get('employees')
  @Header('Cache-Control', 'no-store')
  employees(@CurrentAuth() auth: AuthContext): Promise<Employee[]> {
    return this.attendance.employees(auth.userId);
  }

  @Post('employees')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createEmployee(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createEmployeeSchema)) body: z.output<typeof createEmployeeSchema>): Promise<Employee> {
    return this.attendance.createEmployee(auth.userId, body, request.ip);
  }

  @Patch('employees/:id')
  @RequirePermission('attendance.manage')
  @RateLimit(WRITE_LIMIT)
  updateEmployee(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateEmployeeSchema)) body: z.output<typeof updateEmployeeSchema>): Promise<Employee> {
    return this.attendance.updateEmployee(auth.userId, id, body, request.ip);
  }

  @Post('employees/:id/pin')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  resetPin(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<EmployeePin> {
    return this.attendance.resetPin(auth.userId, id, request.ip);
  }

  @Get('shifts')
  @Header('Cache-Control', 'no-store')
  shifts(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(rangeQuerySchema)) query: z.output<typeof rangeQuerySchema>): Promise<Shift[]> {
    return this.attendance.shifts(auth.userId, query);
  }

  @Post('shifts')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createShifts(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createShiftsSchema)) body: z.output<typeof createShiftsSchema>): Promise<Shift[]> {
    return this.attendance.createShifts(auth.userId, body);
  }

  @Delete('shifts/:id')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async deleteShift(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.attendance.deleteShift(auth.userId, id);
  }

  // --- Records, overview, reports ---

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  overview(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(overviewQuery)) query: z.output<typeof overviewQuery>): Promise<AttendanceOverview> {
    return this.attendance.overview(auth.userId, query.date, query.branchId);
  }

  @Get('records')
  @Header('Cache-Control', 'no-store')
  records(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(recordsQuerySchema)) query: z.output<typeof recordsQuerySchema>): Promise<Paginated<AttendanceRecord>> {
    return this.attendance.records(auth.userId, query);
  }

  @Get('reports/summary')
  @Header('Cache-Control', 'no-store')
  summary(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(rangeQuerySchema)) query: z.output<typeof rangeQuerySchema>): Promise<AttendanceSummaryRow[]> {
    return this.attendance.summary(auth.userId, query);
  }

  /** CSV or Excel of the records or the per-employee summary, with the same filters. */
  @Get('reports/export')
  @RateLimit({ name: 'attendance-export:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  async export(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(exportQuerySchema)) query: z.output<typeof exportQuerySchema>, @Res({ passthrough: true }) response: Response): Promise<string> {
    const scope = await this.scopes.resolve(auth.userId);
    const table = query.report === 'summary'
      ? summaryTable(await this.attendance.summary(auth.userId, query), query.lang)
      : recordsTable(await this.attendance.allRecords(auth.userId, query), query.lang, scope.restaurant.timezone);
    const name = `attendance-${query.report}-${query.from}-to-${query.to}.${query.format}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    if (query.format === 'xls') {
      response.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      return toXls(table, query.report === 'summary' ? (query.lang === 'ar' ? 'ملخص الحضور' : 'Attendance summary') : (query.lang === 'ar' ? 'سجلات الحضور' : 'Attendance records'), query.lang === 'ar');
    }
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return toCsv(table);
  }

  @Post('records')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  manual(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(manualRecordSchema)) body: z.output<typeof manualRecordSchema>): Promise<ManualAttendanceResult> {
    return this.attendance.manual(auth.userId, body, request.ip);
  }

  @Patch('records/:id')
  @RequirePermission('attendance.manage')
  @RateLimit(WRITE_LIMIT)
  updateRecord(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateRecordSchema)) body: z.output<typeof updateRecordSchema>): Promise<ManualAttendanceResult> {
    return this.attendance.updateRecord(auth.userId, id, body, request.ip);
  }

  // --- Corrections ---

  @Get('corrections')
  @Header('Cache-Control', 'no-store')
  corrections(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(correctionsQuerySchema)) query: z.output<typeof correctionsQuerySchema>): Promise<AttendanceCorrection[]> {
    return this.attendance.corrections(auth.userId, query);
  }

  @Post('corrections/:id/approve')
  @RequirePermission('attendance.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  approve(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewCorrectionSchema)) body: z.output<typeof reviewCorrectionSchema>): Promise<AttendanceCorrection> {
    return this.attendance.reviewCorrection(auth.userId, id, true, body.note, request.ip);
  }

  @Post('corrections/:id/reject')
  @RequirePermission('attendance.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  reject(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewCorrectionSchema)) body: z.output<typeof reviewCorrectionSchema>): Promise<AttendanceCorrection> {
    return this.attendance.reviewCorrection(auth.userId, id, false, body.note, request.ip);
  }

  // --- Kiosks ---

  @Get('kiosks')
  @RequirePermission('attendance.manage')
  @Header('Cache-Control', 'no-store')
  kioskList(@CurrentAuth() auth: AuthContext): Promise<AttendanceKiosk[]> {
    return this.kiosks.list(auth.userId);
  }

  @Post('kiosks')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  createKiosk(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createKioskSchema)) body: z.output<typeof createKioskSchema>): Promise<{ kiosk: AttendanceKiosk; activation: KioskActivationCode }> {
    return this.kiosks.create(auth.userId, body, request.ip);
  }

  @Post('kiosks/:id/code')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  kioskCode(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<KioskActivationCode> {
    return this.kiosks.newActivationCode(auth.userId, id);
  }

  @Post('kiosks/:id/disable')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  disableKiosk(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<AttendanceKiosk> {
    return this.kiosks.setDisabled(auth.userId, id, true, request.ip);
  }

  @Post('kiosks/:id/enable')
  @RequirePermission('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  enableKiosk(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<AttendanceKiosk> {
    return this.kiosks.setDisabled(auth.userId, id, false, request.ip);
  }

  // --- The signed-in employee ---

  @Get('me')
  @RestaurantMember()
  @Header('Cache-Control', 'no-store')
  me(@CurrentAuth() auth: AuthContext): Promise<MyAttendance> {
    return this.attendance.me(auth.userId);
  }

  @Post('me/punch')
  @RestaurantMember()
  @HttpCode(HttpStatus.OK)
  @RateLimit(PUNCH_LIMIT)
  punch(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(portalPunchSchema)) body: z.output<typeof portalPunchSchema>): Promise<PunchResult> {
    return this.attendance.portalPunch(auth.userId, body);
  }

  @Post('me/qr')
  @RestaurantMember()
  @HttpCode(HttpStatus.OK)
  @RateLimit(PUNCH_LIMIT)
  qr(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(qrPunchSchema)) body: z.output<typeof qrPunchSchema>): Promise<PunchResult> {
    return this.attendance.qrPunch(auth.userId, body);
  }

  @Post('me/pin')
  @RestaurantMember()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async changePin(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(changePinSchema)) body: z.output<typeof changePinSchema>): Promise<void> {
    await this.attendance.changeMyPin(auth.userId, body.pin);
  }

  @Get('me/corrections')
  @RestaurantMember()
  @Header('Cache-Control', 'no-store')
  myCorrections(@CurrentAuth() auth: AuthContext): Promise<AttendanceCorrection[]> {
    return this.attendance.myCorrections(auth.userId);
  }

  @Post('me/corrections')
  @RestaurantMember()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  requestCorrection(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createCorrectionSchema)) body: z.output<typeof createCorrectionSchema>): Promise<AttendanceCorrection> {
    return this.attendance.requestCorrection(auth.userId, body);
  }
}

/** The kiosk screen: no user session; an activation code, then its own token in X-Kiosk-Token. */
@Controller('attendance-kiosk')
@UseGuards(RateLimitGuard)
export class AttendanceKioskController {
  constructor(private readonly kiosks: AttendanceKioskService) {}

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'kiosk-activate:ip', limit: 10, windowSeconds: 15 * 60, by: 'ip' })
  activate(@Body(new ZodValidationPipe(activateKioskSchema)) body: z.output<typeof activateKioskSchema>): Promise<KioskActivation> {
    return this.kiosks.activate(body.code);
  }

  @Get('state')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'kiosk-state:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  state(@Headers('x-kiosk-token') token: string | undefined): Promise<KioskState> {
    return this.kiosks.state(token);
  }

  @Post('punch')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'kiosk-punch:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  punch(@Headers('x-kiosk-token') token: string | undefined, @Body(new ZodValidationPipe(kioskPunchSchema)) body: z.output<typeof kioskPunchSchema>): Promise<PunchResult> {
    return this.kiosks.punch(token, body);
  }

  @Post('pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'kiosk-pin:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  async changePin(@Headers('x-kiosk-token') token: string | undefined, @Body(new ZodValidationPipe(kioskChangePinSchema)) body: z.output<typeof kioskChangePinSchema>): Promise<void> {
    await this.kiosks.changePin(token, body);
  }
}
