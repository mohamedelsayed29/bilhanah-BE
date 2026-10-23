import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PwaController } from './pwa.controller.js';
import { PwaService } from './pwa.service.js';

@Module({
  imports: [MediaModule],
  controllers: [PwaController],
  providers: [PwaService],
})
export class PwaModule {}
