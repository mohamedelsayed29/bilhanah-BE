import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  createKitchenStationSchema,
  type KitchenStation,
  type KitchenStationList,
  type KitchenStats,
  kitchenStatsQuerySchema,
  updateKitchenSettingsSchema,
  updateKitchenStationSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RestaurantMember, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { KitchenStationsService } from './kitchen-stations.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'kitchen-stations-write:ip', limit: 120, windowSeconds: 60, by: 'ip' } as const;

/** Preparation stations and the kitchen display's settings: settings.manage changes them; every restaurant account reads them. */
@Controller('kitchen-stations')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('settings.manage')
export class KitchenStationsController {
  constructor(private readonly stations: KitchenStationsService) {}

  @Get()
  @RestaurantMember()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<KitchenStationList> {
    return this.stations.list(auth.userId);
  }

  /** Average preparation time, delay and accuracy. Declared before :id. */
  @Get('stats')
  @RequirePermission('analytics.view')
  @Header('Cache-Control', 'no-store')
  stats(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(kitchenStatsQuerySchema)) query: z.output<typeof kitchenStatsQuerySchema>): Promise<KitchenStats> {
    return this.stations.stats(auth.userId, query);
  }

  @Put('settings')
  @RateLimit(WRITE_LIMIT)
  settings(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(updateKitchenSettingsSchema)) body: z.output<typeof updateKitchenSettingsSchema>): Promise<KitchenStationList> {
    return this.stations.setReadyRule(auth.userId, body.readyRule);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createKitchenStationSchema)) body: z.output<typeof createKitchenStationSchema>): Promise<KitchenStation> {
    return this.stations.create(auth.userId, body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateKitchenStationSchema)) body: z.output<typeof updateKitchenStationSchema>,
  ): Promise<KitchenStationList> {
    return this.stations.update(auth.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.stations.remove(auth.userId, id);
  }
}
