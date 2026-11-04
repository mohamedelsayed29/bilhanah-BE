import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  type BranchList,
  type BranchMenu,
  type BranchMenuCopy,
  type BranchMenuItem,
  type BranchMenuReset,
  createBranchSchema,
  type OwnerBranch,
  reorderBranchesSchema,
  setBranchItemSchema,
  updateBranchSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RestaurantMember, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { BranchesService } from './branches.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'branches-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/**
 * A restaurant's branches. branches.manage adds, removes and reorders them; anyone in the restaurant
 * reads the ones they work at; settings.operational runs a branch's hours and switches; the menu
 * routes need a menu permission. Branch ids are checked against the caller's restaurant and branch
 * in the service.
 */
@Controller('branches')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('branches.manage')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /** Any restaurant account (not administrators): its screens need to know their branches. */
  @Get()
  @RestaurantMember()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<BranchList> {
    return this.branches.list(auth.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'branch-create:ip', limit: 30, windowSeconds: 60 * 60, by: 'ip' })
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createBranchSchema)) body: z.output<typeof createBranchSchema>): Promise<OwnerBranch> {
    return this.branches.create(auth.userId, body);
  }

  /** Declared before :id. */
  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  reorder(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(reorderBranchesSchema)) body: z.output<typeof reorderBranchesSchema>): Promise<BranchList> {
    return this.branches.reorder(auth.userId, body.ids);
  }

  @Get(':id')
  @RestaurantMember()
  @Header('Cache-Control', 'no-store')
  get(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<OwnerBranch> {
    return this.branches.get(auth.userId, id);
  }

  /** Renaming, moving and archiving also need branches.manage (checked in the service). */
  @Patch(':id')
  @RequirePermission('settings.operational')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: z.output<typeof updateBranchSchema>,
  ): Promise<OwnerBranch> {
    return this.branches.update(auth.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.branches.remove(auth.userId, id);
  }

  @Post(':id/main')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  makeMain(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<BranchList> {
    return this.branches.makeMain(auth.userId, id);
  }

  // --- Menu overrides ------------------------------------------------------------

  @Get(':id/menu')
  @RequireAnyPermission('menu.view', 'menu.availability', 'menu.branch')
  @Header('Cache-Control', 'no-store')
  menu(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<BranchMenu> {
    return this.branches.menu(auth.userId, id);
  }

  /** menu.availability for sold out; menu.branch for hiding and prices (checked in the service). */
  @Put(':id/menu/items/:itemId')
  @RequireAnyPermission('menu.availability', 'menu.branch')
  @RateLimit(WRITE_LIMIT)
  setItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('itemId', idParam) itemId: string,
    @Body(new ZodValidationPipe(setBranchItemSchema)) body: z.output<typeof setBranchItemSchema>,
  ): Promise<BranchMenuItem> {
    return this.branches.setItem(auth.userId, id, itemId, body);
  }

  @Post(':id/menu/reset')
  @RequirePermission('menu.branch')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  resetMenu(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<BranchMenuReset> {
    return this.branches.resetMenu(auth.userId, id);
  }

  @Post(':id/menu/copy-from/:sourceId')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  copyMenu(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Param('sourceId', idParam) sourceId: string): Promise<BranchMenuCopy> {
    return this.branches.copyMenu(auth.userId, id, sourceId);
  }
}
