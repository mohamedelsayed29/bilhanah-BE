import { ATTENDANCE_METHOD_LABELS, ATTENDANCE_STATUS_LABELS, type AttendanceRecord, type AttendanceSummaryRow } from '@bilhanah/contracts';

type Lang = 'ar' | 'en';
type Table = { headers: string[]; rows: (string | number)[][] };

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** Local time of an instant in the restaurant's zone ("2026-11-04 09:05"). */
function local(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

export function recordsTable(records: AttendanceRecord[], lang: Lang, timeZone: string): Table {
  const t = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const label = (pair: [string, string]) => (lang === 'ar' ? pair[0] : pair[1]);
  return {
    headers: [t('الموظف', 'Employee'), t('رقم الموظف', 'Employee ID'), t('الفرع', 'Branch'), t('اليوم', 'Day'), t('الشيفت', 'Shift'),
      t('الحضور', 'Check-in'), t('الانصراف', 'Check-out'), t('ساعات العمل', 'Worked hours'), t('التأخير (دقيقة)', 'Late (min)'),
      t('الإضافي (دقيقة)', 'Overtime (min)'), t('الحالة', 'Status'), t('طريقة الحضور', 'Method'), t('الجهاز', 'Device'), t('ملاحظة', 'Note')],
    rows: records.map((record) => [
      record.employee.fullName, record.employee.employeeNumber, record.branchName, record.day,
      record.shift ? `${local(record.shift.startsAt, timeZone).slice(11)}–${local(record.shift.endsAt, timeZone).slice(11)}` : '',
      local(record.checkInAt, timeZone), local(record.checkOutAt, timeZone), hours(record.workedMinutes), record.lateMinutes, record.overtimeMinutes,
      label(ATTENDANCE_STATUS_LABELS[record.status]), label(ATTENDANCE_METHOD_LABELS[record.checkInMethod]), record.kioskName ?? '', record.managerNote ?? '',
    ]),
  };
}

export function summaryTable(rows: AttendanceSummaryRow[], lang: Lang): Table {
  const t = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  return {
    headers: [t('الموظف', 'Employee'), t('رقم الموظف', 'Employee ID'), t('الفرع', 'Branch'), t('شيفتات', 'Shifts'), t('أيام حضور', 'Days present'),
      t('مرات تأخير', 'Late arrivals'), t('دقائق تأخير', 'Late minutes'), t('غياب', 'Absences'), t('ناقص', 'Incomplete'), t('إجازات', 'Leave days'),
      t('ساعات العمل', 'Worked hours'), t('ساعات إضافية', 'Overtime hours')],
    rows: rows.map((row) => [row.employee.fullName, row.employee.employeeNumber, row.employee.branchName, row.scheduledShifts, row.daysPresent,
      row.lateCount, row.lateMinutes, row.absences, row.incomplete, row.leaveDays, hours(row.workedMinutes), hours(row.overtimeMinutes)]),
  };
}

/** CSV with a UTF-8 BOM, so Excel opens Arabic text correctly. Cells starting like a formula are neutralized. */
export function toCsv(table: Table): string {
  const cell = (value: string | number) => {
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[table.headers, ...table.rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** An Excel workbook (SpreadsheetML 2003, opened by Excel and LibreOffice) with typed number cells. */
export function toXls(table: Table, sheet: string, rtl: boolean): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cell = (value: string | number, style = '') => (typeof value === 'number'
    ? `<Cell${style}><Data ss:Type="Number">${value}</Data></Cell>`
    : `<Cell${style}><Data ss:Type="String">${escape(value)}</Data></Cell>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="head"><Font ss:Bold="1"/><Interior ss:Color="#E6F0EC" ss:Pattern="Solid"/></Style></Styles>
<Worksheet ss:Name="${escape(sheet).slice(0, 31)}"><Table>
<Row>${table.headers.map((header) => cell(header, ' ss:StyleID="head"')).join('')}</Row>
${table.rows.map((row) => `<Row>${row.map((value) => cell(value)).join('')}</Row>`).join('\n')}
</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">${rtl ? '<DisplayRightToLeft/>' : ''}<FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>
</Workbook>`;
}
