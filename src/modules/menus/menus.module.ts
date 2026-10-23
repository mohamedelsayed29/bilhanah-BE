import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { MenusController } from './menus.controller.js';
import { MenusService } from './menus.service.js';

@Module({
  imports: [AuthModule, MediaModule],
  controllers: [MenusController],
  providers: [MenusService],
  exports: [MenusService],
})
export class MenusModule {}
