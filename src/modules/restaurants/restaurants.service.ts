import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AUTH_ERROR_CODES,
  COMMON_ERROR_CODES,
  ORDER_ERROR_CODES,
  type createRestaurantSchema,
  normalizeSubdomain,
  type OpeningHours,
  type OwnerRestaurant,
  type PublicMenuResponse,
  type PublicRestaurant,
  type RestaurantBranding,
  RESTAURANT_ERROR_CODES,
  type SubdomainAvailability,
  subdomainProblem,
  type updateRestaurantSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MediaService } from '../media/media.service.js';
import { MenusService } from '../menus/menus.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

const withBranding = { logo: true, cover: true } satisfies Prisma.RestaurantInclude;
type RestaurantRow = Prisma.RestaurantGetPayload<{ include: typeof withBranding }>;

const notFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

const alreadyExists = () =>
  new ConflictException({
    code: RESTAURANT_ERROR_CODES.RESTAURANT_ALREADY_EXISTS,
    message: 'This account already has a restaurant.',
  });

const subdomainTaken = () =>
  new ConflictException({
    code: RESTAURANT_ERROR_CODES.SUBDOMAIN_TAKEN,
    message: 'This address is already taken. Please choose another.',
  });

/**
 * Restaurant onboarding and settings. Owner operations are always scoped by
 * the authenticated owner's id; no route accepts a restaurant id.
 */
@Injectable()
export class RestaurantsService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly media: MediaService,
    private readonly menus: MenusService,
    private readonly realtime: RealtimeService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  async checkSubdomain(raw: string): Promise<SubdomainAvailability> {
    const subdomain = normalizeSubdomain(raw);
    const problem = subdomainProblem(subdomain);
    if (problem) return { subdomain, available: false, reason: problem };
    const existing = await this.prisma.restaurant.findUnique({ where: { subdomain }, select: { id: true } });
    return existing ? { subdomain, available: false, reason: 'TAKEN' } : { subdomain, available: true };
  }

  /** Creates the owner's only restaurant and starts the automatic trial. */
  async create(ownerId: string, input: z.output<typeof createRestaurantSchema>): Promise<OwnerRestaurant> {
    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { emailVerifiedAt: true, restaurant: { select: { id: true } } },
    });
    if (!owner.emailVerifiedAt) {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
        message: 'Confirm your email address before creating a restaurant.',
      });
    }
    if (owner.restaurant) throw alreadyExists();

    const now = new Date();
    try {
      const restaurant = await this.prisma.$transaction(async (tx) => {
        const created = await tx.restaurant.create({ data: { ...input, ownerId }, include: withBranding });
        await this.subscriptions.startTrial(tx, created.id, now);
        return created;
      });
      return this.toOwnerRestaurant(restaurant, now);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a race: this owner created a restaurant concurrently, or the subdomain was just claimed.
      const mine = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true } });
      throw mine ? alreadyExists() : subdomainTaken();
    }
  }

  async findMine(ownerId: string): Promise<OwnerRestaurant> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, include: withBranding });
    if (!restaurant) throw notFound();
    return this.toOwnerRestaurant(restaurant);
  }

  async updateMine(ownerId: string, input: z.output<typeof updateRestaurantSchema>): Promise<OwnerRestaurant> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true, status: true, acceptsDineIn: true, acceptsPickup: true },
    });
    if (!restaurant) throw notFound();
    if (restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED,
        message: 'This restaurant is suspended. Please contact Bilhanah support.',
      });
    }
    if ((input.acceptsDineIn ?? restaurant.acceptsDineIn) === false && (input.acceptsPickup ?? restaurant.acceptsPickup) === false) {
      throw new BadRequestException({
        code: COMMON_ERROR_CODES.VALIDATION_FAILED,
        message: 'Keep dine-in or pickup on.',
        details: [{ path: 'acceptsPickup', code: 'custom', message: 'Keep dine-in or pickup on.' }],
      });
    }
    if (input.orderingEnabled === true && !(await this.subscriptions.accessFor(restaurant)).features.ordering) {
      throw new ConflictException({
        code: ORDER_ERROR_CODES.ORDERING_UNAVAILABLE,
        message: 'Your plan does not include ordering. Upgrade to take orders.',
      });
    }
    if (input.logoId) await this.media.assertUsable(restaurant.id, input.logoId, 'LOGO');
    if (input.coverId) await this.media.assertUsable(restaurant.id, input.coverId, 'COVER');
    const { openingHours, ...fields } = input;
    const updated = await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        ...fields,
        ...(openingHours !== undefined && { openingHours: openingHours ?? Prisma.DbNull }),
      },
      include: withBranding,
    });
    const view = await this.toOwnerRestaurant(updated);
    const orderingChanged = ['orderingEnabled', 'acceptsDineIn', 'acceptsPickup', 'ordersPaused'].some((key) => key in input);
    if (orderingChanged) this.realtime.emitRestaurantUpdated(restaurant.id, view.ordering);
    return view;
  }

  /**
   * Resolves a restaurant for its public address. Expired and suspended
   * restaurants return the same neutral "temporarily unavailable" view.
   */
  async findPublic(rawSubdomain: string): Promise<PublicRestaurant> {
    return (await this.resolvePublic(rawSubdomain)).view;
  }

  /** The restaurant and its menu in one response, for a diner's phone. */
  async findPublicMenu(rawSubdomain: string): Promise<PublicMenuResponse> {
    const { row, view } = await this.resolvePublic(rawSubdomain);
    if (view.availability !== 'AVAILABLE') return { restaurant: view, categories: [] };
    return { restaurant: view, categories: await this.menus.publicCategories(row.id, row.menuVersion) };
  }

  private async resolvePublic(rawSubdomain: string): Promise<{ row: RestaurantRow; view: PublicRestaurant }> {
    const subdomain = normalizeSubdomain(rawSubdomain);
    if (subdomainProblem(subdomain)) throw notFound();
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain }, include: withBranding });
    if (!restaurant) throw notFound();
    return { row: restaurant, view: await this.toPublicRestaurant(restaurant) };
  }

  private async toPublicRestaurant(restaurant: RestaurantRow): Promise<PublicRestaurant> {
    const access = await this.subscriptions.accessFor(restaurant);
    if (!hasAccess(access)) {
      return {
        availability: 'TEMPORARILY_UNAVAILABLE',
        subdomain: restaurant.subdomain,
        name: restaurant.name,
        defaultLanguage: restaurant.defaultLanguage,
      };
    }
    return {
      availability: 'AVAILABLE',
      subdomain: restaurant.subdomain,
      name: restaurant.name,
      defaultLanguage: restaurant.defaultLanguage,
      phone: restaurant.phone,
      city: restaurant.city,
      address: restaurant.address,
      whatsappNumber: restaurant.whatsappNumber,
      websiteUrl: restaurant.websiteUrl,
      facebookUrl: restaurant.facebookUrl,
      instagramUrl: restaurant.instagramUrl,
      timezone: restaurant.timezone,
      ordering: {
        accepting: access.features.ordering && restaurant.orderingEnabled && !restaurant.ordersPaused,
        dineIn: restaurant.acceptsDineIn,
        pickup: restaurant.acceptsPickup,
      },
      ...this.branding(restaurant),
    };
  }

  private branding(restaurant: RestaurantRow): RestaurantBranding {
    return {
      logo: restaurant.logo ? this.media.toImageSet(restaurant.logo) : null,
      cover: restaurant.cover ? this.media.toImageSet(restaurant.cover) : null,
      brandColor: restaurant.brandColor,
      // Validated by openingHoursSchema on the way in.
      openingHours: restaurant.openingHours as OpeningHours | null,
    };
  }

  private async toOwnerRestaurant(restaurant: RestaurantRow, now = new Date()): Promise<OwnerRestaurant> {
    const access = await this.subscriptions.accessFor(restaurant, now);
    return {
      id: restaurant.id,
      name: restaurant.name,
      subdomain: restaurant.subdomain,
      publicUrl: this.urlTemplate.replace('{subdomain}', restaurant.subdomain),
      contactName: restaurant.contactName,
      phone: restaurant.phone,
      city: restaurant.city,
      address: restaurant.address,
      defaultLanguage: restaurant.defaultLanguage,
      timezone: restaurant.timezone,
      whatsappNumber: restaurant.whatsappNumber,
      websiteUrl: restaurant.websiteUrl,
      facebookUrl: restaurant.facebookUrl,
      instagramUrl: restaurant.instagramUrl,
      createdAt: restaurant.createdAt.toISOString(),
      access,
      ordering: {
        included: access.features.ordering,
        enabled: restaurant.orderingEnabled,
        acceptsDineIn: restaurant.acceptsDineIn,
        acceptsPickup: restaurant.acceptsPickup,
        paused: restaurant.ordersPaused,
      },
      ...this.branding(restaurant),
    };
  }
}
