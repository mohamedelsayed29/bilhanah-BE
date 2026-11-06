import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ReportData, ReportQuery, ReportRow } from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';

type Raw = Record<string, string | number | bigint | null>;
const numeric = ['units', 'orders', 'gross', 'net', 'refunds', 'cancelled', 'completed', 'pending', 'refundedOrders', 'products'] as const;
export function reportRow(raw: Raw): ReportRow {
  const row = { ...raw, contribution: 0, average: 0 } as unknown as ReportRow;
  for (const key of numeric) row[key] = Number(raw[key] ?? 0);
  row.net = Math.round(row.net); row.refunds = Math.round(row.refunds);
  row.average = row.orders > row.cancelled ? Math.round(row.net / (row.orders - row.cancelled)) : 0;
  return row;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly scopes: BranchScopeService, private readonly storage: StorageService) {}

  async get(userId: string, q: ReportQuery, exporting = false, hourly = false): Promise<ReportData> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'analytics.view', 'analytics.financial');
    const where = await this.scopes.branchWhere(scope, q.branchId);
    const rid = scope.restaurant.id;
    if (hourly && q.from !== q.to) throw new BadRequestException({code:'VALIDATION_FAILED',message:'Hourly overview requires one local calendar day.'});
    // PostgreSQL resolves midnight gaps/overlaps (Egypt changes its clock at midnight).
    const bounds = hourly ? await this.prisma.$queryRaw<{start:Date;end:Date}[]>(Prisma.sql`SELECT
      ${q.from}::date::timestamp AT TIME ZONE ${scope.restaurant.timezone} AS start,
      (${q.to}::date + 1)::timestamp AT TIME ZONE ${scope.restaurant.timezone} AS "end"`) : [];
    const start = bounds[0]?.start ?? new Date(q.from);
    const end = bounds[0]?.end ?? new Date(Date.parse(q.to)+86400000);
    // Validate ids even when the period has no orders. Never accept ids from another tenant.
    if (q.categoryId && !await this.prisma.category.count({ where: { id: q.categoryId, restaurantId: rid } })) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found.' });
    if (q.productId && !await this.prisma.menuItem.count({ where: { id: q.productId, restaurantId: rid, ...(q.categoryId && { categoryId: q.categoryId }) } })) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Product not found in this category.' });
    const clause = Prisma.sql`o.restaurant_id = ${rid}::uuid AND ${hourly ? Prisma.sql`o.placed_at >= ${start} AND o.placed_at < ${end}` : Prisma.sql`o.business_day BETWEEN ${q.from}::date AND ${q.to}::date`}
      ${where.branchId ? Prisma.sql`AND o.branch_id = ${where.branchId}::uuid` : Prisma.empty}
      ${q.status ? Prisma.sql`AND o.status::text = ${q.status}` : Prisma.empty}
      ${q.paymentMethod ? q.paymentMethod === 'UNPAID' ? Prisma.sql`AND o.paid_at IS NULL` : Prisma.sql`AND o.payment_method::text = ${q.paymentMethod} AND o.paid_at IS NOT NULL` : Prisma.empty}`;
    // Filter at line level: a category/product report includes only its lines, not the whole bill.
    const cte = Prisma.sql`WITH base_orders AS (SELECT o.*, b.name AS branch_name FROM orders o JOIN branches b ON b.id=o.branch_id WHERE ${clause}),
      refunds AS (SELECT c.order_id, SUM(c.amount_piastres)::numeric AS amount FROM cash_transactions c JOIN base_orders o ON o.id=c.order_id
        WHERE c.restaurant_id=${rid}::uuid AND c.kind='REFUND' AND c.approval_status='APPROVED' GROUP BY c.order_id),
      lines AS (SELECT o.id AS oid,o.business_day,o.placed_at,o.number,o.branch_id,o.branch_name,o.status::text AS status,
        COALESCE(o.payment_method::text,'UNPAID') AS payment_method, i.menu_item_id::text AS product_id,
        i.name_ar,i.name_en,m.category_id::text AS category_id,c.name_ar AS category,c.name_en AS category_en,
        i.quantity, i.prep_status::text AS prep_status,
        (i.unit_price_piastres::bigint*i.quantity) AS line_amount,
        CASE WHEN o.status NOT IN ('CANCELLED','REJECTED') AND i.prep_status!='CANCELLED' THEN i.unit_price_piastres::bigint*i.quantity ELSE 0 END AS gross,
        LEAST(COALESCE(r.amount,0),o.subtotal_piastres)::numeric * (i.unit_price_piastres::numeric*i.quantity)/NULLIF(o.subtotal_piastres,0) AS refund
        FROM base_orders o JOIN order_items i ON i.order_id=o.id LEFT JOIN menu_items m ON m.id=i.menu_item_id
        LEFT JOIN categories c ON c.id=m.category_id LEFT JOIN refunds r ON r.order_id=o.id
        WHERE TRUE ${q.categoryId ? Prisma.sql`AND m.category_id=${q.categoryId}::uuid` : Prisma.empty}
        ${q.productId ? Prisma.sql`AND i.menu_item_id=${q.productId}::uuid` : Prisma.empty}),
      facts AS (SELECT *, GREATEST(0,gross-CASE WHEN gross>0 THEN COALESCE(refund,0) ELSE 0 END) AS net FROM lines)`;
    const sums = Prisma.sql`COUNT(DISTINCT oid) AS orders, COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(net),0) AS net,
      COALESCE(SUM(refund),0) AS refunds, COALESCE(SUM(CASE WHEN status NOT IN ('CANCELLED','REJECTED') AND prep_status!='CANCELLED' THEN quantity ELSE 0 END),0) AS units,
      COUNT(DISTINCT oid) FILTER(WHERE status IN ('CANCELLED','REJECTED')) AS cancelled,
      COUNT(DISTINCT oid) FILTER(WHERE status='COMPLETED') AS completed,
      COUNT(DISTINCT oid) FILTER(WHERE status IN ('PLACED','ACCEPTED','PREPARING','READY')) AS pending,
      COUNT(DISTINCT oid) FILTER(WHERE refund>0) AS "refundedOrders", COUNT(DISTINCT COALESCE(product_id,name_ar)) AS products`;
    const group = (id: Prisma.Sql, name: Prisma.Sql, extra = Prisma.sql`NULL::text AS "nameEn",NULL::text AS category,NULL::text AS "categoryEn"`) => Prisma.sql`${cte} SELECT ${id} AS id,${name} AS name,${extra},${sums} FROM facts GROUP BY 1,2,3,4,5`;
    const timeBucket = hourly ? Prisma.sql`to_char(date_bin('1 hour'::interval,placed_at,${start}::timestamptz) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')` : Prisma.sql`business_day::text`;
    const queries = [
      Prisma.sql`${cte} SELECT ${sums} FROM facts`,
      group(timeBucket, timeBucket),
      group(Prisma.sql`branch_id::text`, Prisma.sql`branch_name`),
      group(Prisma.sql`COALESCE(category_id,'deleted')`, Prisma.sql`COALESCE(category,'غير مصنف')`, Prisma.sql`COALESCE(category_en,'Uncategorised') AS "nameEn",NULL::text AS category,NULL::text AS "categoryEn"`),
      group(Prisma.sql`payment_method`, Prisma.sql`payment_method`),
      group(Prisma.sql`COALESCE(product_id,name_ar)`, Prisma.sql`name_ar`, Prisma.sql`name_en AS "nameEn",category,category_en AS "categoryEn"`),
    ];
    // A repeatable-read snapshot keeps totals, rankings and exports consistent during live ordering.
    const raw = await this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
      const result: Raw[][] = [];
      for (const query of queries) result.push(await tx.$queryRaw<Raw[]>(query));
      if (q.type === 'orders') {
        const limit = exporting ? 50001 : q.pageSize;
        const offset = exporting ? 0 : (q.page - 1) * q.pageSize;
        result.push(await tx.$queryRaw<Raw[]>(Prisma.sql`${cte} SELECT oid::text AS id,('#' || number::text || ' · ' || business_day::text || ' · ' || branch_name) AS name,
          NULL::text AS "nameEn",NULL::text AS category,NULL::text AS "categoryEn",status,payment_method AS "paymentMethod",${sums}
          FROM facts GROUP BY oid,number,business_day,branch_name,status,payment_method ORDER BY business_day DESC,number DESC,oid LIMIT ${limit} OFFSET ${offset}`));
      }
      return result;
    }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
    const totals = reportRow(raw[0]![0]!);
    const asRows = (index: number) => raw[index]!.map(reportRow).map(row => ({ ...row, contribution: totals.net ? row.net / totals.net * 100 : 0 }));
    const daysMap = new Map(asRows(1).map(row => [row.id,row]));
    const days: ReportData['days'] = [];
    const now = Date.now();
    const first = hourly ? +start : Date.parse(q.from);
    const last = hourly ? Math.min(+end-1, now >= +start && now < +end ? now : +end-1) : Date.parse(q.to);
    for (let date = first; date <= last; date += hourly ? 3600000 : 86400000) {
      const key = hourly ? new Date(date).toISOString().slice(0,19)+'Z' : new Date(date).toISOString().slice(0,10);
      days.push({ ...(daysMap.get(key) ?? reportRow({ id: key, name: key, nameEn: null, category: null, categoryEn: null })), date: key });
    }
    const rank = (rows: ReportRow[]) => rows.sort((a,b) => b.net-a.net || a.name.localeCompare(b.name));
    const branches = rank(asRows(2)), categories = rank(asRows(3)), payments = rank(asRows(4)), products = rank(asRows(5));
    let rows = q.type === 'products' ? products : q.type === 'categories' ? categories : q.type === 'branches' ? branches : q.type === 'payments' ? payments : q.type === 'orders' ? asRows(6) : days;
    const total = q.type === 'orders' ? totals.orders : rows.length;
    if (exporting && rows.length > 50000) throw new BadRequestException({ code: 'REPORT_TOO_LARGE', message: 'Export at most 50,000 orders at once. Choose a shorter period or branch; no rows were omitted.' });
    if (q.type !== 'orders') {
      rows = [...rows].sort((a,b) => (q.sort === 'name' || q.sort === 'date' ? a.name.localeCompare(b.name) : a[q.sort]-b[q.sort]) * (q.direction === 'asc' ? 1 : -1));
      if (!exporting) rows = rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize);
    }
    const [restaurant, settings, branchOptions, categoryOptions, productOptions] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: rid }, include: { logo: true } }),
      this.prisma.cashSettings.findUnique({ where: { restaurantId: rid } }), this.scopes.visibleBranches(scope),
      this.prisma.category.findMany({ where: { restaurantId: rid }, select: { id: true, nameAr: true, nameEn: true } }),
      this.prisma.menuItem.findMany({ where: { restaurantId: rid }, select: { id: true, categoryId: true, nameAr: true, nameEn: true } }),
    ]);
    // The platform stores piastres only. Refuse a misconfigured currency rather than relabelling money.
    if (settings && settings.currency !== 'EGP') throw new BadRequestException({ code: 'REPORT_CURRENCY_UNSUPPORTED', message: 'Order prices are stored in EGP. Configure the cash currency as EGP before reporting.' });
    return { restaurant: { name: restaurant.name, timezone: restaurant.timezone, currency: settings?.currency ?? 'EGP', logoUrl: restaurant.logo ? this.storage.publicUrl(`${restaurant.logo.storageKey}/${restaurant.logo.variantWidths[0]}.webp`) : null },
      branch: where.branchId ? branchOptions.find(b => b.id===where.branchId)?.name ?? null : null, filters: { ...q, ...(where.branchId && { branchId: where.branchId }) }, generatedAt: new Date().toISOString(),
      summary: { gross: totals.gross, net: totals.net, orders: totals.orders, completed: totals.completed, cancelled: totals.cancelled, pending: totals.pending, refundedOrders: totals.refundedOrders, refunds: totals.refunds, discounts: 0, average: totals.average },
      days, branches, categories, payments, topProducts: products.slice(0,10), rows, total,
      options: { branches: branchOptions.map(b => ({ id:b.id,name:b.name })), categories: categoryOptions.map(c => ({id:c.id,name:c.nameAr,nameEn:c.nameEn})), products: productOptions.map(p=>({id:p.id,categoryId:p.categoryId,name:p.nameAr,nameEn:p.nameEn})) },
      capabilities: { discounts: false, refunds: 'RECORDED_CASH_REVERSALS', currency: 'EGP' } };
  }

  async logo(userId: string): Promise<string | null> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'analytics.view','analytics.financial');
    const r = await this.prisma.restaurant.findUniqueOrThrow({where:{id:scope.restaurant.id},include:{logo:true}});
    if (!r.logo) return null;
    const bytes = await this.storage.get(`${r.logo.storageKey}/${r.logo.variantWidths[0]}.webp`);
    return bytes ? `data:image/webp;base64,${bytes.toString('base64')}` : null;
  }
}
