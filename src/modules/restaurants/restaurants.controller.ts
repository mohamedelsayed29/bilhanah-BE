import { Body, Controller, Get, Header, HttpCode, HttpStatus, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  createRestaurantSchema,
  type OwnerRestaurant,
  type SubdomainAvailability,
  subdomainAvailabilityQuerySchema,
  updateRestaurantSchema,
} from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RestaurantsService } from './restaurants.service.js';

@Controller('restaurants')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  @Get('subdomain-availability')
  @RateLimit({ name: 'subdomain-check:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  checkSubdomain(
    @Query(new ZodValidationPipe(subdomainAvailabilityQuerySchema)) query: z.output<typeof subdomainAvailabilityQuerySchema>,
  ): Promise<SubdomainAvailability> {
    return this.restaurants.checkSubdomain(query.name);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'restaurant-create:ip', limit: 10, windowSeconds: 60 * 60, by: 'ip' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createRestaurantSchema)) body: z.output<typeof createRestaurantSchema>,
  ): Promise<OwnerRestaurant> {
    return this.restaurants.create(auth.userId, body);
  }

  @Get('mine')
  @Header('Cache-Control', 'no-store')
  findMine(@CurrentAuth() auth: AuthContext): Promise<OwnerRestaurant> {
    return this.restaurants.findMine(auth.userId);
  }

  @Patch('mine')
  updateMine(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateRestaurantSchema)) body: z.output<typeof updateRestaurantSchema>,
  ): Promise<OwnerRestaurant> {
    return this.restaurants.updateMine(auth.userId, body);
  }
}
