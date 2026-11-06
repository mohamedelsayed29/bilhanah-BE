import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { ServiceGuard } from './service.guard.js';
import { RestaurantServicesController } from './services.controller.js';
import { RestaurantServicesService } from './services.service.js';

/** Global, so any module can guard its routes with @RequireService without importing this one. */
@Global()
@Module({
  imports: [AuthModule, SubscriptionsModule, AuditModule],
  controllers: [RestaurantServicesController],
  providers: [RestaurantServicesService, ServiceGuard],
  exports: [RestaurantServicesService, ServiceGuard],
})
export class RestaurantServicesModule {}
