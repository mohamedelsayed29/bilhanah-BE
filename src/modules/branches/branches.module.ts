import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MenusModule } from '../menus/menus.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { BranchesController } from './branches.controller.js';
import { BranchesService } from './branches.service.js';

@Module({
  imports: [AuthModule, MenusModule, RealtimeModule, SubscriptionsModule],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
