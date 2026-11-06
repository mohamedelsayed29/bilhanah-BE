import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RestaurantServiceKey } from '@bilhanah/contracts';
import type { AuthContext } from '../../common/decorators/current-auth.decorator.js';
import { RestaurantServicesService } from './services.service.js';

const REQUIRED_SERVICE = 'requiredService';

/**
 * Refuses (409 SERVICE_INACTIVE) a restaurant route while the restaurant has the service off.
 * Use after AccessTokenGuard with ServiceGuard; the method's service overrides the class's.
 */
export const RequireService = (service: RestaurantServiceKey) => SetMetadata(REQUIRED_SERVICE, service);

@Injectable()
export class ServiceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly services: RestaurantServicesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const service = this.reflector.getAllAndOverride<RestaurantServiceKey | undefined>(REQUIRED_SERVICE, [context.getHandler(), context.getClass()]);
    if (!service) return true;
    const auth = context.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
    // Without a signed-in restaurant account the route's own checks answer (401/403/404).
    const restaurantId = auth ? await this.services.restaurantOf(auth.userId) : null;
    if (restaurantId) await this.services.require(restaurantId, service);
    return true;
  }
}
