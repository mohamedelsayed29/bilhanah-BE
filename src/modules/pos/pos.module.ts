import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PosOrdersService } from './pos-orders.service.js';
import { PosTerminalService } from './pos-terminal.service.js';
import { PosReportsService } from './pos-reports.service.js';
import { PosIntegrationsService } from './pos-integrations.service.js';
import { PosIntegrationsController, PosWebhooksController } from './pos-integrations.controller.js';
import { PosSyncModule } from '../pos-sync/pos-sync.module.js';
import { PosAccessService } from './pos-access.service.js';
import { AdminPosController, PosController } from './pos.controller.js';
import { PosService } from './pos.service.js';

/** Point of sale (docs/POS.md). Later POS parts check access through PosAccessService. */
@Module({
  imports: [AuthModule, AuditModule, SubscriptionsModule, OrdersModule, PosSyncModule],
  controllers: [PosController, AdminPosController, PosIntegrationsController, PosWebhooksController],
  providers: [PosAccessService, PosService, PosOrdersService, PosTerminalService, PosIntegrationsService, PosReportsService],
  exports: [PosAccessService],
})
export class PosModule {}
