import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import type { PublicMenuResponse, PublicRestaurant } from '@bilhanah/contracts';
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
  find(@Param('subdomain') subdomain: string, @Query('branch') branch?: unknown): Promise<PublicRestaurant> {
    return this.restaurants.findPublic(subdomain, typeof branch === 'string' && branch ? branch.slice(0, 40) : undefined);
  }

  /** The restaurant and its visible menu; scanned from table QR codes. */
  @Get(':subdomain/menu')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'public-menu:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  /** ?branch=slug picks the branch (its prices, availability and ordering); the main branch otherwise. */
  menu(@Param('subdomain') subdomain: string, @Query('branch') branch?: unknown): Promise<PublicMenuResponse> {
    return this.restaurants.findPublicMenu(subdomain, typeof branch === 'string' && branch ? branch.slice(0, 40) : undefined);
  }
}
