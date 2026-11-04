import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  branchQuerySchema,
  bulkCreateTablesSchema,
  createReservationSchema,
  createTableAreaSchema,
  createTableSchema,
  deleteTableAreaQuerySchema,
  listReservationsQuerySchema,
  type Reservation,
  type PublicTable,
  type RestaurantTable,
  type TableArea,
  updateReservationSchema,
  updateTableAreaSchema,
  updateTableSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ReservationsService } from './reservations.service.js';
import { TableAreasService } from './table-areas.service.js';
import { TablesService } from './tables.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'tables-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** tables.manage changes tables (every branch's, or a branch-tied account's own); tables.view reads them. */
@Controller('tables')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('tables.manage')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @RequirePermission('tables.view')
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

/** Seating areas: tables.manage changes them, tables.view reads them. */
@Controller('table-areas')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('tables.manage')
export class TableAreasController {
  constructor(private readonly areas: TableAreasService) {}

  @Get()
  @RequirePermission('tables.view')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(branchQuerySchema)) query: z.output<typeof branchQuerySchema>): Promise<TableArea[]> {
    return this.areas.list(auth.userId, query.branchId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createTableAreaSchema)) body: z.output<typeof createTableAreaSchema>): Promise<TableArea> {
    return this.areas.create(auth.userId, body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateTableAreaSchema)) body: z.output<typeof updateTableAreaSchema>,
  ): Promise<TableArea> {
    return this.areas.update(auth.userId, id, body);
  }

  /** 409 TABLE_AREA_NOT_EMPTY while it has tables and no moveTo says where they go. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(deleteTableAreaQuerySchema)) query: z.output<typeof deleteTableAreaQuerySchema>,
  ): Promise<void> {
    await this.areas.remove(auth.userId, id, query);
  }
}

/** Bookings: reservations.manage takes and changes them (and assigns their tables), reservations.view reads them. */
@Controller('reservations')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('reservations.manage')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @RequirePermission('reservations.view')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listReservationsQuerySchema)) query: z.output<typeof listReservationsQuerySchema>,
  ): Promise<Reservation[]> {
    return this.reservations.list(auth.userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createReservationSchema)) body: z.output<typeof createReservationSchema>): Promise<Reservation> {
    return this.reservations.create(auth.userId, body);
  }

  /** Status changes too: confirm, seat, complete, cancel, no-show. */
  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateReservationSchema)) body: z.output<typeof updateReservationSchema>,
  ): Promise<Reservation> {
    return this.reservations.update(auth.userId, id, body);
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
