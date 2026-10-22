import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { EmailModule } from './infrastructure/email/email.module.js';
import { AppLoggerModule } from './infrastructure/observability/logger.module.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';
import { QueuesModule } from './infrastructure/queues/queues.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { RestaurantsModule } from './modules/restaurants/restaurants.module.js';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DatabaseModule,
    RedisModule,
    QueuesModule,
    EmailModule,
    ObservabilityModule,
    AuthModule,
    RestaurantsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
