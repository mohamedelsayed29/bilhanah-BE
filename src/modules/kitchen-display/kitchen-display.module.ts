import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { KitchenStationsController } from './kitchen-stations.controller.js';
import { KitchenStationsService } from './kitchen-stations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [KitchenStationsController],
  providers: [KitchenStationsService],
  exports: [KitchenStationsService],
})
export class KitchenDisplayModule {}
