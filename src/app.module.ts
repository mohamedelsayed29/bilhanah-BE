import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CryptoModule } from './common/crypto/crypto.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { EmailModule } from './infrastructure/email/email.module.js';
import { AppLoggerModule } from './infrastructure/observability/logger.module.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';
import { PushModule } from './infrastructure/push/push.module.js';
import { QueuesModule } from './infrastructure/queues/queues.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { ContactModule } from './modules/contact/contact.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { MenusModule } from './modules/menus/menus.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PwaModule } from './modules/pwa/pwa.module.js';
import { PlansModule } from './modules/plans/plans.module.js';
import { RestaurantsModule } from './modules/restaurants/restaurants.module.js';
import { TablesModule } from './modules/tables/tables.module.js';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    CryptoModule,
    DatabaseModule,
    RedisModule,
    QueuesModule,
    PushModule,
    StorageModule,
    EmailModule,
    ObservabilityModule,
    AuthModule,
    RestaurantsModule,
    MediaModule,
    MenusModule,
    PlansModule,
    ContactModule,
    BillingModule,
    AdminModule,
    TablesModule,
    OrdersModule,
    PwaModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
