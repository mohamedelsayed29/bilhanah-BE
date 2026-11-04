import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  createRecommendationSchema,
  recommendationEventsSchema,
  type RecommendationRule,
  type RecommendationStats,
  recommendationStatsQuerySchema,
  updateRecommendationSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RecommendationsService } from './recommendations.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'recommendations-write:ip', limit: 120, windowSeconds: 60, by: 'ip' } as const;

/** The menu is the owner's, so its suggestions are too; their report is the owner's. */
@Controller('recommendations')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('promotions.manage')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<RecommendationRule[]> {
    return this.recommendations.list(auth.userId);
  }

  @Get('stats')
  @Header('Cache-Control', 'no-store')
  stats(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(recommendationStatsQuerySchema)) query: z.output<typeof recommendationStatsQuerySchema>): Promise<RecommendationStats> {
    return this.recommendations.stats(auth.userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createRecommendationSchema)) body: z.output<typeof createRecommendationSchema>): Promise<RecommendationRule> {
    return this.recommendations.create(auth.userId, body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateRecommendationSchema)) body: z.output<typeof updateRecommendationSchema>,
  ): Promise<RecommendationRule> {
    return this.recommendations.update(auth.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.recommendations.remove(auth.userId, id);
  }
}

@Controller('public/restaurants/:subdomain/recommendation-events')
@UseGuards(RateLimitGuard)
export class PublicRecommendationEventsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /** Batched from the diner's phone; unknown rules are dropped quietly. */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'recommendation-events:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  async record(@Param('subdomain') subdomain: string, @Body(new ZodValidationPipe(recommendationEventsSchema)) body: z.output<typeof recommendationEventsSchema>): Promise<void> {
    await this.recommendations.recordEvents(subdomain, body);
  }
}
