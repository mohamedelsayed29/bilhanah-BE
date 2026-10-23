import { Controller, Get, Header, NotFoundException, Param, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { COMMON_ERROR_CODES } from '@bilhanah/contracts';
import type { Request, Response } from 'express';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ICON_SIZES, PwaService, type WebAppManifest } from './pwa.service.js';

/**
 * Home Screen install for restaurant menus. Cacheable: nothing here depends on the subscription.
 * Loaded by restaurant sites on other origins, so helmet's same-origin resource policy is lifted.
 */
@Controller('public/restaurants')
@UseGuards(RateLimitGuard)
export class PwaController {
  constructor(private readonly pwa: PwaService) {}

  @Get(':subdomain/manifest.webmanifest')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @RateLimit({ name: 'pwa:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  async manifest(
    @Param('subdomain') subdomain: string,
    @Query('start') start: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebAppManifest> {
    response.type('application/manifest+json');
    // request.protocol follows X-Forwarded-Proto from trusted proxies (TRUST_PROXY).
    return this.pwa.manifest(subdomain, typeof start === 'string' ? start : undefined, `${request.protocol}://${request.get('host')}`);
  }

  @Get(':subdomain/icon-:size.png')
  @Header('Cache-Control', 'public, max-age=86400')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @RateLimit({ name: 'pwa:ip', limit: 600, windowSeconds: 60, by: 'ip' })
  async icon(
    @Param('subdomain') subdomain: string,
    @Param('size') rawSize: string,
  ): Promise<StreamableFile> {
    const size = ICON_SIZES.find((candidate) => String(candidate) === rawSize);
    if (!size) throw new NotFoundException({ code: COMMON_ERROR_CODES.NOT_FOUND, message: `Icons come in sizes ${ICON_SIZES.join(', ')}.` });
    return new StreamableFile(await this.pwa.icon(subdomain, size), { type: 'image/png' });
  }
}
