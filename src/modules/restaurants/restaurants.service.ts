import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAIN_BRANCH_SLUG,
  type PublicBranch,
  DEFAULT_MENU_THEME,
  isMenuTheme,
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
import { type Branch, Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MediaService } from '../media/media.service.js';
import { MenusService } from '../menus/menus.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import { BranchScopeService, branchNotFound } from '../branches/branch-scope.service.js';
import { orderingSettings } from '../branches/branches.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

const withBranding = { logo: true, cover: true } satisfies Prisma.RestaurantInclude;
type RestaurantRow = Prisma.RestaurantGetPayload<{ include: typeof withBranding }>;

/** Settings that belong to a branch; sent to /restaurants/mine they apply to the main branch. */
const MAIN_BRANCH_FIELDS = ['openingHours', 'orderingEnabled', 'acceptsDineIn', 'acceptsPickup', 'ordersPaused'] as const;
/** Contact details a single-branch restaurant keeps in step with its only branch. */
const MIRRORED_FIELDS = ['phone', 'city', 'address', 'whatsappNumber'] as const;

const hoursOf = (branch: Branch) => branch.openingHours as OpeningHours | null;

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
    private readonly scopes: BranchScopeService,
    private readonly recommendations: RecommendationsService,
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

  /** Creates the owner's restaurant with its main branch, and starts the automatic trial. */
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
        await tx.branch.create({
          data: {
            restaurantId: created.id,
            name: created.defaultLanguage === 'en' ? 'Main branch' : 'الفرع الرئيسي',
            slug: MAIN_BRANCH_SLUG,
            isMain: true,
            phone: created.phone,
            whatsappNumber: created.whatsappNumber,
            city: created.city,
            address: created.address,
            sortOrder: 0,
          },
        });
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
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true, status: true } });
    if (!restaurant) throw notFound();
    const main = await this.scopes.mainBranch(restaurant.id);
    if (restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED,
        message: 'This restaurant is suspended. Please contact Bilhanah support.',
      });
    }
    if ((input.acceptsDineIn ?? main.acceptsDineIn) === false && (input.acceptsPickup ?? main.acceptsPickup) === false) {
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
    const { openingHours, orderingEnabled, acceptsDineIn, acceptsPickup, ordersPaused, ...fields } = input;
    const branchCount = await this.prisma.branch.count({ where: { restaurantId: restaurant.id } });
    const mirrored = branchCount === 1 ? Object.fromEntries(MIRRORED_FIELDS.flatMap((key) => (fields[key] !== undefined ? [[key, fields[key]]] : []))) : {};
    const branchData: Prisma.BranchUpdateInput = {
      ...mirrored,
      ...(openingHours !== undefined && { openingHours: openingHours ?? Prisma.DbNull }),
      ...(orderingEnabled !== undefined && { orderingEnabled }),
      ...(acceptsDineIn !== undefined && { acceptsDineIn }),
      ...(acceptsPickup !== undefined && { acceptsPickup }),
      ...(ordersPaused !== undefined && { ordersPaused }),
    };
    const [updated] = await this.prisma.$transaction([
      this.prisma.restaurant.update({ where: { id: restaurant.id }, data: fields, include: withBranding }),
      ...(Object.keys(branchData).length ? [this.prisma.branch.update({ where: { id: main.id }, data: branchData })] : []),
    ]);
    const view = await this.toOwnerRestaurant(updated);
    const orderingChanged = MAIN_BRANCH_FIELDS.slice(1).some((key) => key in input);
    if (orderingChanged) this.realtime.emitRestaurantUpdated(restaurant.id, main.id, view.ordering);
    return view;
  }

  /**
   * Resolves a restaurant for its public address. Expired and suspended
   * restaurants return the same neutral "temporarily unavailable" view.
   */
  async findPublic(rawSubdomain: string, branchSlug?: string): Promise<PublicRestaurant> {
    return (await this.resolvePublic(rawSubdomain, branchSlug)).view;
  }

  /** The restaurant and the chosen branch's menu (main branch by default) in one response, for a diner's phone. */
  async findPublicMenu(rawSubdomain: string, branchSlug?: string): Promise<PublicMenuResponse> {
    const { row, branch, view } = await this.resolvePublic(rawSubdomain, branchSlug);
    if (view.availability !== 'AVAILABLE') return { restaurant: view, categories: [], recommendations: [] };
    const categories = await this.menus.publicCategories(row.id, row.menuVersion, branch.id);
    // Suggestions follow this branch's menu: only orderable dishes are offered.
    return { restaurant: view, categories, recommendations: await this.recommendations.publicFor(row.id, categories) };
  }

  private async resolvePublic(rawSubdomain: string, branchSlug?: string): Promise<{ row: RestaurantRow; branch: Branch; view: PublicRestaurant }> {
    const subdomain = normalizeSubdomain(rawSubdomain);
    if (subdomainProblem(subdomain)) throw notFound();
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain }, include: withBranding });
    if (!restaurant) throw notFound();
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const slug = branchSlug?.trim().toLowerCase();
    // Archived and unknown branches look the same to diners.
    const branch = slug ? branches.find((candidate) => candidate.slug === slug) : branches.find((candidate) => candidate.isMain);
    if (!branch) throw branchNotFound();
    return { row: restaurant, branch, view: await this.toPublicRestaurant(restaurant, branch, branches) };
  }

  private async toPublicRestaurant(restaurant: RestaurantRow, branch: Branch, branches: Branch[]): Promise<PublicRestaurant> {
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
      phone: branch.phone,
      city: branch.city,
      address: branch.address,
      whatsappNumber: branch.whatsappNumber,
      websiteUrl: restaurant.websiteUrl,
      facebookUrl: restaurant.facebookUrl,
      instagramUrl: restaurant.instagramUrl,
      timezone: restaurant.timezone,
      ordering: {
        accepting: access.features.ordering && branch.orderingEnabled && !branch.ordersPaused,
        dineIn: branch.acceptsDineIn,
        pickup: branch.acceptsPickup,
        serviceRequests: access.features.ordering && restaurant.serviceRequestsEnabled,
      },
      ...this.branding(restaurant, branch),
      branch: this.toPublicBranch(branch, access.features.ordering),
      branches: branches.map((candidate) => this.toPublicBranch(candidate, access.features.ordering)),
    };
  }

  private toPublicBranch(branch: Branch, orderingIncluded: boolean): PublicBranch {
    return {
      slug: branch.slug,
      name: branch.name,
      isMain: branch.isMain,
      phone: branch.phone,
      whatsappNumber: branch.whatsappNumber,
      city: branch.city,
      address: branch.address,
      mapUrl: branch.mapUrl,
      openingHours: hoursOf(branch),
      acceptingOrders: orderingIncluded && branch.orderingEnabled && !branch.ordersPaused,
    };
  }

  private branding(restaurant: RestaurantRow, branch: Branch): RestaurantBranding {
    return {
      logo: restaurant.logo ? this.media.toImageSet(restaurant.logo) : null,
      cover: restaurant.cover ? this.media.toImageSet(restaurant.cover) : null,
      brandColor: restaurant.brandColor,
      openingHours: hoursOf(branch),
      // A theme removed in a later release falls back to the default.
      menuTheme: isMenuTheme(restaurant.menuTheme) ? restaurant.menuTheme : DEFAULT_MENU_THEME,
    };
  }

  private async toOwnerRestaurant(restaurant: RestaurantRow, now = new Date()): Promise<OwnerRestaurant> {
    const [access, main, branchCount] = await Promise.all([
      this.subscriptions.accessFor(restaurant, now),
      this.scopes.mainBranch(restaurant.id),
      this.prisma.branch.count({ where: { restaurantId: restaurant.id, isActive: true } }),
    ]);
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
      ordering: orderingSettings(main, access.features.ordering),
      serviceRequests: {
        enabled: restaurant.serviceRequestsEnabled,
        cooldownSeconds: restaurant.serviceRequestCooldownSeconds,
        hourlyLimit: restaurant.serviceRequestHourlyLimit,
      },
      orderPrepMinutes: restaurant.orderPrepMinutes,
      mainBranchId: main.id,
      branchCount,
      ...this.branding(restaurant, main),
    };
  }
}
