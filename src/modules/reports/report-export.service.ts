import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { ReportQuery } from '@bilhanah/contracts';
import { ReportsService } from './reports.service.js';
import { csvReport, reportHtml } from './report-template.js';
import { reportPdfFooter } from './report-brand.js';

@Injectable()
export class ReportExportService {
  private busy = false;
  constructor(private readonly reports: ReportsService) {}
  async generate(userId: string, query: ReportQuery, format: 'pdf'|'csv'|'html') {
    if (this.busy) throw new ServiceUnavailableException({code:'REPORT_BUSY',message:'Another report is being prepared. Please try again shortly.'});
    this.busy = true;
    try {
      const data = await this.reports.get(userId,query,true);
      if(format==='csv') return Buffer.from(csvReport(data),'utf8');
      if(data.total>5000) throw new BadRequestException({code:'REPORT_TOO_LARGE',message:'PDF supports 5,000 rows. Use CSV for all rows, or narrow the filters.'});
      const html = reportHtml(data,await this.reports.logo(userId));
      if(format==='html') return Buffer.from(html,'utf8');
      const executablePath = process.env['REPORT_CHROMIUM_PATH'] || ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
      if(!executablePath) throw new ServiceUnavailableException({code:'REPORT_PDF_UNAVAILABLE',message:'PDF renderer is not installed. Configure REPORT_CHROMIUM_PATH or use CSV.'});
      const browser = await chromium.launch({executablePath,headless:true,args:process.platform==='linux'?['--no-sandbox','--disable-dev-shm-usage']:[],timeout:15000});
      try {
        const page=await browser.newPage();
        await page.route('**/*',route=>route.abort()); // No network, cookies, scripts, or external resources in report documents.
        await page.setContent(html,{waitUntil:'load',timeout:15000});
        await page.evaluate('document.fonts.ready');
        const timer = setTimeout(() => { void browser.close(); }, 45000);
        try { return await page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<span></span>',
          footerTemplate: reportPdfFooter(data.generatedAt.slice(0,10))}); }
        finally { clearTimeout(timer); }
      } finally {await browser.close();}
    } finally {this.busy=false;}
  }
}
