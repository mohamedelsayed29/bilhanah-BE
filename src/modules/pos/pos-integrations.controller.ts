import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  type PosIntegration, posIntegrationCreateSchema, type PosIntegrationSecrets, posIntegrationUpdateSchema, type PosMapping, posMappingSchema,
  type PosProviderInfo, type PosSyncJob, type PosWebhookLog,
} from '@bilhanah/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PosIntegrationsService } from './pos-integrations.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'pos-integration:ip', limit: 60, windowSeconds: 60, by: 'ip' } as const;

/** External POS integrations (docs/POS.md, task 6): pos.settings, with a POS mode that includes EXTERNAL. */
@Controller('pos')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('pos.settings')
export class PosIntegrationsController {
  constructor(private readonly integrations: PosIntegrationsService) {}

  @Get('providers')
  providers(): PosProviderInfo[] {
    return this.integrations.providers();
  }

  @Get('integrations')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<PosIntegration[]> {
    return this.integrations.list(auth.userId);
  }

  @Post('integrations')
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(posIntegrationCreateSchema)) body: z.output<typeof posIntegrationCreateSchema>): Promise<{ integration: PosIntegration; secrets: PosIntegrationSecrets }> {
    return this.integrations.create(auth.userId, body);
  }

  @Patch('integrations/:id')
  @RateLimit(WRITE_LIMIT)
  update(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodValidationPipe(posIntegrationUpdateSchema)) body: z.output<typeof posIntegrationUpdateSchema>): Promise<PosIntegration> {
    return this.integrations.update(auth.userId, id, body);
  }

  @Post('integrations/:id/test')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  test(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosIntegration> {
    return this.integrations.test(auth.userId, id);
  }

  @Post('integrations/:id/sync-menu')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  syncMenu(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<never> {
    return this.integrations.syncMenu(auth.userId, id);
  }

  @Post('integrations/:id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosIntegration> {
    return this.integrations.setStatus(auth.userId, id, 'PAUSED');
  }

  @Post('integrations/:id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosIntegration> {
    return this.integrations.setStatus(auth.userId, id, 'ACTIVE');
  }

  /** Stops syncing for good; orders, payments, jobs and events stay. */
  @Post('integrations/:id/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnect(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosIntegration> {
    return this.integrations.setStatus(auth.userId, id, 'DISCONNECTED');
  }

  @Post('integrations/:id/rotate-secrets')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  rotate(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosIntegrationSecrets> {
    return this.integrations.rotate(auth.userId, id);
  }

  @Get('integrations/:id/jobs')
  @Header('Cache-Control', 'no-store')
  jobs(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query('status') status?: string): Promise<PosSyncJob[]> {
    return this.integrations.jobs(auth.userId, id, ['PENDING', 'RUNNING', 'SUCCEEDED', 'DEAD'].includes(status ?? '') ? status : undefined);
  }

  @Post('integrations/:id/jobs/:jobId/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  retry(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Param('jobId', uuid) jobId: string): Promise<void> {
    return this.integrations.retry(auth.userId, id, jobId);
  }

  @Get('integrations/:id/logs')
  @Header('Cache-Control', 'no-store')
  logs(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosWebhookLog[]> {
    return this.integrations.logs(auth.userId, id);
  }

  @Get('integrations/:id/mappings')
  @Header('Cache-Control', 'no-store')
  mappings(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PosMapping[]> {
    return this.integrations.mappings(auth.userId, id);
  }

  @Put('integrations/:id/mappings')
  @RateLimit(WRITE_LIMIT)
  map(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodValidationPipe(posMappingSchema)) body: z.output<typeof posMappingSchema>): Promise<PosMapping> {
    return this.integrations.map(auth.userId, id, body);
  }

  @Delete('integrations/:id/mappings/:mappingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unmap(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Param('mappingId', uuid) mappingId: string): Promise<void> {
    return this.integrations.unmap(auth.userId, id, mappingId);
  }
}

/** Webhooks from external POS systems: no session, a signature instead. */
@Controller('public/pos/webhooks')
@UseGuards(RateLimitGuard)
export class PosWebhooksController {
  constructor(private readonly integrations: PosIntegrationsService) {}

  @Post(':integrationId')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'pos-webhook:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  receive(@Param('integrationId') integrationId: string, @Req() request: Request & { rawBody?: Buffer }, @Body() body: unknown): Promise<{ outcome: string; duplicate?: boolean }> {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
    return this.integrations.webhook(integrationId, request.rawBody, body, headers);
  }
}
