import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PublicRestaurantsController } from './public-restaurants.controller.js';
import { RestaurantsController } from './restaurants.controller.js';
import { RestaurantsService } from './restaurants.service.js';

@Module({
  imports: [AuthModule, SubscriptionsModule],
  controllers: [RestaurantsController, PublicRestaurantsController],
  providers: [RestaurantsService],
})
export class RestaurantsModule {}
