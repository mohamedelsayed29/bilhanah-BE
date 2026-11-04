import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  createKitchenAccountSchema,
  type KitchenAccount,
  type KitchenContext,
  setKitchenPasswordSchema,
  type StaffAuditEntry,
  type StaffOptions,
  STAFF_ROLES,
  updateKitchenAccountSchema,
} from '@bilhanah/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { type Actor, KitchenService } from './kitchen.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'kitchen-accounts-write:ip', limit: 60, windowSeconds: 60, by: 'ip' } as const;

const actor = (auth: AuthContext, request: Request): Actor => ({ userId: auth.userId, ...(request.ip && { ipAddress: request.ip }) });

/**
 * Staff accounts (the path keeps its first name). The owner manages every one; managers with
 * staff.manage only the roles they may give, at their branch. Which role may be given and which
 * account may be changed is checked in the service, against the caller's permissions.
 */
@Controller('kitchen-accounts')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('staff.manage')
export class KitchenAccountsController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get()
  @RequirePermission('staff.view')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<KitchenAccount[]> {
    return this.kitchen.list(auth.userId);
  }

  /** The roles and extra permissions the caller may give. Declared before :id. */
  @Get('options')
  @RequirePermission('staff.view')
  @Header('Cache-Control', 'no-store')
  options(@CurrentAuth() auth: AuthContext): Promise<StaffOptions> {
    return this.kitchen.options(auth.userId);
  }

  /** Who created, changed, (de)activated or removed which account. Declared before :id. */
  @Get('activity')
  @Header('Cache-Control', 'no-store')
  activity(@CurrentAuth() auth: AuthContext): Promise<StaffAuditEntry[]> {
    return this.kitchen.activity(auth.userId);
  }

  @Post()
  @RequirePermission('staff.manage', 'roles.assign')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Body(new ZodValidationPipe(createKitchenAccountSchema)) body: z.output<typeof createKitchenAccountSchema>,
  ): Promise<KitchenAccount> {
    return this.kitchen.create(actor(auth, request), body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateKitchenAccountSchema)) body: z.output<typeof updateKitchenAccountSchema>,
  ): Promise<KitchenAccount> {
    return this.kitchen.update(actor(auth, request), id, body);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async setPassword(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(setKitchenPasswordSchema)) body: z.output<typeof setKitchenPasswordSchema>,
  ): Promise<void> {
    await this.kitchen.setPassword(actor(auth, request), id, body.password);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<void> {
    await this.kitchen.remove(actor(auth, request), id);
  }
}

/** What a staff account's screens read about its restaurant, branch and permissions. */
@Controller('kitchen')
@UseGuards(AccessTokenGuard, RolesGuard)
@RequireRole(...STAFF_ROLES)
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('context')
  @Header('Cache-Control', 'no-store')
  context(@CurrentAuth() auth: AuthContext): Promise<KitchenContext> {
    return this.kitchen.context(auth.userId);
  }
}
