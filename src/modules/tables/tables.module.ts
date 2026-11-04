import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReservationsService } from './reservations.service.js';
import { PublicTablesController, ReservationsController, TableAreasController, TablesController } from './tables.controller.js';
import { TableAreasService } from './table-areas.service.js';
import { TablesService } from './tables.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TablesController, TableAreasController, ReservationsController, PublicTablesController],
  providers: [TablesService, TableAreasService, ReservationsService],
})
export class TablesModule {}
