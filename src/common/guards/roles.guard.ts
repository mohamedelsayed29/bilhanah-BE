import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COMMON_ERROR_CODES, type UserRole } from '@bilhanah/contracts';
import type { AuthContext } from '../decorators/current-auth.decorator.js';

const REQUIRED_ROLES = 'requiredRoles';

/** Restricts a route to the given roles. Use after AccessTokenGuard. */
export const RequireRole = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const auth = context.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
    if (auth && roles.includes(auth.role)) return true;
    throw new ForbiddenException({
      code: COMMON_ERROR_CODES.FORBIDDEN,
      message: 'You do not have permission to do this.',
    });
  }
}
