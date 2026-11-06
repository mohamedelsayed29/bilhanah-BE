import { ReportExportService } from './report-export.service.js';
import type { ReportsService } from './reports.service.js';
import { reportQuerySchema } from '@bilhanah/contracts';

const query=reportQuerySchema.parse({from:'2026-11-01',to:'2026-11-06'});
describe('report export resource limits',()=>{
  it('refuses oversized PDFs without rendering or silently dropping rows',async()=>{
    const reports={get:vi.fn().mockResolvedValue({total:5001}),logo:vi.fn()} as unknown as ReportsService;
    const exporter=new ReportExportService(reports);
    await expect(exporter.generate('owner',query,'pdf')).rejects.toMatchObject({response:{code:'REPORT_TOO_LARGE'}});
    expect(reports.logo).not.toHaveBeenCalled();
    // The slot is released after a failure too.
    await expect(exporter.generate('owner',query,'html')).rejects.toMatchObject({response:{code:'REPORT_TOO_LARGE'}});
  });
  it('bounds concurrent exports and releases the slot when aggregation fails',async()=>{
    let reject!: (reason:Error)=>void;
    const pending=new Promise((_,fail)=>{reject=fail;});
    const reports={get:vi.fn().mockReturnValue(pending)} as unknown as ReportsService;
    const exporter=new ReportExportService(reports);
    const first=exporter.generate('owner',query,'csv');
    await expect(exporter.generate('another-owner',query,'csv')).rejects.toMatchObject({response:{code:'REPORT_BUSY'}});
    reject(new Error('database timeout'));
    await expect(first).rejects.toThrow('database timeout');
    await expect(exporter.generate('owner',query,'csv')).rejects.toThrow('database timeout');
  });
});
