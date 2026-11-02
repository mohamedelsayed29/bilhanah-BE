import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { type BranchComparison, type PlatformStats, recordVisitSchema, type RestaurantStats, statsQuerySchema } from '@bilhanah/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { StatsService } from './stats.service.js';
import { VisitsService } from './visits.service.js';

/** Sent by a restaurant's menu page once per load. */
@Controller('public/restaurants')
@UseGuards(RateLimitGuard)
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Post(':subdomain/visits')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'visit:ip-restaurant', limit: 60, windowSeconds: 60 * 60, by: 'ip+path' })
  async record(
    @Param('subdomain') subdomain: string,
    @Body(new ZodValidationPipe(recordVisitSchema)) body: z.output<typeof recordVisitSchema>,
    @Req() request: Request,
  ): Promise<void> {
    await this.visits.record(subdomain, body.source, request.ip ?? '', request.get('user-agent') ?? '');
  }
}

@Controller('restaurants/mine/stats')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER', 'MANAGER')
export class RestaurantStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'stats:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  get(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(statsQuerySchema)) query: z.output<typeof statsQuerySchema>): Promise<RestaurantStats> {
    return this.stats.restaurant(auth.userId, query.days, query.branchId);
  }

  @Get('branches')
  @RequireRole('OWNER')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'stats:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  branches(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(statsQuerySchema)) query: z.output<typeof statsQuerySchema>): Promise<BranchComparison> {
    return this.stats.branches(auth.userId, query.days);
  }
}

@Controller('admin/stats')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('ADMIN')
export class PlatformStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Query(new ZodValidationPipe(statsQuerySchema)) query: z.output<typeof statsQuerySchema>): Promise<PlatformStats> {
    return this.stats.platform(query.days);
  }
}
