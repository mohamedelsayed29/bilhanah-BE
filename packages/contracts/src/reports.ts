import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value); return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date.');
export const REPORT_TYPES = ['overview', 'sales', 'orders', 'products', 'categories', 'branches', 'payments'] as const;
export type ReportType = typeof REPORT_TYPES[number];
export const reportQuerySchema = z.object({
  from: day, to: day, branchId: z.uuid().optional(), categoryId: z.uuid().optional(), productId: z.uuid().optional(),
  status: z.enum(['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'REJECTED']).optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER', 'UNPAID']).optional(),
  type: z.enum(REPORT_TYPES).default('overview'), language: z.enum(['ar', 'en']).default('ar'),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['net', 'gross', 'units', 'orders', 'name', 'date']).default('net'), direction: z.enum(['asc', 'desc']).default('desc'),
}).refine(q => q.from <= q.to, { message: 'End date must follow start date.', path: ['to'] })
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86400000 < 366, { message: 'Use at most 366 days.', path: ['to'] });
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type ReportRow = { id: string; name: string; nameEn: string | null; category: string | null; categoryEn: string | null; units: number; orders: number; gross: number; net: number; refunds: number; cancelled: number; completed: number; pending: number; refundedOrders: number; products: number; contribution: number; average: number; status?: string; paymentMethod?: string };
export type ReportData = {
  restaurant: { name: string; timezone: string; currency: string; logoUrl: string | null };
  branch: string | null; generatedAt: string; filters: ReportQuery;
  summary: { gross: number; net: number; orders: number; completed: number; cancelled: number; pending: number; refundedOrders: number; refunds: number; discounts: number; average: number };
  days: (ReportRow & { date: string })[]; branches: ReportRow[]; categories: ReportRow[]; payments: ReportRow[]; topProducts: ReportRow[];
  rows: ReportRow[]; total: number;
  options: { branches: { id: string; name: string }[]; categories: { id: string; name: string; nameEn: string | null }[]; products: { id: string; categoryId: string; name: string; nameEn: string | null }[] };
  capabilities: { discounts: boolean; refunds: 'RECORDED_CASH_REVERSALS'; currency: 'EGP' };
};
