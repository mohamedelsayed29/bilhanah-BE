import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { reportQuerySchema, type ReportQuery } from '@bilhanah/contracts';
import { CurrentAuth, type AuthContext } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ReportsService } from './reports.service.js';
import { ReportExportService } from './report-export.service.js';

@Controller('reports')
@UseGuards(AccessTokenGuard,RolesGuard,RateLimitGuard)
@RequirePermission('analytics.view','analytics.financial')
export class ReportsController {
  constructor(private readonly reports: ReportsService,private readonly exports:ReportExportService) {}
  @Get()
  @Header('Cache-Control','no-store')
  @RateLimit({name:'reports:read',limit:60,windowSeconds:60,by:'ip'})
  get(@CurrentAuth() auth:AuthContext,@Query(new ZodValidationPipe(reportQuerySchema)) query:ReportQuery) {return this.reports.get(auth.userId,query);}
  @Get('overview')
  @Header('Cache-Control','no-store')
  @RateLimit({name:'reports:read',limit:60,windowSeconds:60,by:'ip'})
  overview(@CurrentAuth() auth:AuthContext,@Query(new ZodValidationPipe(reportQuerySchema)) query:ReportQuery,
    @Query('period',new ZodValidationPipe(z.enum(['day','month','year']))) period:'day'|'month'|'year') {
    return this.reports.get(auth.userId,{...query,type:'overview'},false,period==='day');
  }
  @Get('export')
  @RateLimit({name:'reports:export',limit:12,windowSeconds:60,by:'ip'})
  async export(@CurrentAuth() auth:AuthContext,@Query(new ZodValidationPipe(reportQuerySchema)) query:ReportQuery,
    @Query('format',new ZodValidationPipe(z.enum(['pdf','csv','html']))) format:'pdf'|'csv'|'html',@Res() response:Response) {
    const bytes=await this.exports.generate(auth.userId,query,format);
    response.setHeader('Content-Type',format==='pdf'?'application/pdf':format==='csv'?'text/csv; charset=utf-8':'text/html; charset=utf-8');
    response.setHeader('Content-Disposition',`${format==='html'?'inline':'attachment'}; filename="bilhanah-${query.type}-${query.from}-${query.to}.${format}"`);
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    response.send(bytes);
  }
}
