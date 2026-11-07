import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { overviewQuerySchema, type RestaurantOverview, type BranchComparison, type PlatformStats, recordVisitSchema, type RestaurantStats, statsQuerySchema, type TableAnalytics, tableAnalyticsQuerySchema } from '@bilhanah/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { StatsService } from './stats.service.js';
import { OverviewService } from './overview.service.js';
import { TableAnalyticsService } from './table-analytics.service.js';
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

/** The dashboard's figures: analytics.view (or dashboard.view, without revenue unless analytics.financial). */
@Controller('restaurants/mine/stats')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('analytics.view', 'dashboard.view')
export class RestaurantStatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly tables: TableAnalyticsService,
    private readonly overviews: OverviewService,
  ) {}

  /** The dashboard's home: figures against the previous period, sales over time, income, trending and sold-out dishes. */
  @Get('overview')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'stats:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  overview(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(overviewQuerySchema)) query: z.output<typeof overviewQuerySchema>): Promise<RestaurantOverview> {
    return this.overviews.get(auth.userId, query.period, query.branchId);
  }

  /** The tables' use and revenue over a period, by table (and area). */
  @Get('tables')
  @RequirePermission('analytics.view')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'stats:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  tableStats(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(tableAnalyticsQuerySchema)) query: z.output<typeof tableAnalyticsQuerySchema>): Promise<TableAnalytics> {
    return this.tables.get(auth.userId, query);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'stats:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  get(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(statsQuerySchema)) query: z.output<typeof statsQuerySchema>): Promise<RestaurantStats> {
    return this.stats.restaurant(auth.userId, query.days, query.branchId);
  }

  /** Branches side by side, revenue included. */
  @Get('branches')
  @RequirePermission('analytics.view', 'analytics.financial')
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
