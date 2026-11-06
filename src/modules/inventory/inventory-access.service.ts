import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { INVENTORY_ERROR_CODES as CODES, type Permission } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import { zonedInstant } from '../attendance/attendance-rules.js';
import { BranchScopeService, type Scope } from '../branches/branch-scope.service.js';
import { effectiveFeatures } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

export type Tx = Prisma.TransactionClient;

export const fail = (status: 'bad' | 'forbidden' | 'conflict' | 'notFound', code: string, message: string, details?: Record<string, unknown>) => {
  const body = { code, message, ...(details && { details }) };
  return status === 'bad' ? new BadRequestException(body) : status === 'forbidden' ? new ForbiddenException(body) : status === 'conflict' ? new ConflictException(body) : new NotFoundException(body);
};

export const ingredientNotFound = () => fail('notFound', CODES.INGREDIENT_NOT_FOUND, 'Ingredient not found.');
export const supplierNotFound = () => fail('notFound', CODES.SUPPLIER_NOT_FOUND, 'Supplier not found.');
export const variantNotFound = () => fail('notFound', CODES.VARIANT_NOT_FOUND, 'Dish size not found.');

/** The caller's scope, and whether they see costs. */
export type InventoryScope = Scope & { costs: boolean };

/**
 * Who may use inventory: the plan must include it (Full Experience) and the restaurant must have
 * access; the caller must hold one of the route's permissions. Without inventory.costs every cost
 * field comes back null.
 */
@Injectable()
export class InventoryAccess {
  constructor(
    private readonly scopes: BranchScopeService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** The caller's scope; refuses without the plan (409) or any of the permissions (403). */
  async scope(userId: string, ...anyOf: Permission[]): Promise<InventoryScope> {
    const scope = await this.scopes.resolve(userId);
    await this.requirePlan(scope.restaurant);
    if (anyOf.length && !anyOf.some((permission) => scope.permissions.has(permission))) this.scopes.require(scope, anyOf[0]!);
    return { ...scope, costs: scope.permissions.has('inventory.costs') };
  }

  require(scope: Scope, ...permissions: Permission[]): void {
    this.scopes.require(scope, ...permissions);
  }

  async planIncludes(restaurant: { id: string; status: Scope['restaurant']['status'] }): Promise<boolean> {
    // The same rule as KitchenContext.features, so staff screens and the routes agree.
    return effectiveFeatures(await this.subscriptions.accessFor(restaurant)).inventory;
  }

  async requirePlan(restaurant: { id: string; status: Scope['restaurant']['status'] }): Promise<void> {
    if (!(await this.planIncludes(restaurant))) {
      throw fail('conflict', CODES.UNAVAILABLE, 'Inventory is part of the Full Experience plan.');
    }
  }

  get branches(): BranchScopeService {
    return this.scopes;
  }
}

/** Local days in the restaurant's time zone, both inclusive, as an instant range. */
export function localDayRange(timeZone: string, from?: string | null, to?: string | null): Prisma.DateTimeFilter {
  const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { ...(from && { gte: zonedInstant(from, '00:00', timeZone) }), ...(to && { lt: zonedInstant(nextDay(to), '00:00', timeZone) }) };
}
