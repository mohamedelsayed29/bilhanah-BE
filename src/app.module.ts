import { Module } from '@nestjs/common';
import { ReportsModule } from './modules/reports/reports.module.js';
import { APP_FILTER } from '@nestjs/core';
import { CryptoModule } from './common/crypto/crypto.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { EmailModule } from './infrastructure/email/email.module.js';
import { AppLoggerModule } from './infrastructure/observability/logger.module.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';
import { PaymobModule } from './infrastructure/paymob/paymob.module.js';
import { PushModule } from './infrastructure/push/push.module.js';
import { QueuesModule } from './infrastructure/queues/queues.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { BranchesModule } from './modules/branches/branches.module.js';
import { BranchScopeModule } from './modules/branches/branch-scope.service.js';
import { ContactModule } from './modules/contact/contact.module.js';
import { KitchenModule } from './modules/kitchen/kitchen.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { SupportModule } from './modules/support/support.module.js';
import { MenusModule } from './modules/menus/menus.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PwaModule } from './modules/pwa/pwa.module.js';
import { ShopModule } from './modules/shop/shop.module.js';
import { PlansModule } from './modules/plans/plans.module.js';
import { RestaurantsModule } from './modules/restaurants/restaurants.module.js';
import { RestaurantServicesModule } from './modules/services/services.module.js';
import { TablesModule } from './modules/tables/tables.module.js';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module.js';
import { RecommendationsModule } from './modules/recommendations/recommendations.module.js';
import { KitchenDisplayModule } from './modules/kitchen-display/kitchen-display.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { CashModule } from './modules/cash/cash.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { TableSessionsModule } from './modules/table-sessions/table-sessions.module.js';

@Module({
  imports: [
    ReportsModule,
    AppConfigModule,
    AppLoggerModule,
    CryptoModule,
    DatabaseModule,
    RedisModule,
    QueuesModule,
    PushModule,
    PaymobModule,
    StorageModule,
    EmailModule,
    ObservabilityModule,
    AuthModule,
    BranchScopeModule,
    BranchesModule,
    RestaurantsModule,
    RestaurantServicesModule,
    MediaModule,
    SupportModule,
    MenusModule,
    PlansModule,
    ContactModule,
    BillingModule,
    AdminModule,
    TablesModule,
    ServiceRequestsModule,
    RecommendationsModule,
    KitchenDisplayModule,
    AttendanceModule,
    CashModule,
    InventoryModule,
    ReviewsModule,
    LoyaltyModule,
    PosModule,
    TableSessionsModule,
    OrdersModule,
    KitchenModule,
    PwaModule,
    ShopModule,
    PaymentsModule,
    AnalyticsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
