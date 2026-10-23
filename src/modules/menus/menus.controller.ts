import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  createCategorySchema,
  createItemSchema,
  menuIdParamSchema,
  type OwnerMenu,
  type OwnerMenuItem,
  reorderSchema,
  updateCategorySchema,
  updateItemSchema,
} from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { MenusService } from './menus.service.js';

const WRITE_LIMIT = { name: 'menu-write:ip', limit: 600, windowSeconds: 60, by: 'ip' } as const;
const idParam = new ZodValidationPipe(menuIdParamSchema);

/**
 * The owner's menu. Editing stays available while the subscription is
 * inactive (the public menu is what pauses), so owners can prepare.
 */
@Controller('menu')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getMenu(@CurrentAuth() auth: AuthContext): Promise<OwnerMenu> {
    return this.menus.getMenu(auth.userId);
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createCategorySchema)) body: z.output<typeof createCategorySchema>,
  ): Promise<OwnerMenu['categories'][number]> {
    return this.menus.createCategory(auth.userId, body);
  }

  @Put('categories/order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async reorderCategories(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(reorderSchema)) body: z.output<typeof reorderSchema>,
  ): Promise<void> {
    await this.menus.reorderCategories(auth.userId, body.ids);
  }

  @Patch('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: z.output<typeof updateCategorySchema>,
  ): Promise<void> {
    await this.menus.updateCategory(auth.userId, id, body);
  }

  /** Also deletes the category's items. */
  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async deleteCategory(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.menus.deleteCategory(auth.userId, id);
  }

  @Put('categories/:id/items/order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async reorderItems(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(reorderSchema)) body: z.output<typeof reorderSchema>,
  ): Promise<void> {
    await this.menus.reorderItems(auth.userId, id, body.ids);
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createItem(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createItemSchema)) body: z.output<typeof createItemSchema>,
  ): Promise<OwnerMenuItem> {
    return this.menus.createItem(auth.userId, body);
  }

  @Patch('items/:id')
  @RateLimit(WRITE_LIMIT)
  updateItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateItemSchema)) body: z.output<typeof updateItemSchema>,
  ): Promise<OwnerMenuItem> {
    return this.menus.updateItem(auth.userId, id, body);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async deleteItem(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.menus.deleteItem(auth.userId, id);
  }
}
