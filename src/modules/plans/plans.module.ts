import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller.js';

@Module({ controllers: [PlansController] })
export class PlansModule {}
