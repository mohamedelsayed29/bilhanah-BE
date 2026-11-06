import { Body, Controller, Get, Header, Param, ParseEnumPipe, Put, UseGuards } from '@nestjs/common';
import { RESTAURANT_SERVICES, type RestaurantServiceKey, type RestaurantSetup, restaurantSetupSchema, setServiceSchema } from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RestaurantServicesService } from './services.service.js';

/** The owner's services and setup (docs/SERVICES.md). Only the owner switches services. */
@Controller('restaurants/mine')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
@RequirePermission('settings.manage')
export class RestaurantServicesController {
  constructor(private readonly services: RestaurantServicesService) {}

  @Get('setup')
  @Header('Cache-Control', 'no-store')
  setup(@CurrentAuth() auth: AuthContext): Promise<RestaurantSetup> {
    return this.services.setup(auth.userId);
  }

  /** The onboarding answers, and optionally the full set of services to have on. */
  @Put('setup')
  @RateLimit({ name: 'restaurant-setup:ip', limit: 30, windowSeconds: 60, by: 'ip' })
  saveSetup(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(restaurantSetupSchema)) body: z.output<typeof restaurantSetupSchema>,
  ): Promise<RestaurantSetup> {
    return this.services.saveSetup(auth.userId, body);
  }

  @Put('services/:service')
  @RateLimit({ name: 'restaurant-service:ip', limit: 60, windowSeconds: 60, by: 'ip' })
  setService(
    @CurrentAuth() auth: AuthContext,
    @Param('service', new ParseEnumPipe(Object.fromEntries(RESTAURANT_SERVICES.map((key) => [key, key])))) service: RestaurantServiceKey,
    @Body(new ZodValidationPipe(setServiceSchema)) body: z.output<typeof setServiceSchema>,
  ): Promise<RestaurantSetup> {
    return this.services.setEnabled(auth.userId, service, body.enabled);
  }
}
