import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { branchQuerySchema, bulkCreateTablesSchema, createTableSchema, type PublicTable, type RestaurantTable, updateTableSchema } from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TablesService } from './tables.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'tables-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** Owners manage every branch's tables; managers their own branch's. */
@Controller('tables')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER', 'MANAGER')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(branchQuerySchema)) query: z.output<typeof branchQuerySchema>): Promise<RestaurantTable[]> {
    return this.tables.list(auth.userId, query.branchId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createTableSchema)) body: z.output<typeof createTableSchema>): Promise<RestaurantTable> {
    return this.tables.create(auth.userId, body);
  }

  /** Returns every table after creating the range. */
  @Post('range')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createRange(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bulkCreateTablesSchema)) body: z.output<typeof bulkCreateTablesSchema>,
  ): Promise<RestaurantTable[]> {
    return this.tables.createRange(auth.userId, body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateTableSchema)) body: z.output<typeof updateTableSchema>,
  ): Promise<RestaurantTable> {
    return this.tables.update(auth.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.tables.remove(auth.userId, id);
  }

  @Post(':id/code')
  @RateLimit(WRITE_LIMIT)
  regenerateCode(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<RestaurantTable> {
    return this.tables.regenerateCode(auth.userId, id);
  }
}

@Controller('public/restaurants/:subdomain/tables')
@UseGuards(RateLimitGuard)
export class PublicTablesController {
  constructor(private readonly tables: TablesService) {}

  @Get(':code')
  @RateLimit({ name: 'public-table:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  find(@Param('subdomain') subdomain: string, @Param('code') code: string): Promise<PublicTable> {
    return this.tables.findPublic(subdomain, code);
  }
}
