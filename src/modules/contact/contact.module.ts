import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller.js';

@Module({ controllers: [ContactController] })
export class ContactModule {}
