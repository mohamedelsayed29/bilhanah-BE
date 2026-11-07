import { Module } from '@nestjs/common';
import { PosSyncService } from './pos-sync.service.js';

/** External POS sync (docs/POS.md, task 6). Orders queue jobs here; the worker runs them. */
@Module({
  providers: [PosSyncService],
  exports: [PosSyncService],
})
export class PosSyncModule {}
