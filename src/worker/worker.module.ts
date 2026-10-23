import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../infrastructure/database/database.module.js';
import { EmailModule } from '../infrastructure/email/email.module.js';
import { AppLoggerModule } from '../infrastructure/observability/logger.module.js';
import { QueuesModule } from '../infrastructure/queues/queues.module.js';
import { RedisModule } from '../infrastructure/redis/redis.module.js';
import { StorageModule } from '../infrastructure/storage/storage.module.js';
import { MediaService } from '../modules/media/media.service.js';
import { EmailProcessor } from './email.processor.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { MaintenanceService } from './maintenance.service.js';

/** Background jobs. Runs as its own process (dist/worker.js) from the API image. */
@Module({
  imports: [AppConfigModule, AppLoggerModule, DatabaseModule, RedisModule, QueuesModule, StorageModule, EmailModule],
  providers: [EmailProcessor, MediaService, MaintenanceService, MaintenanceProcessor],
})
export class WorkerModule {}
