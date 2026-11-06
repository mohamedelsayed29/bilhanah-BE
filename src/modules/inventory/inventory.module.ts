import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { InventoryAccess } from './inventory-access.service.js';
import { InventoryCatalogService } from './inventory-catalog.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryEngine } from './inventory-engine.service.js';
import { InventoryOperationsService } from './inventory-operations.service.js';
import { InventoryOrdersService } from './inventory-orders.service.js';
import { InventoryReportsService } from './inventory-reports.service.js';

@Module({
  imports: [AuthModule, AuditModule, SubscriptionsModule],
  controllers: [InventoryController],
  providers: [InventoryAccess, InventoryEngine, InventoryCatalogService, InventoryOperationsService, InventoryReportsService, InventoryOrdersService],
  exports: [InventoryOrdersService],
})
export class InventoryModule {}
