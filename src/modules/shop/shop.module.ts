import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { standOrderTokensProvider } from '../orders/tracking-token.js';
import { AdminShopController, ShopController } from './shop.controller.js';
import { ShopService } from './shop.service.js';
import { StandOrdersService } from './stand-orders.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ShopController, AdminShopController],
  providers: [ShopService, StandOrdersService, standOrderTokensProvider],
  exports: [ShopService],
})
export class ShopModule {}
