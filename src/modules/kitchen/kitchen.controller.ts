import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  createKitchenAccountSchema,
  type KitchenAccount,
  type KitchenContext,
  setKitchenPasswordSchema,
  updateKitchenAccountSchema,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { KitchenService } from './kitchen.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'kitchen-accounts-write:ip', limit: 60, windowSeconds: 60, by: 'ip' } as const;

/** The owner manages the restaurant's kitchen accounts. */
@Controller('kitchen-accounts')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
export class KitchenAccountsController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext): Promise<KitchenAccount[]> {
    return this.kitchen.list(auth.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createKitchenAccountSchema)) body: z.output<typeof createKitchenAccountSchema>,
  ): Promise<KitchenAccount> {
    return this.kitchen.create(auth.userId, body);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateKitchenAccountSchema)) body: z.output<typeof updateKitchenAccountSchema>,
  ): Promise<KitchenAccount> {
    return this.kitchen.update(auth.userId, id, body);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async setPassword(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(setKitchenPasswordSchema)) body: z.output<typeof setKitchenPasswordSchema>,
  ): Promise<void> {
    await this.kitchen.setPassword(auth.userId, id, body.password);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.kitchen.remove(auth.userId, id);
  }
}

/** What a staff account's screen reads about its restaurant and branch. */
@Controller('kitchen')
@UseGuards(AccessTokenGuard, RolesGuard)
@RequireRole('KITCHEN', 'MANAGER')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('context')
  @Header('Cache-Control', 'no-store')
  context(@CurrentAuth() auth: AuthContext): Promise<KitchenContext> {
    return this.kitchen.context(auth.userId);
  }
}
