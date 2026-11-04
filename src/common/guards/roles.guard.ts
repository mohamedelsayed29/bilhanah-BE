import { applyDecorators, type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COMMON_ERROR_CODES, type Permission, RESTAURANT_ROLES, type UserRole } from '@bilhanah/contracts';
import type { AuthContext } from '../decorators/current-auth.decorator.js';

const REQUIRED_ROLES = 'requiredRoles';
const REQUIRED_PERMISSIONS = 'requiredPermissions';

/** Restricts a route to the given roles. Use after AccessTokenGuard. Prefer RequirePermission for restaurant routes. */
export const RequireRole = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

/**
 * Restricts a route to callers holding every one of the permissions (see permissions.ts), read
 * from the database on each request, so a role change applies at once. Use after AccessTokenGuard.
 */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, { all: permissions });

/** Restricts a route to callers holding at least one of the permissions. */
export const RequireAnyPermission = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, { any: permissions });

/**
 * Any account of a restaurant (owner or staff, not administrators), whatever its permissions, for
 * what every screen reads (its branches). Overrides a permission set on the class.
 */
export const RestaurantMember = () => applyDecorators(SetMetadata(REQUIRED_ROLES, [...RESTAURANT_ROLES]), SetMetadata(REQUIRED_PERMISSIONS, {}));

const forbidden = () => new ForbiddenException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have permission to do this.' });

/** Checks RequireRole and RequirePermission (the method's, or else the class's). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(REQUIRED_ROLES, targets);
    const permissions = this.reflector.getAllAndOverride<{ all?: Permission[]; any?: Permission[] } | undefined>(REQUIRED_PERMISSIONS, targets);
    if (!roles?.length && !permissions) return true;
    const auth = context.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
    if (!auth) throw forbidden();
    if (roles?.length && !roles.includes(auth.role)) throw forbidden();
    if (permissions?.all && !permissions.all.every((permission) => auth.permissions.has(permission))) throw forbidden();
    if (permissions?.any && !permissions.any.some((permission) => auth.permissions.has(permission))) throw forbidden();
    return true;
  }
}
