import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createKitchenAccountSchema,
  KITCHEN_ERROR_CODES,
  KITCHEN_LIMITS,
  type KitchenAccount,
  type KitchenContext,
  RESTAURANT_ERROR_CODES,
  type updateKitchenAccountSchema,
} from '@bilhanah/contracts';
import type { User } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

const restaurantNotFound = () =>
  new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });

const accountNotFound = () =>
  new NotFoundException({ code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_NOT_FOUND, message: 'Kitchen account not found.' });

/** Kitchen accounts: made by a restaurant's owner, signed in on the kitchen's screens. */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(ownerId: string): Promise<KitchenAccount[]> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const users = await this.prisma.user.findMany({
      where: { role: 'KITCHEN', staffRestaurantId: restaurantId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(users.map((user) => this.toAccount(user)));
  }

  async create(ownerId: string, input: z.output<typeof createKitchenAccountSchema>): Promise<KitchenAccount> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const count = await this.prisma.user.count({ where: { role: 'KITCHEN', staffRestaurantId: restaurantId } });
    if (count >= KITCHEN_LIMITS.accounts) {
      throw new ConflictException({
        code: KITCHEN_ERROR_CODES.KITCHEN_ACCOUNT_LIMIT_REACHED,
        message: `A restaurant can have up to ${KITCHEN_LIMITS.accounts} kitchen accounts.`,
      });
    }
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          role: 'KITCHEN',
          staffRestaurantId: restaurantId,
          // The owner chose the address; nobody has to confirm it.
          emailVerifiedAt: new Date(),
        },
      });
      return await this.toAccount(user);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({ code: KITCHEN_ERROR_CODES.EMAIL_TAKEN, message: 'Another account already uses this email.' });
    }
  }

  async update(ownerId: string, id: string, input: z.output<typeof updateKitchenAccountSchema>): Promise<KitchenAccount> {
    await this.findOwned(ownerId, id);
    const now = new Date();
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined && { fullName: input.fullName }),
          ...(input.active !== undefined && { status: input.active ? 'ACTIVE' : 'SUSPENDED' }),
        },
      }),
      ...(input.active === false
        ? [this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'REVOKED_BY_USER' } })]
        : []),
    ]);
    return this.toAccount(user);
  }

  /** Sets a new password and signs every screen using the account out. */
  async setPassword(ownerId: string, id: string, password: string): Promise<void> {
    await this.findOwned(ownerId, id);
    const now = new Date();
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: now } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'PASSWORD_RESET' } }),
    ]);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.findOwned(ownerId, id);
    // Sessions cascade with the user.
    await this.prisma.user.delete({ where: { id } });
  }

  async context(userId: string): Promise<KitchenContext> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { staffRestaurant: true } });
    const restaurant = user?.staffRestaurant;
    if (!restaurant) throw restaurantNotFound();
    const access = await this.subscriptions.accessFor(restaurant);
    return {
      restaurant: { name: restaurant.name, subdomain: restaurant.subdomain },
      ordering: {
        included: access.features.ordering,
        enabled: restaurant.orderingEnabled,
        acceptsDineIn: restaurant.acceptsDineIn,
        acceptsPickup: restaurant.acceptsPickup,
        paused: restaurant.ordersPaused,
      },
    };
  }

  private async restaurantIdFor(ownerId: string): Promise<string> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true } });
    if (!restaurant) throw restaurantNotFound();
    return restaurant.id;
  }

  /** Other restaurants' accounts look unknown. */
  private async findOwned(ownerId: string, id: string): Promise<void> {
    const restaurantId = await this.restaurantIdFor(ownerId);
    const found = await this.prisma.user.count({ where: { id, role: 'KITCHEN', staffRestaurantId: restaurantId } });
    if (!found) throw accountNotFound();
  }

  private async toAccount(user: User): Promise<KitchenAccount> {
    const lastSession = await this.prisma.session.findFirst({
      where: { userId: user.id, lastUsedAt: { not: null } },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    });
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      active: user.status === 'ACTIVE',
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: lastSession?.lastUsedAt?.toISOString() ?? null,
    };
  }
}
