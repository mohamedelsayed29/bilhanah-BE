import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import type { PublicRestaurant } from '@bilhanah/contracts';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RestaurantsService } from './restaurants.service.js';

/** Unauthenticated lookup used by the public web app to resolve `{subdomain}.bilhanah.com`. */
@Controller('public/restaurants')
@UseGuards(RateLimitGuard)
export class PublicRestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  @Get(':subdomain')
  // Access is evaluated per request; caches must not outlive an expiry or suspension.
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'public-restaurant:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  find(@Param('subdomain') subdomain: string): Promise<PublicRestaurant> {
    return this.restaurants.findPublic(subdomain);
  }
}
