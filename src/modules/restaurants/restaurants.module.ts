import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { MenusModule } from '../menus/menus.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PublicRestaurantsController } from './public-restaurants.controller.js';
import { RestaurantsController } from './restaurants.controller.js';
import { RestaurantsService } from './restaurants.service.js';

@Module({
  imports: [AuthModule, SubscriptionsModule, MediaModule, MenusModule, RealtimeModule, RecommendationsModule],
  controllers: [RestaurantsController, PublicRestaurantsController],
  providers: [RestaurantsService],
})
export class RestaurantsModule {}
