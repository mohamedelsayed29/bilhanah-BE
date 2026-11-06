import { Injectable } from '@nestjs/common';
import {
  BRANCH_ERROR_CODES,
  BASE_UNITS,
  type countsQuerySchema,
  type createCountSchema,
  type createPurchaseSchema,
  type createTransferSchema,
  type createWasteSchema,
  INVENTORY_ERROR_CODES as CODES,
  type Paginated,
  type Purchase,
  type PurchaseDetail,
  type purchaseLineSchema,
  type purchasesQuerySchema,
  type PurchaseStatus,
  type StockCount,
  type StockCountDetail,
  type StockTransfer,
  type TransferDestination,
  type transfersQuerySchema,
  type updateCountSchema,
  type updatePurchaseSchema,
  type voidPurchaseSchema,
  type WasteEntry,
  type wasteQuerySchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { branchNotFound } from '../branches/branch-scope.service.js';
import { recipeError } from './inventory-catalog.service.js';
import { fail, ingredientNotFound, InventoryAccess, type InventoryScope, localDayRange, supplierNotFound, type Tx, variantNotFound } from './inventory-access.service.js';
import { InventoryEngine, type Posting } from './inventory-engine.service.js';
import { Decimal, dec, explode, num, numOrNull, overThreshold, roundQuantity, roundUnitCost, roundValue, toBaseQuantity, valueOf, ZERO } from './inventory-math.js';

const purchaseNotFound = () => fail('notFound', CODES.PURCHASE_NOT_FOUND, 'Purchase not found.');
const purchaseStatus = (status: string, message: string) => fail('conflict', CODES.PURCHASE_STATUS, message, { status });
const countNotFound = () => fail('notFound', CODES.COUNT_NOT_FOUND, 'Stock count not found.');
const countNotOpen = (status: string) => fail('conflict', CODES.COUNT_NOT_OPEN, 'This stock count is closed.', { status });

const purchaseInclude = {
  branch: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  receivedBy: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.PurchaseInclude;
type PurchaseRow = Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>;

const countInclude = {
  branch: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  submittedBy: { select: { fullName: true } },
  lines: { include: { ingredient: { select: { nameAr: true, nameEn: true, category: true, dimension: true } } }, orderBy: [{ ingredient: { category: 'asc' } }, { ingredient: { nameAr: 'asc' } }] },
} satisfies Prisma.StockCountInclude;
type CountRow = Prisma.StockCountGetPayload<{ include: typeof countInclude }>;

const wasteInclude = {
  branch: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  lines: { orderBy: { sortOrder: 'asc' }, include: { ingredient: { select: { dimension: true } } } },
} satisfies Prisma.WasteEntryInclude;

const transferInclude = {
  fromBranch: { select: { id: true, name: true } },
  toBranch: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  lines: { orderBy: { sortOrder: 'asc' }, include: { ingredient: { select: { nameAr: true, nameEn: true, dimension: true } } } },
} satisfies Prisma.StockTransferInclude;

type PricedLine = {
  ingredientId: string;
  unitId: string | null;
  unitNameAr: string | null;
  unitNameEn: string | null;
  factor: Decimal;
  quantity: Decimal;
  baseQuantity: Decimal;
  unitPrice: Decimal;
  lineTotal: Decimal;
};

/**
 * Purchases, waste, stock counts and transfers: the documents that move stock. Each posts through
 * InventoryEngine in one transaction; status changes are compare-and-swap, so a double click or two
 * devices post once.
 */
@Injectable()
export class InventoryOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InventoryAccess,
    private readonly engine: InventoryEngine,
    private readonly audit: AuditService,
  ) {}

  // --- Purchases -----------------------------------------------------------------------------------

  async purchases(userId: string, query: z.output<typeof purchasesQuerySchema>): Promise<Paginated<Purchase>> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const where: Prisma.PurchaseWhereInput = {
      ...(await this.access.branches.branchWhere(scope, query.branchId)),
      ...(query.status && { status: query.status }),
      ...(query.supplierId && { supplierId: query.supplierId }),
      ...((query.from || query.to) && { createdAt: localDayRange(scope.restaurant.timezone, query.from, query.to) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({ where, include: purchaseInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.purchase.count({ where }),
    ]);
    return { items: rows.map((row) => this.toPurchase(row, scope.costs)), total, page: query.page, pageSize: query.pageSize };
  }

  async purchase(userId: string, id: string): Promise<PurchaseDetail> {
    const scope = await this.access.scope(userId, 'inventory.view');
    return this.purchaseDetail(scope, id);
  }

  async createPurchase(userId: string, input: z.output<typeof createPurchaseSchema>, ipAddress?: string): Promise<PurchaseDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const branch = await this.access.branches.branch(scope, input.branchId);
    const supplier = input.supplierId ? await this.findSupplier(scope, input.supplierId) : null;
    const lines = await this.priceLines(scope, input.lines);
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          restaurantId: scope.restaurant.id, branchId: branch.id, supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null,
          invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate ? new Date(`${input.invoiceDate}T00:00:00Z`) : null, note: input.note,
          total: this.total(lines), createdById: userId,
          lines: { create: lines.map((line, sortOrder) => ({ ...line, sortOrder })) },
        },
      });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.purchase_created', targetType: 'inventory-purchase', targetId: created.id, metadata: { branchId: branch.id, lines: lines.length, receive: input.receive }, ipAddress }, tx);
      if (input.receive) await this.receiveIn(tx, scope, created.id, userId, ipAddress);
      return created.id;
    });
    return this.purchaseDetail(scope, id);
  }

  async updatePurchase(userId: string, id: string, input: z.output<typeof updatePurchaseSchema>): Promise<PurchaseDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const current = await this.findPurchase(scope, id);
    const supplier = input.supplierId ? await this.findSupplier(scope, input.supplierId) : null;
    const lines = input.lines ? await this.priceLines(scope, input.lines) : null;
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lockPurchase(tx, id);
      if (status !== 'DRAFT') throw purchaseStatus(status, 'Only a draft purchase can be edited.');
      if (lines) {
        await tx.purchaseLine.deleteMany({ where: { purchaseId: id } });
        await tx.purchaseLine.createMany({ data: lines.map((line, sortOrder) => ({ ...line, purchaseId: id, sortOrder })) });
      }
      await tx.purchase.update({
        where: { id: current.id },
        data: {
          ...(input.supplierId !== undefined && { supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null }),
          ...(input.invoiceNumber !== undefined && { invoiceNumber: input.invoiceNumber }),
          ...(input.invoiceDate !== undefined && { invoiceDate: input.invoiceDate ? new Date(`${input.invoiceDate}T00:00:00Z`) : null }),
          ...(input.note !== undefined && { note: input.note }),
          ...(lines && { total: this.total(lines) }),
        },
      });
    });
    return this.purchaseDetail(scope, id);
  }

  /** DRAFT → RECEIVED: posts every line at its cost per base unit. A second receive is refused (409). */
  async receivePurchase(userId: string, id: string, ipAddress?: string): Promise<PurchaseDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    await this.findPurchase(scope, id);
    await this.prisma.$transaction((tx) => this.receiveIn(tx, scope, id, userId, ipAddress));
    return this.purchaseDetail(scope, id);
  }

  /** Voids a draft, or a received purchase by reversing its movements at their own cost. */
  async voidPurchase(userId: string, id: string, input: z.output<typeof voidPurchaseSchema>, ipAddress?: string): Promise<PurchaseDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const current = await this.findPurchase(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lockPurchase(tx, id);
      if (status === 'VOID') throw purchaseStatus(status, 'This purchase is already void.');
      const { count } = await tx.purchase.updateMany({
        where: { id, status },
        data: { status: 'VOID', voidedAt: new Date(), voidedById: userId, voidReason: input.reason },
      });
      if (!count) throw purchaseStatus(status, 'This purchase was just changed on another device.');
      if (status === 'RECEIVED') {
        const received = await tx.stockMovement.findMany({ where: { purchaseId: id, type: 'PURCHASE' } });
        await this.engine.post(tx, scope.restaurant.id, received.map((movement) => ({
          branchId: movement.branchId, ingredientId: movement.ingredientId, type: 'PURCHASE_VOID', quantity: movement.quantity.neg(), unitCost: movement.unitCost,
          sourceKey: `purchase-void:${movement.sourceKey}`, purchaseId: id, note: input.reason,
        })), userId);
      }
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.purchase_voided', targetType: 'inventory-purchase', targetId: id, metadata: { from: status, reason: input.reason, branchId: current.branchId }, ipAddress }, tx);
    });
    return this.purchaseDetail(scope, id);
  }

  private async receiveIn(tx: Tx, scope: InventoryScope, id: string, userId: string, ipAddress?: string): Promise<void> {
    // Compare-and-swap: of two receives at once, the second finds the purchase received and posts nothing.
    const { count } = await tx.purchase.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'RECEIVED', receivedAt: new Date(), receivedById: userId } });
    if (!count) {
      const row = await tx.purchase.findUnique({ where: { id }, select: { status: true } });
      throw purchaseStatus(row?.status ?? 'VOID', 'This purchase was already received or voided.');
    }
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    await this.engine.post(tx, scope.restaurant.id, purchase.lines.map((line) => ({
      branchId: purchase.branchId, ingredientId: line.ingredientId, type: 'PURCHASE', quantity: line.baseQuantity,
      unitCost: roundUnitCost(line.lineTotal.div(line.baseQuantity)), sourceKey: `purchase:${line.id}`, purchaseId: id,
    })), userId);
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.purchase_received', targetType: 'inventory-purchase', targetId: id, metadata: { branchId: purchase.branchId, total: num(purchase.total) }, ipAddress }, tx);
  }

  /** Lines in base units with a unit price and a line total (either given, the other derived). */
  private async priceLines(scope: InventoryScope, lines: z.output<typeof purchaseLineSchema>[]): Promise<PricedLine[]> {
    const ingredients = await this.rawIngredients(scope, lines.map((line) => line.ingredientId), true);
    return lines.map((line) => {
      const ingredient = ingredients.get(line.ingredientId)!;
      const unit = this.unitOf(ingredient, line.unitId);
      const quantity = dec(line.quantity);
      const baseQuantity = toBaseQuantity(quantity, unit.factor);
      if (baseQuantity.lte(0)) throw fail('bad', 'VALIDATION_FAILED', 'The quantity is too small for this unit.');
      const unitPrice = line.unitPrice !== undefined ? dec(line.unitPrice) : dec(line.lineTotal!).div(quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const lineTotal = line.lineTotal !== undefined ? dec(line.lineTotal) : roundValue(quantity.mul(unitPrice));
      return { ingredientId: ingredient.id, unitId: unit.id, unitNameAr: unit.nameAr, unitNameEn: unit.nameEn, factor: unit.factor, quantity, baseQuantity, unitPrice, lineTotal };
    });
  }

  private total(lines: readonly PricedLine[]): Decimal {
    return roundValue(lines.reduce((sum, line) => sum.plus(line.lineTotal), ZERO));
  }

  private async lockPurchase(tx: Tx, id: string): Promise<PurchaseStatus> {
    const rows = await tx.$queryRaw<{ status: PurchaseStatus }[]>`SELECT status FROM inventory_purchases WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0]) throw purchaseNotFound();
    return rows[0].status;
  }

  private async findPurchase(scope: InventoryScope, id: string) {
    const row = await this.prisma.purchase.findFirst({ where: { id, ...(await this.access.branches.branchWhere(scope)) }, select: { id: true, branchId: true, status: true } });
    if (!row) throw purchaseNotFound();
    return row;
  }

  private async findSupplier(scope: InventoryScope, id: string) {
    const row = await this.prisma.supplier.findFirst({ where: { id, restaurantId: scope.restaurant.id }, select: { id: true, name: true } });
    if (!row) throw supplierNotFound();
    return row;
  }

  private async purchaseDetail(scope: InventoryScope, id: string): Promise<PurchaseDetail> {
    const row = await this.prisma.purchase.findFirst({
      where: { id, ...(await this.access.branches.branchWhere(scope)) },
      include: { ...purchaseInclude, lines: { orderBy: { sortOrder: 'asc' }, include: { ingredient: { select: { nameAr: true, nameEn: true, dimension: true } } } } },
    });
    if (!row) throw purchaseNotFound();
    const costs = scope.costs;
    return {
      ...this.toPurchase(row, costs),
      lines: row.lines.map((line) => ({
        id: line.id, ingredientId: line.ingredientId, nameAr: line.ingredient.nameAr, nameEn: line.ingredient.nameEn, baseUnit: BASE_UNITS[line.ingredient.dimension].code,
        unitId: line.unitId, unitNameAr: line.unitNameAr, unitNameEn: line.unitNameEn, factor: num(line.factor), quantity: num(line.quantity), baseQuantity: num(line.baseQuantity),
        unitPrice: costs ? num(line.unitPrice) : null, lineTotal: costs ? num(line.lineTotal) : null,
        unitCost: costs ? num(roundUnitCost(line.lineTotal.div(line.baseQuantity))) : null,
      })),
    };
  }

  private toPurchase(row: PurchaseRow, costs: boolean): Purchase {
    return {
      id: row.id, branchId: row.branchId, branchName: row.branch.name,
      supplier: row.supplierName ? { id: row.supplierId, name: row.supplierName } : null,
      invoiceNumber: row.invoiceNumber, invoiceDate: row.invoiceDate?.toISOString().slice(0, 10) ?? null, status: row.status, note: row.note,
      total: costs ? num(row.total) : null, lineCount: row._count.lines,
      createdBy: row.createdBy?.fullName ?? null, createdAt: row.createdAt.toISOString(),
      receivedAt: row.receivedAt?.toISOString() ?? null, receivedBy: row.receivedBy?.fullName ?? null,
      voidedAt: row.voidedAt?.toISOString() ?? null, voidedBy: row.voidedBy?.fullName ?? null, voidReason: row.voidReason,
    };
  }

  // --- Waste ---------------------------------------------------------------------------------------

  async waste(userId: string, query: z.output<typeof wasteQuerySchema>): Promise<Paginated<WasteEntry>> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const where: Prisma.WasteEntryWhereInput = {
      ...(await this.access.branches.branchWhere(scope, query.branchId)),
      ...(query.reason && { reason: query.reason }),
      ...((query.from || query.to) && { createdAt: localDayRange(scope.restaurant.timezone, query.from, query.to) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.wasteEntry.findMany({ where, include: wasteInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.wasteEntry.count({ where }),
    ]);
    return { items: rows.map((row) => this.toWaste(row, scope.costs)), total, page: query.page, pageSize: query.pageSize };
  }

  /** Several lines (ingredients in any unit, or whole dishes by their recipe), posted at the average cost. */
  async recordWaste(userId: string, input: z.output<typeof createWasteSchema>, ipAddress?: string): Promise<WasteEntry> {
    const scope = await this.access.scope(userId, 'inventory.waste');
    const branch = await this.access.branches.branch(scope, input.branchId);
    const restaurantId = scope.restaurant.id;
    const reason = (await this.engine.settings(restaurantId)).wasteReasons.find((option) => option.code === input.reason);
    if (!reason) throw fail('bad', CODES.WASTE_REASON_UNKNOWN, 'Choose one of the restaurant’s waste reasons.', { reason: input.reason });
    const recipes = await this.engine.recipes(restaurantId);
    const ingredientLines = input.lines.flatMap((line) => ('ingredientId' in line ? [line] : []));
    const variantLines = input.lines.flatMap((line) => ('variantId' in line ? [line] : []));
    const units = ingredientLines.length
      ? new Map((await this.prisma.ingredient.findMany({ where: { id: { in: ingredientLines.map((line) => line.ingredientId) }, restaurantId }, include: { units: true } })).map((row) => [row.id, row]))
      : new Map();
    const variants = variantLines.length
      ? new Map((await this.prisma.menuItemVariant.findMany({
        where: { id: { in: variantLines.map((line) => line.variantId) }, item: { restaurantId } },
        select: { id: true, nameAr: true, nameEn: true, item: { select: { nameAr: true, nameEn: true } } },
      })).map((row) => [row.id, row]))
      : new Map();
    const variantRecipes = await this.engine.variantRecipes(variantLines.map((line) => line.variantId));

    // Each line: what it is, its name, and the raw ingredients it uses.
    const planned = input.lines.map((line) => {
      if ('ingredientId' in line) {
        const ingredient = units.get(line.ingredientId);
        if (!ingredient) throw ingredientNotFound();
        const unit = this.unitOf(ingredient, line.unitId);
        const quantity = toBaseQuantity(dec(line.quantity), unit.factor);
        let usage: Map<string, Decimal>;
        try {
          usage = explode([{ ingredientId: ingredient.id, quantity, wastePercent: ZERO }], dec(1), recipes.graph).usage;
        } catch (error) {
          recipeError(error);
        }
        return { ingredientId: ingredient.id as string, variantId: null, nameAr: ingredient.nameAr as string, nameEn: ingredient.nameEn as string | null, unitNameAr: unit.nameAr, unitNameEn: unit.nameEn, quantity, usage };
      }
      const variant = variants.get(line.variantId);
      if (!variant) throw variantNotFound();
      const recipe = variantRecipes.get(line.variantId);
      if (!recipe?.length) throw fail('bad', CODES.NO_RECIPE, 'This dish size has no recipe; record its ingredients instead.', { variantId: line.variantId });
      let usage: Map<string, Decimal>;
      try {
        usage = explode(recipe, dec(line.quantity), recipes.graph).usage;
      } catch (error) {
        recipeError(error);
      }
      const size = variant.nameAr ? ` (${variant.nameAr})` : '';
      return { ingredientId: null, variantId: variant.id as string, nameAr: `${variant.item.nameAr}${size}`, nameEn: variant.item.nameEn ? `${variant.item.nameEn}${variant.nameEn ? ` (${variant.nameEn})` : ''}` : null, unitNameAr: null, unitNameEn: null, quantity: dec(line.quantity), usage };
    });

    const id = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.wasteEntry.create({ data: { restaurantId, branchId: branch.id, reason: reason.code, reasonNameAr: reason.nameAr, reasonNameEn: reason.nameEn, note: input.note, createdById: userId } });
      const postings: Posting[] = planned.flatMap((line, index) => [...line.usage].map(([ingredientId, quantity]) => ({
        branchId: branch.id, ingredientId, type: 'WASTE' as const, quantity: quantity.neg(), sourceKey: `waste:${entry.id}:${index}:${ingredientId}`, wasteId: entry.id, note: input.note,
      })));
      const posted = await this.engine.post(tx, restaurantId, postings, userId);
      const valueOfLine = (index: number) => posted.filter((movement) => movement.sourceKey.startsWith(`waste:${entry.id}:${index}:`)).reduce((sum, movement) => sum.minus(movement.value), ZERO);
      await tx.wasteLine.createMany({
        data: planned.map((line, index) => ({
          wasteId: entry.id, ingredientId: line.ingredientId, variantId: line.variantId, nameAr: line.nameAr.slice(0, 150), nameEn: line.nameEn?.slice(0, 150) ?? null,
          unitNameAr: line.unitNameAr, unitNameEn: line.unitNameEn, quantity: roundQuantity(line.quantity), value: roundValue(valueOfLine(index)), sortOrder: index,
        })),
      });
      const total = roundValue(planned.reduce((sum, _line, index) => sum.plus(valueOfLine(index)), ZERO));
      await tx.wasteEntry.update({ where: { id: entry.id }, data: { total } });
      await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.waste_recorded', targetType: 'inventory-waste', targetId: entry.id, metadata: { branchId: branch.id, reason: input.reason, lines: planned.length, total: num(total) }, ipAddress }, tx);
      return entry.id;
    });
    const row = await this.prisma.wasteEntry.findUniqueOrThrow({ where: { id }, include: wasteInclude });
    return this.toWaste(row, scope.costs);
  }

  private toWaste(row: Prisma.WasteEntryGetPayload<{ include: typeof wasteInclude }>, costs: boolean): WasteEntry {
    return {
      id: row.id, branchId: row.branchId, branchName: row.branch.name, reason: row.reason, reasonNameAr: row.reasonNameAr, reasonNameEn: row.reasonNameEn,
      note: row.note, total: costs ? num(row.total) : null,
      lines: row.lines.map((line) => ({
        ingredientId: line.ingredientId, variantId: line.variantId, nameAr: line.nameAr, nameEn: line.nameEn, unitNameAr: line.unitNameAr, unitNameEn: line.unitNameEn, quantity: num(line.quantity),
        baseUnit: line.ingredient ? BASE_UNITS[line.ingredient.dimension].code : null, value: costs ? num(line.value) : null,
      })),
      createdBy: row.createdBy?.fullName ?? null, createdAt: row.createdAt.toISOString(),
    };
  }

  // --- Stock counts --------------------------------------------------------------------------------

  async counts(userId: string, query: z.output<typeof countsQuerySchema>): Promise<Paginated<StockCount>> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const where: Prisma.StockCountWhereInput = { ...(await this.access.branches.branchWhere(scope, query.branchId)), ...(query.status && { status: query.status }) };
    const [rows, total] = await Promise.all([
      this.prisma.stockCount.findMany({ where, include: countInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.stockCount.count({ where }),
    ]);
    return { items: rows.map((row) => this.toCount(row, scope.costs)), total, page: query.page, pageSize: query.pageSize };
  }

  async count(userId: string, id: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.view');
    return this.countDetail(scope, id);
  }

  /** Opens a count, snapshotting what the branch has on hand of each ingredient counted. */
  async createCount(userId: string, input: z.output<typeof createCountSchema>, ipAddress?: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const branch = await this.access.branches.branch(scope, input.branchId);
    const restaurantId = scope.restaurant.id;
    const ingredients = input.ingredientIds
      ? [...(await this.rawIngredients(scope, input.ingredientIds, false)).values()]
      : await this.prisma.ingredient.findMany({ where: { restaurantId, kind: 'RAW', isActive: true, ...(input.category && { category: input.category }) }, include: { units: true } });
    if (!ingredients.length) throw fail('bad', 'VALIDATION_FAILED', 'There is nothing to count.');
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const open = await tx.stockCount.findFirst({ where: { branchId: branch.id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } }, select: { id: true } });
        if (open) throw fail('conflict', CODES.COUNT_ALREADY_OPEN, 'This branch already has an open stock count.', { countId: open.id });
        const stock = new Map((await tx.inventoryStock.findMany({ where: { branchId: branch.id, ingredientId: { in: ingredients.map((row) => row.id) } } })).map((row) => [row.ingredientId, row.onHand]));
        const created = await tx.stockCount.create({
          data: {
            restaurantId, branchId: branch.id, note: input.note, createdById: userId,
            lines: { create: ingredients.map((ingredient) => ({ ingredientId: ingredient.id, expected: stock.get(ingredient.id) ?? ZERO })) },
          },
        });
        await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.count_created', targetType: 'inventory-count', targetId: created.id, metadata: { branchId: branch.id, lines: ingredients.length }, ipAddress }, tx);
        return created.id;
      });
      return this.countDetail(scope, id);
    } catch (error) {
      // The partial unique index: another device opened one at the same moment.
      if (isUniqueViolation(error)) throw fail('conflict', CODES.COUNT_ALREADY_OPEN, 'This branch already has an open stock count.');
      throw error;
    }
  }

  /** Counted quantities (in base units) for lines of an open count. */
  async updateCount(userId: string, id: string, input: z.output<typeof updateCountSchema>): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.waste', 'inventory.operate');
    await this.findCount(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lockCount(tx, id);
      if (status !== 'OPEN') throw countNotOpen(status);
      const onCount = new Set((await tx.stockCountLine.findMany({ where: { countId: id }, select: { ingredientId: true } })).map((line) => line.ingredientId));
      for (const line of input.lines) {
        if (!onCount.has(line.ingredientId)) throw fail('bad', CODES.COUNT_LINE_UNKNOWN, 'This ingredient is not on the count.', { ingredientId: line.ingredientId });
        await tx.stockCountLine.update({ where: { countId_ingredientId: { countId: id, ingredientId: line.ingredientId } }, data: { counted: line.counted === null ? null : dec(line.counted) } });
      }
      await tx.stockCount.update({ where: { id }, data: { ...(input.note !== undefined && { note: input.note }), updatedAt: new Date() } });
    });
    return this.countDetail(scope, id);
  }

  /**
   * Books counted − expected for every counted line as COUNT_VARIANCE (at the average cost). When
   * the settings require approval and a line is off by more than the threshold, a caller without
   * inventory.approve sends it for approval instead (PENDING_APPROVAL): stock does not change yet.
   */
  async postCount(userId: string, id: string, ipAddress?: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const count = await this.findCount(scope, id);
    const settings = await this.engine.settings(scope.restaurant.id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lockCount(tx, id);
      if (status !== 'OPEN') throw countNotOpen(status);
      const lines = await tx.stockCountLine.findMany({ where: { countId: id, counted: { not: null } } });
      const over = lines.filter((line) => overThreshold(line.expected, line.counted, settings.countVarianceThresholdPercent));
      if (settings.requireCountApproval && over.length && !scope.permissions.has('inventory.approve')) {
        await tx.stockCount.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedById: userId } });
        await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.count_submitted', targetType: 'inventory-count', targetId: id, metadata: { branchId: count.branchId, overThreshold: over.length }, ipAddress }, tx);
        return;
      }
      await this.book(tx, scope, count.branchId, id, userId, null, ipAddress);
    });
    return this.countDetail(scope, id);
  }

  /** inventory.approve: books a count that waits for approval. */
  async approveCount(userId: string, id: string, note: string | null, ipAddress?: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.approve');
    const count = await this.findCount(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lockCount(tx, id);
      if (status !== 'PENDING_APPROVAL') throw fail('conflict', CODES.COUNT_NOT_PENDING, 'This stock count is not waiting for approval.', { status });
      await this.book(tx, scope, count.branchId, id, userId, note, ipAddress);
    });
    return this.countDetail(scope, id);
  }

  /** inventory.approve: sends a count back to be counted again (it is open once more). */
  async rejectCount(userId: string, id: string, note: string | null, ipAddress?: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.approve');
    await this.findCount(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.stockCount.updateMany({ where: { id, status: 'PENDING_APPROVAL' }, data: { status: 'OPEN', reviewNote: note } });
      if (!count) throw fail('conflict', CODES.COUNT_NOT_PENDING, 'This stock count is not waiting for approval.', { status: (await tx.stockCount.findUniqueOrThrow({ where: { id }, select: { status: true } })).status });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.count_rejected', targetType: 'inventory-count', targetId: id, metadata: { note }, ipAddress }, tx);
    });
    return this.countDetail(scope, id);
  }

  private async book(tx: Tx, scope: InventoryScope, branchId: string, id: string, userId: string, note: string | null, ipAddress?: string): Promise<void> {
    await tx.stockCount.update({ where: { id }, data: { status: 'POSTED', postedAt: new Date(), postedById: userId, ...(note !== null && { reviewNote: note }) } });
    const lines = await tx.stockCountLine.findMany({ where: { countId: id, counted: { not: null } } });
    const postings: Posting[] = lines.flatMap((line) => {
      const variance = roundQuantity(line.counted!.minus(line.expected));
      return variance.isZero() ? [] : [{ branchId, ingredientId: line.ingredientId, type: 'COUNT_VARIANCE' as const, quantity: variance, sourceKey: `count:${id}:${line.ingredientId}`, countId: id }];
    });
    const posted = await this.engine.post(tx, scope.restaurant.id, postings, userId);
    // The cost the variance was valued at; unchanged lines at the current average for the record.
    const costs = new Map(posted.map((movement) => [movement.ingredientId, movement.unitCost]));
    const stock = new Map((await tx.inventoryStock.findMany({ where: { branchId, ingredientId: { in: lines.map((line) => line.ingredientId) } } })).map((row) => [row.ingredientId, row.avgCost]));
    for (const line of lines) {
      await tx.stockCountLine.update({ where: { countId_ingredientId: { countId: id, ingredientId: line.ingredientId } }, data: { unitCost: costs.get(line.ingredientId) ?? stock.get(line.ingredientId) ?? null } });
    }
    const net = posted.reduce((sum, movement) => sum.plus(movement.value), ZERO);
    await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.count_posted', targetType: 'inventory-count', targetId: id, metadata: { branchId, counted: lines.length, variances: posted.length, netValue: num(roundValue(net)), note }, ipAddress }, tx);
  }

  async cancelCount(userId: string, id: string, ipAddress?: string): Promise<StockCountDetail> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    await this.findCount(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.stockCount.updateMany({ where: { id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      if (!count) throw countNotOpen((await tx.stockCount.findUniqueOrThrow({ where: { id }, select: { status: true } })).status);
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.count_cancelled', targetType: 'inventory-count', targetId: id, ipAddress }, tx);
    });
    return this.countDetail(scope, id);
  }

  private async lockCount(tx: Tx, id: string): Promise<string> {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM inventory_counts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0]) throw countNotFound();
    return rows[0].status;
  }

  private async findCount(scope: InventoryScope, id: string) {
    const row = await this.prisma.stockCount.findFirst({ where: { id, ...(await this.access.branches.branchWhere(scope)) }, select: { id: true, branchId: true, status: true } });
    if (!row) throw countNotFound();
    return row;
  }

  private async countDetail(scope: InventoryScope, id: string): Promise<StockCountDetail> {
    const row = await this.prisma.stockCount.findFirst({ where: { id, ...(await this.access.branches.branchWhere(scope)) }, include: countInclude });
    if (!row) throw countNotFound();
    // Open counts show the variance at today's average; posted ones at the cost they were booked at.
    const averages = row.status === 'OPEN' && scope.costs
      ? new Map((await this.prisma.inventoryStock.findMany({ where: { branchId: row.branchId, ingredientId: { in: row.lines.map((line) => line.ingredientId) } }, select: { ingredientId: true, avgCost: true } })).map((stock) => [stock.ingredientId, stock.avgCost]))
      : null;
    const standard = averages
      ? new Map((await this.prisma.ingredient.findMany({ where: { id: { in: row.lines.map((line) => line.ingredientId) } }, select: { id: true, standardCost: true } })).map((ingredient) => [ingredient.id, ingredient.standardCost]))
      : null;
    const threshold = (await this.engine.settings(scope.restaurant.id)).countVarianceThresholdPercent;
    return {
      ...this.toCount(row, scope.costs, (ingredientId) => averages?.get(ingredientId) ?? standard?.get(ingredientId) ?? null),
      lines: row.lines.map((line) => {
        const variance = line.counted === null ? null : roundQuantity(line.counted.minus(line.expected));
        const cost = line.unitCost ?? averages?.get(line.ingredientId) ?? standard?.get(line.ingredientId) ?? null;
        return {
          ingredientId: line.ingredientId, nameAr: line.ingredient.nameAr, nameEn: line.ingredient.nameEn, category: line.ingredient.category,
          baseUnit: BASE_UNITS[line.ingredient.dimension].code, expected: num(line.expected), counted: numOrNull(line.counted), variance: numOrNull(variance),
          varianceValue: scope.costs && variance !== null ? num(valueOf(variance, cost ?? ZERO)) : null,
          overThreshold: overThreshold(line.expected, line.counted, threshold),
        };
      }),
    };
  }

  private toCount(row: CountRow, costs: boolean, cost: (ingredientId: string) => Decimal | null = () => null): StockCount {
    const counted = row.lines.filter((line) => line.counted !== null);
    const value = counted.reduce((sum, line) => sum.plus(valueOf(line.counted!.minus(line.expected), line.unitCost ?? cost(line.ingredientId) ?? ZERO)), ZERO);
    return {
      id: row.id, branchId: row.branchId, branchName: row.branch.name, status: row.status, note: row.note, lineCount: row.lines.length, countedLines: counted.length,
      varianceValue: costs ? num(roundValue(value)) : null, createdBy: row.createdBy?.fullName ?? null, createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null, submittedBy: row.submittedBy?.fullName ?? null, reviewNote: row.reviewNote,
      postedAt: row.postedAt?.toISOString() ?? null, postedBy: row.postedBy?.fullName ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null,
    };
  }

  // --- Transfers -----------------------------------------------------------------------------------

  async transfers(userId: string, query: z.output<typeof transfersQuerySchema>): Promise<Paginated<StockTransfer>> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const own = await this.access.branches.branchWhere(scope, query.branchId);
    const where: Prisma.StockTransferWhereInput = {
      restaurantId: scope.restaurant.id,
      ...(own.branchId && { OR: [{ fromBranchId: own.branchId }, { toBranchId: own.branchId }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({ where, include: transferInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return { items: rows.map((row) => this.toTransfer(row, scope.costs)), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * The branches a transfer from `branchId` (the caller's own, or the main branch) may go to: the
   * restaurant's other active branches, as id, name and slug only. A branch-tied caller sends from
   * their branch only (another branch is refused, as everywhere), but to any branch.
   */
  async transferDestinations(userId: string, branchId?: string): Promise<TransferDestination[]> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const from = await this.access.branches.branch(scope, branchId);
    return this.prisma.branch.findMany({
      where: { restaurantId: scope.restaurant.id, isActive: true, id: { not: from.id } },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, slug: true },
    });
  }

  /** Out of the sender at its average cost, into the receiver at that same cost, in one step. */
  async createTransfer(userId: string, input: z.output<typeof createTransferSchema>, ipAddress?: string): Promise<StockTransfer> {
    const scope = await this.access.scope(userId, 'inventory.operate');
    const from = await this.access.branches.branch(scope, input.fromBranchId);
    // The receiving branch may be any branch of the restaurant, even for staff tied to the sender.
    const to = await this.prisma.branch.findFirst({ where: { id: input.toBranchId, restaurantId: scope.restaurant.id } });
    if (!to) throw branchNotFound();
    if (to.id === from.id) throw fail('bad', CODES.SAME_BRANCH, 'Choose another branch to transfer to.');
    // An archived branch takes no new stock (it can still send its leftovers out).
    if (!to.isActive) throw fail('conflict', BRANCH_ERROR_CODES.BRANCH_ARCHIVED, 'This branch is archived. Restore it before sending it stock.');
    const ingredients = await this.rawIngredients(scope, input.lines.map((line) => line.ingredientId), true);
    const lines = input.lines.map((line) => {
      const ingredient = ingredients.get(line.ingredientId)!;
      return { ingredientId: ingredient.id, quantity: toBaseQuantity(dec(line.quantity), this.unitOf(ingredient, line.unitId).factor) };
    });
    const restaurantId = scope.restaurant.id;
    const id = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({ data: { restaurantId, fromBranchId: from.id, toBranchId: to.id, note: input.note, createdById: userId } });
      // Both branches' rows are locked together, in id order, so transfers both ways cannot deadlock.
      await this.engine.lock(tx, restaurantId, lines.flatMap((line) => [{ branchId: from.id, ingredientId: line.ingredientId }, { branchId: to.id, ingredientId: line.ingredientId }]));
      const out = await this.engine.post(tx, restaurantId, lines.map((line, index) => ({
        branchId: from.id, ingredientId: line.ingredientId, type: 'TRANSFER_OUT' as const, quantity: line.quantity.neg(), sourceKey: `transfer:${transfer.id}:${index}:out`, transferId: transfer.id, note: input.note,
      })), userId);
      await this.engine.post(tx, restaurantId, out.map((movement, index) => ({
        branchId: to.id, ingredientId: movement.ingredientId, type: 'TRANSFER_IN' as const, quantity: movement.quantity.neg(), unitCost: movement.unitCost, sourceKey: `transfer:${transfer.id}:${index}:in`, transferId: transfer.id, note: input.note,
      })), userId);
      await tx.stockTransferLine.createMany({
        data: out.map((movement, sortOrder) => ({ transferId: transfer.id, ingredientId: movement.ingredientId, quantity: movement.quantity.neg(), unitCost: movement.unitCost, value: movement.value.neg(), sortOrder })),
      });
      const total = roundValue(out.reduce((sum, movement) => sum.minus(movement.value), ZERO));
      await tx.stockTransfer.update({ where: { id: transfer.id }, data: { total } });
      await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.transfer', targetType: 'inventory-transfer', targetId: transfer.id, metadata: { from: from.id, to: to.id, lines: lines.length, total: num(total) }, ipAddress }, tx);
      return transfer.id;
    });
    return this.toTransfer(await this.prisma.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude }), scope.costs);
  }

  private toTransfer(row: Prisma.StockTransferGetPayload<{ include: typeof transferInclude }>, costs: boolean): StockTransfer {
    return {
      id: row.id, fromBranch: row.fromBranch, toBranch: row.toBranch, note: row.note, total: costs ? num(row.total) : null,
      lines: row.lines.map((line) => ({
        ingredientId: line.ingredientId, nameAr: line.ingredient.nameAr, nameEn: line.ingredient.nameEn, baseUnit: BASE_UNITS[line.ingredient.dimension].code,
        quantity: num(line.quantity), unitCost: costs ? num(line.unitCost) : null, value: costs ? num(line.value) : null,
      })),
      createdBy: row.createdBy?.fullName ?? null, createdAt: row.createdAt.toISOString(),
    };
  }

  // --- Helpers -------------------------------------------------------------------------------------

  /** Ingredients of the restaurant that hold stock (raw), with their units; archived ones refused when `activeOnly`. */
  private async rawIngredients(scope: InventoryScope, ids: readonly string[], activeOnly: boolean) {
    const rows = await this.prisma.ingredient.findMany({ where: { id: { in: [...new Set(ids)] }, restaurantId: scope.restaurant.id }, include: { units: true } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw ingredientNotFound();
      if (row.kind !== 'RAW') throw fail('bad', CODES.NOT_RAW, 'A prepared ingredient holds no stock: buy, count or transfer its components.', { ingredientId: id });
      if (activeOnly && !row.isActive) throw fail('bad', CODES.INGREDIENT_ARCHIVED, 'This ingredient is archived.', { ingredientId: id });
    }
    return byId;
  }

  /** The chosen unit of an ingredient, or its base unit. */
  private unitOf(
    ingredient: { id: string; units: { id: string; nameAr: string; nameEn: string | null; factor: Decimal }[] },
    unitId: string | null,
  ): { id: string | null; nameAr: string | null; nameEn: string | null; factor: Decimal } {
    if (!unitId) return { id: null, nameAr: null, nameEn: null, factor: dec(1) };
    const unit = ingredient.units.find((candidate) => candidate.id === unitId);
    if (!unit) throw fail('bad', CODES.UNIT_NOT_FOUND, 'This unit does not belong to the ingredient.', { ingredientId: ingredient.id, unitId });
    return { id: unit.id, nameAr: unit.nameAr, nameEn: unit.nameEn, factor: unit.factor };
  }
}

