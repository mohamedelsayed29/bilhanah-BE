import { Global, Module } from '@nestjs/common';
import { PaymobService } from './paymob.service.js';

@Global()
@Module({
  providers: [PaymobService],
  exports: [PaymobService],
})
export class PaymobModule {}
