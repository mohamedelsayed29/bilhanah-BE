import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  addTableItemSchema,
  idempotencyKeySchema,
  joinSharedTableSchema,
  type OwnerTableSession,
  submitTableSessionSchema,
  type SubmitTableSessionResponse,
  TABLE_GUEST_HEADER,
  type TableSessionStats,
  tableSessionStatsQuerySchema,
  type TableSessionView,
  updateTableGuestSchema,
  updateTableItemSchema,
  updateTableSessionStatusSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TableSessionsService } from './table-sessions.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);
const versionQuery = new ZodValidationPipe(z.object({ version: z.coerce.number().int().min(0).optional() }));
const guestText = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
// Guests at one table often share its Wi-Fi (one IP): generous per IP.
const GUEST_WRITE = { name: 'table-session-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;
const GUEST_READ = { name: 'table-session-read:ip', limit: 600, windowSeconds: 60, by: 'ip' } as const;

/** The guests' side of a shared table session. After joining, every call carries the guest token in the x-table-guest header. */
@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicTableSessionsController {
  constructor(private readonly sessions: TableSessionsService) {}

  @Post('restaurants/:subdomain/tables/:code/join')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'table-session-join:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  join(@Param('subdomain') subdomain: string, @Param('code') code: string, @Body(new ZodValidationPipe(joinSharedTableSchema)) body: z.output<typeof joinSharedTableSchema>): Promise<TableSessionView> {
    return this.sessions.join(subdomain, code, body);
  }

  @Get('table-session')
  @Header('Cache-Control', 'no-store')
  @RateLimit(GUEST_READ)
  get(@Headers(TABLE_GUEST_HEADER) guest: unknown): Promise<TableSessionView> {
    return this.sessions.get(guestText(guest));
  }

  @Patch('table-session/me')
  @RateLimit(GUEST_WRITE)
  rename(@Headers(TABLE_GUEST_HEADER) guest: unknown, @Body(new ZodValidationPipe(updateTableGuestSchema)) body: z.output<typeof updateTableGuestSchema>): Promise<TableSessionView> {
    return this.sessions.rename(guestText(guest), body.displayName);
  }

  @Post('table-session/items')
  @HttpCode(HttpStatus.OK)
  @RateLimit(GUEST_WRITE)
  add(@Headers(TABLE_GUEST_HEADER) guest: unknown, @Body(new ZodValidationPipe(addTableItemSchema)) body: z.output<typeof addTableItemSchema>): Promise<TableSessionView> {
    return this.sessions.addItem(guestText(guest), body);
  }

  @Patch('table-session/items/:id')
  @RateLimit(GUEST_WRITE)
  update(
    @Headers(TABLE_GUEST_HEADER) guest: unknown,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateTableItemSchema)) body: z.output<typeof updateTableItemSchema>,
  ): Promise<TableSessionView> {
    return this.sessions.updateItem(guestText(guest), id, body);
  }

  @Delete('table-session/items/:id')
  @RateLimit(GUEST_WRITE)
  remove(@Headers(TABLE_GUEST_HEADER) guest: unknown, @Param('id', idParam) id: string, @Query(versionQuery) query: { version?: number }): Promise<TableSessionView> {
    return this.sessions.removeItem(guestText(guest), id, query.version);
  }

  /** Needs an Idempotency-Key header: a retried submission returns the same order. */
  @Post('table-session/submit')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'table-session-submit:ip', limit: 60, windowSeconds: 10 * 60, by: 'ip' })
  submit(
    @Headers(TABLE_GUEST_HEADER) guest: unknown,
    @Headers('idempotency-key') rawKey: unknown,
    @Body(new ZodValidationPipe(submitTableSessionSchema)) body: z.output<typeof submitTableSessionSchema>,
  ): Promise<SubmitTableSessionResponse> {
    return this.sessions.submit(guestText(guest), idempotencyKeyPipe.transform(rawKey) as string, body);
  }
}

/** Open table sessions on the dashboard, their status, and the feature's metrics. */
@Controller('table-sessions')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
export class TableSessionsController {
  constructor(private readonly sessions: TableSessionsService) {}

  @Get()
  @RequirePermission('tables.view')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(z.object({ branchId: z.uuid().optional() }))) query: { branchId?: string }): Promise<OwnerTableSession[]> {
    return this.sessions.list(auth.userId, query.branchId);
  }

  @Get('stats')
  @RequirePermission('analytics.view')
  @Header('Cache-Control', 'no-store')
  stats(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(tableSessionStatsQuerySchema)) query: z.output<typeof tableSessionStatsQuerySchema>): Promise<TableSessionStats> {
    return this.sessions.stats(auth.userId, query);
  }

  @Patch(':id')
  @RequireAnyPermission('service.manage', 'payments.process')
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateTableSessionStatusSchema)) body: z.output<typeof updateTableSessionStatusSchema>,
  ): Promise<OwnerTableSession> {
    return this.sessions.setStatus(auth.userId, id, body.status);
  }
}
