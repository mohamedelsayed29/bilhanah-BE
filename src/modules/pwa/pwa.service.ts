import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeSubdomain, RESTAURANT_ERROR_CODES, trackingTokenSchema } from '@bilhanah/contracts';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { MediaService } from '../media/media.service.js';
import { BILHANAH_MARK_SVG } from './bilhanah-mark.js';

export const ICON_SIZES = [180, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** The brand colors of the website (bilhanah-client-FE: src/styles/global.css). */
const TEAL = '#075e54';
const IVORY = '#fff8ef';
/** The art fills this share of the icon, which keeps it inside the maskable safe zone (80%). */
const ART_SCALE = 0.72;
const ICON_CACHE_SECONDS = 7 * 24 * 60 * 60;

export type WebAppManifest = {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: 'rtl' | 'ltr';
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: 'image/png'; purpose: 'any' | 'maskable' }[];
};

const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

/**
 * Lets diners add a restaurant's menu to their Home Screen: a web app
 * manifest per restaurant, and square icons made from its logo. iPhones only
 * deliver Web Push to sites added this way.
 */
@Injectable()
export class PwaService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  /**
   * `start` is where the installed app opens: the menu ("/"), or an order's
   * tracking page, so an iPhone install made while waiting opens that order.
   * `apiOrigin` is where this API is reached, for the icon URLs.
   */
  async manifest(rawSubdomain: string, start: string | undefined, apiOrigin: string): Promise<WebAppManifest> {
    const restaurant = await this.find(rawSubdomain);
    const site = this.urlTemplate.replace('{subdomain}', restaurant.subdomain);
    const arabic = restaurant.defaultLanguage === 'ar';
    const icon = (size: IconSize) => `${apiOrigin}/v1/public/restaurants/${restaurant.subdomain}/icon-${size}.png?v=${iconVersion(restaurant.logoId)}`;
    return {
      // Absolute: the manifest is served from the API, but the app is the restaurant's site.
      id: `${site}/`,
      name: restaurant.name,
      short_name: restaurant.name,
      description: arabic ? `منيو ${restaurant.name} على بالهنا` : `${restaurant.name}'s menu on Bilhanah`,
      lang: restaurant.defaultLanguage,
      dir: arabic ? 'rtl' : 'ltr',
      start_url: `${site}${startPath(start)}`,
      scope: `${site}/`,
      display: 'standalone',
      background_color: IVORY,
      theme_color: restaurant.brandColor ?? TEAL,
      icons: [
        { src: icon(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
  }

  /** A square PNG: the logo (or the Bilhanah mark) centred on white. Cached in Redis per logo and size. */
  async icon(rawSubdomain: string, size: IconSize): Promise<Buffer> {
    const restaurant = await this.find(rawSubdomain);
    const cacheKey = `pwa-icon:v1:${iconVersion(restaurant.logoId)}:${size}`;
    const cached = await this.redis.getBuffer(cacheKey);
    if (cached) return cached;

    const logo = restaurant.logo ? await this.media.readImage(restaurant.logo) : null;
    const art = await sharp(logo ?? Buffer.from(BILHANAH_MARK_SVG), logo ? {} : { density: 300 })
      .resize(Math.round(size * ART_SCALE), Math.round(size * ART_SCALE), { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();
    const png = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
      .composite([{ input: art, gravity: 'centre' }])
      .png()
      .toBuffer();
    await this.redis.set(cacheKey, png, 'EX', ICON_CACHE_SECONDS);
    return png;
  }

  private async find(rawSubdomain: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { subdomain: normalizeSubdomain(rawSubdomain) },
      select: { subdomain: true, name: true, defaultLanguage: true, brandColor: true, logoId: true, logo: true },
    });
    if (!restaurant) throw restaurantNotFound();
    return restaurant;
  }
}

/** Icons change when the logo does. */
function iconVersion(logoId: string | null): string {
  return logoId ? logoId.slice(0, 8) : 'mark';
}

/** "/" or "/order/<tracking token>"; anything else opens the menu. */
function startPath(start: string | undefined): string {
  const token = start?.startsWith('/order/') ? start.slice('/order/'.length) : null;
  return token && trackingTokenSchema.safeParse(token).success ? `/order/${token}` : '/';
}
