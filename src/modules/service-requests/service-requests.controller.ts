import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  branchQuerySchema,
  cancelServiceRequestSchema,
  createServiceRequestSchema,
  type CreateServiceRequestResponse,
  joinTableSessionSchema,
  listServiceRequestsQuerySchema,
  type OwnerServiceRequest,
  type Paginated,
  type PublicServiceRequest,
  type ServiceRequestStaff,
  type ServiceRequestStats,
  serviceRequestStatsQuerySchema,
  serviceSessionQuerySchema,
  type TableServiceSession,
  updateServiceRequestSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ServiceRequestsService } from './service-requests.service.js';

const idParam = new ZodValidationPipe(z.uuid());

/** The restaurant's side: service.view reads requests (every branch's, or a branch-tied account's own), service.manage handles them. */
@Controller('service-requests')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('service.view')
export class ServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listServiceRequestsQuerySchema)) query: z.output<typeof listServiceRequestsQuerySchema>,
  ): Promise<Paginated<OwnerServiceRequest>> {
    return this.requests.list(auth.userId, query);
  }

  @Get('stats')
  @Header('Cache-Control', 'no-store')
  stats(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(serviceRequestStatsQuerySchema)) query: z.output<typeof serviceRequestStatsQuerySchema>,
  ): Promise<ServiceRequestStats> {
    return this.requests.stats(auth.userId, query);
  }

  /** Staff a branch's requests can be assigned to. */
  @Get('assignees')
  assignees(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(branchQuerySchema)) query: z.output<typeof branchQuerySchema>): Promise<ServiceRequestStaff[]> {
    return this.requests.assignees(auth.userId, query.branchId);
  }

  @Patch(':id')
  @RequirePermission('service.manage')
  @RateLimit({ name: 'service-requests-write:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateServiceRequestSchema)) body: z.output<typeof updateServiceRequestSchema>,
  ): Promise<OwnerServiceRequest> {
    return this.requests.update(auth.userId, id, body);
  }
}

/** The diners' side, from the menu of a table they scanned. */
@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Post('restaurants/:subdomain/tables/:code/session')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'table-session:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  join(
    @Param('subdomain') subdomain: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(joinTableSessionSchema)) body: z.output<typeof joinTableSessionSchema>,
  ): Promise<TableServiceSession> {
    return this.requests.joinSession(subdomain, code, body.sessionToken);
  }

  @Get('service-requests')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'service-requests-read:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  session(@Query(new ZodValidationPipe(serviceSessionQuerySchema)) query: z.output<typeof serviceSessionQuerySchema>): Promise<TableServiceSession> {
    return this.requests.sessionRequests(query.token);
  }

  /** 200 with `duplicate: true` when the same request is already open; 429 SERVICE_REQUEST_THROTTLED within the cooldown. */
  @Post('service-requests')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'service-requests-create:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  create(@Body(new ZodValidationPipe(createServiceRequestSchema)) body: z.output<typeof createServiceRequestSchema>): Promise<CreateServiceRequestResponse> {
    return this.requests.create(body);
  }

  @Post('service-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'service-requests-cancel:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  cancel(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(cancelServiceRequestSchema)) body: z.output<typeof cancelServiceRequestSchema>): Promise<PublicServiceRequest> {
    return this.requests.cancelByGuest(id, body.sessionToken);
  }
}
