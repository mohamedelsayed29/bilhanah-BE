import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AttendanceController, AttendanceKioskController } from './attendance.controller.js';
import { AttendanceKioskService } from './attendance-kiosk.service.js';
import { AttendanceService } from './attendance.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AttendanceController, AttendanceKioskController],
  providers: [AttendanceService, AttendanceKioskService],
})
export class AttendanceModule {}
