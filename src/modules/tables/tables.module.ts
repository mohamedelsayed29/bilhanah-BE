import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PublicTablesController, TablesController } from './tables.controller.js';
import { TablesService } from './tables.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TablesController, PublicTablesController],
  providers: [TablesService],
})
export class TablesModule {}
