import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../infrastructure/database/database.module.js';
import { EmailModule } from '../infrastructure/email/email.module.js';
import { AppLoggerModule } from '../infrastructure/observability/logger.module.js';
import { PushModule } from '../infrastructure/push/push.module.js';
import { QueuesModule } from '../infrastructure/queues/queues.module.js';
import { RedisModule } from '../infrastructure/redis/redis.module.js';
import { StorageModule } from '../infrastructure/storage/storage.module.js';
import { VisitsService } from '../modules/analytics/visits.service.js';
import { ExpiryRemindersService } from '../modules/billing/expiry-reminders.service.js';
import { MediaService } from '../modules/media/media.service.js';
import { SupportAttachmentsService } from '../modules/support/tickets/support-attachments.service.js';
import { trackingTokensProvider } from '../modules/orders/tracking-token.js';
import { CryptoModule } from '../common/crypto/crypto.module.js';
import { PosSyncService } from '../modules/pos-sync/pos-sync.service.js';
import { EmailProcessor } from './email.processor.js';
import { PosSyncProcessor } from './pos-sync.processor.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { MaintenanceService } from './maintenance.service.js';
import { PushProcessor } from './push.processor.js';
import { ShopMaintenanceService } from './shop-maintenance.service.js';

/** Background jobs. Runs as its own process (dist/worker.js) from the API image. */
@Module({
  imports: [AppConfigModule, AppLoggerModule, CryptoModule, DatabaseModule, RedisModule, QueuesModule, StorageModule, EmailModule, PushModule],
  providers: [
    EmailProcessor,
    PushProcessor,
    trackingTokensProvider,
    MediaService,
    SupportAttachmentsService,
    ExpiryRemindersService,
    MaintenanceService,
    ShopMaintenanceService,
    VisitsService,
    MaintenanceProcessor,
    PosSyncService,
    PosSyncProcessor,
  ],
})
export class WorkerModule {}
