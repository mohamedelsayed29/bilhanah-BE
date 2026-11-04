import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PublicServiceRequestsController, ServiceRequestsController } from './service-requests.controller.js';
import { ServiceRequestsService } from './service-requests.service.js';

@Module({
  imports: [AuthModule, RealtimeModule, SubscriptionsModule],
  controllers: [ServiceRequestsController, PublicServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
