import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  countsQuerySchema,
  createCountSchema,
  createIngredientSchema,
  createPurchaseSchema,
  createSupplierSchema,
  createTransferSchema,
  createWasteSchema,
  type FoodCostReport,
  foodCostQuerySchema,
  type Ingredient,
  ingredientsQuerySchema,
  ingredientUnitsSchema,
  inventoryBranchQuerySchema,
  type InventoryCosting,
  type InventoryDishes,
  type InventorySettings,
  inventorySettingsSchema,
  type InventoryStock,
  type InventorySupplier,
  type LowStockReport,
  lowStockQuerySchema,
  menuEngineeringQuerySchema,
  type MenuEngineeringReport,
  movementsQuerySchema,
  type Paginated,
  preparedRecipeSchema,
  type Purchase,
  type PurchaseDetail,
  purchasesQuerySchema,
  type ReorderReport,
  reviewCountSchema,
  type StockCount,
  type StockCountDetail,
  stockLevelsSchema,
  type StockMovement,
  type StockRow,
  type StockTransfer,
  type TransferDestination,
  transfersQuerySchema,
  updateCountSchema,
  updateIngredientSchema,
  updatePurchaseSchema,
  updateSupplierSchema,
  type ValuationReport,
  type VariantRecipe,
  variantRecipeSchema,
  voidPurchaseSchema,
  type WasteEntry,
  wasteQuerySchema,
} from '@bilhanah/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { InventoryCatalogService } from './inventory-catalog.service.js';
import { InventoryOperationsService } from './inventory-operations.service.js';
import { InventoryReportsService } from './inventory-reports.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const branchQuery = new ZodValidationPipe(inventoryBranchQuerySchema);
const WRITE_LIMIT = { name: 'inventory-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

type BranchQuery = z.output<typeof inventoryBranchQuerySchema>;

/**
 * Inventory, recipes and costs (docs/INVENTORY.md). inventory.view reads stock, the ledger and the
 * catalogue; inventory.waste records waste and counted quantities; inventory.operate receives
 * purchases, posts counts and transfers; inventory.manage edits ingredients, recipes, suppliers,
 * levels and settings; inventory.costs reveals costs and the cost reports. The plan must include
 * inventory (409 INVENTORY_UNAVAILABLE otherwise); the services check branch scope.
 */
@Controller('inventory')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('inventory.view', 'inventory.manage', 'inventory.costs', 'inventory.approve')
export class InventoryController {
  constructor(
    private readonly catalog: InventoryCatalogService,
    private readonly operations: InventoryOperationsService,
    private readonly reports: InventoryReportsService,
  ) {}

  // --- Settings ---

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(@CurrentAuth() auth: AuthContext): Promise<InventorySettings> {
    return this.catalog.getSettings(auth.userId);
  }

  @Put('settings')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  updateSettings(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(inventorySettingsSchema)) body: z.output<typeof inventorySettingsSchema>): Promise<InventorySettings> {
    return this.catalog.updateSettings(auth.userId, body, request.ip);
  }

  // --- Ingredients ---

  @Get('ingredients')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  ingredients(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(ingredientsQuerySchema)) query: z.output<typeof ingredientsQuerySchema>): Promise<Ingredient[]> {
    return this.catalog.ingredients(auth.userId, query);
  }

  @Post('ingredients')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  createIngredient(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createIngredientSchema)) body: z.output<typeof createIngredientSchema>): Promise<Ingredient> {
    return this.catalog.createIngredient(auth.userId, body, request.ip);
  }

  @Patch('ingredients/:id')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  updateIngredient(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateIngredientSchema)) body: z.output<typeof updateIngredientSchema>,
  ): Promise<Ingredient> {
    return this.catalog.updateIngredient(auth.userId, id, body, request.ip);
  }

  @Delete('ingredients/:id')
  @RequirePermission('inventory.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  deleteIngredient(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<void> {
    return this.catalog.deleteIngredient(auth.userId, id, request.ip);
  }

  @Put('ingredients/:id/units')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  setUnits(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(ingredientUnitsSchema)) body: z.output<typeof ingredientUnitsSchema>): Promise<Ingredient> {
    return this.catalog.setUnits(auth.userId, id, body);
  }

  @Put('ingredients/:id/recipe')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  setPreparedRecipe(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(preparedRecipeSchema)) body: z.output<typeof preparedRecipeSchema>,
  ): Promise<Ingredient> {
    return this.catalog.setPreparedRecipe(auth.userId, id, body, request.ip);
  }

  // --- Dish recipes and costing ---

  @Get('recipes/variants/:variantId')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  variantRecipe(@CurrentAuth() auth: AuthContext, @Param('variantId', idParam) variantId: string, @Query(branchQuery) query: BranchQuery): Promise<VariantRecipe> {
    return this.catalog.variantRecipe(auth.userId, variantId, query.branchId);
  }

  @Put('recipes/variants/:variantId')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  setVariantRecipe(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('variantId', idParam) variantId: string,
    @Body(new ZodValidationPipe(variantRecipeSchema)) body: z.output<typeof variantRecipeSchema>,
  ): Promise<VariantRecipe> {
    return this.catalog.setVariantRecipe(auth.userId, variantId, body, request.ip);
  }

  @Get('costing')
  @RequirePermission('inventory.costs')
  @Header('Cache-Control', 'no-store')
  costing(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<InventoryCosting> {
    return this.catalog.costing(auth.userId, query.branchId);
  }

  /** Every dish size and its recipe's ingredients, without costs or prices. */
  @Get('dishes')
  @RequireAnyPermission('inventory.view', 'inventory.waste')
  @Header('Cache-Control', 'no-store')
  dishes(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<InventoryDishes> {
    return this.catalog.dishes(auth.userId, query.branchId);
  }

  // --- Suppliers ---

  @Get('suppliers')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  suppliers(@CurrentAuth() auth: AuthContext): Promise<InventorySupplier[]> {
    return this.catalog.suppliers(auth.userId);
  }

  @Post('suppliers')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  createSupplier(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createSupplierSchema)) body: z.output<typeof createSupplierSchema>): Promise<InventorySupplier> {
    return this.catalog.createSupplier(auth.userId, body);
  }

  @Patch('suppliers/:id')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  updateSupplier(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateSupplierSchema)) body: z.output<typeof updateSupplierSchema>): Promise<InventorySupplier> {
    return this.catalog.updateSupplier(auth.userId, id, body);
  }

  @Delete('suppliers/:id')
  @RequirePermission('inventory.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  deleteSupplier(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.catalog.deleteSupplier(auth.userId, id);
  }

  // --- Stock and the ledger ---

  @Get('stock')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  stock(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<InventoryStock> {
    return this.catalog.stock(auth.userId, query.branchId);
  }

  @Patch('stock/:ingredientId')
  @RequirePermission('inventory.manage')
  @RateLimit(WRITE_LIMIT)
  setStockLevels(
    @CurrentAuth() auth: AuthContext,
    @Param('ingredientId', idParam) ingredientId: string,
    @Query(branchQuery) query: BranchQuery,
    @Body(new ZodValidationPipe(stockLevelsSchema)) body: z.output<typeof stockLevelsSchema>,
  ): Promise<StockRow> {
    return this.catalog.setStockLevels(auth.userId, ingredientId, query.branchId, body);
  }

  @Get('movements')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  movements(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(movementsQuerySchema)) query: z.output<typeof movementsQuerySchema>): Promise<Paginated<StockMovement>> {
    return this.catalog.movements(auth.userId, query);
  }

  // --- Purchases ---

  @Get('purchases')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  purchases(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(purchasesQuerySchema)) query: z.output<typeof purchasesQuerySchema>): Promise<Paginated<Purchase>> {
    return this.operations.purchases(auth.userId, query);
  }

  @Post('purchases')
  @RequirePermission('inventory.operate')
  @RateLimit(WRITE_LIMIT)
  createPurchase(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createPurchaseSchema)) body: z.output<typeof createPurchaseSchema>): Promise<PurchaseDetail> {
    return this.operations.createPurchase(auth.userId, body, request.ip);
  }

  @Get('purchases/:id')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  purchase(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<PurchaseDetail> {
    return this.operations.purchase(auth.userId, id);
  }

  @Patch('purchases/:id')
  @RequirePermission('inventory.operate')
  @RateLimit(WRITE_LIMIT)
  updatePurchase(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updatePurchaseSchema)) body: z.output<typeof updatePurchaseSchema>): Promise<PurchaseDetail> {
    return this.operations.updatePurchase(auth.userId, id, body);
  }

  @Post('purchases/:id/receive')
  @RequirePermission('inventory.operate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  receivePurchase(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<PurchaseDetail> {
    return this.operations.receivePurchase(auth.userId, id, request.ip);
  }

  @Post('purchases/:id/void')
  @RequirePermission('inventory.operate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  voidPurchase(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(voidPurchaseSchema)) body: z.output<typeof voidPurchaseSchema>,
  ): Promise<PurchaseDetail> {
    return this.operations.voidPurchase(auth.userId, id, body, request.ip);
  }

  // --- Waste ---

  @Get('waste')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  waste(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(wasteQuerySchema)) query: z.output<typeof wasteQuerySchema>): Promise<Paginated<WasteEntry>> {
    return this.operations.waste(auth.userId, query);
  }

  @Post('waste')
  @RequirePermission('inventory.waste')
  @RateLimit(WRITE_LIMIT)
  recordWaste(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createWasteSchema)) body: z.output<typeof createWasteSchema>): Promise<WasteEntry> {
    return this.operations.recordWaste(auth.userId, body, request.ip);
  }

  // --- Stock counts ---

  @Get('counts')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  counts(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(countsQuerySchema)) query: z.output<typeof countsQuerySchema>): Promise<Paginated<StockCount>> {
    return this.operations.counts(auth.userId, query);
  }

  @Post('counts')
  @RequirePermission('inventory.operate')
  @RateLimit(WRITE_LIMIT)
  createCount(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createCountSchema)) body: z.output<typeof createCountSchema>): Promise<StockCountDetail> {
    return this.operations.createCount(auth.userId, body, request.ip);
  }

  @Get('counts/:id')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  count(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<StockCountDetail> {
    return this.operations.count(auth.userId, id);
  }

  @Patch('counts/:id')
  @RequireAnyPermission('inventory.waste', 'inventory.operate')
  @RateLimit(WRITE_LIMIT)
  updateCount(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateCountSchema)) body: z.output<typeof updateCountSchema>): Promise<StockCountDetail> {
    return this.operations.updateCount(auth.userId, id, body);
  }

  @Post('counts/:id/post')
  @RequirePermission('inventory.operate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  postCount(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<StockCountDetail> {
    return this.operations.postCount(auth.userId, id, request.ip);
  }

  @Post('counts/:id/approve')
  @RequirePermission('inventory.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  approveCount(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewCountSchema)) body: z.output<typeof reviewCountSchema>): Promise<StockCountDetail> {
    return this.operations.approveCount(auth.userId, id, body.note, request.ip);
  }

  @Post('counts/:id/reject')
  @RequirePermission('inventory.approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  rejectCount(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(reviewCountSchema)) body: z.output<typeof reviewCountSchema>): Promise<StockCountDetail> {
    return this.operations.rejectCount(auth.userId, id, body.note, request.ip);
  }

  @Post('counts/:id/cancel')
  @RequirePermission('inventory.operate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  cancelCount(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Param('id', idParam) id: string): Promise<StockCountDetail> {
    return this.operations.cancelCount(auth.userId, id, request.ip);
  }

  // --- Transfers ---

  @Get('transfers')
  @RequirePermission('inventory.operate')
  @Header('Cache-Control', 'no-store')
  transfers(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(transfersQuerySchema)) query: z.output<typeof transfersQuerySchema>): Promise<Paginated<StockTransfer>> {
    return this.operations.transfers(auth.userId, query);
  }

  /** The other active branches a transfer from the branch may go to (id, name, slug only). */
  @Get('transfer-destinations')
  @RequirePermission('inventory.operate')
  @Header('Cache-Control', 'no-store')
  transferDestinations(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<TransferDestination[]> {
    return this.operations.transferDestinations(auth.userId, query.branchId);
  }

  @Post('transfers')
  @RequirePermission('inventory.operate')
  @RateLimit(WRITE_LIMIT)
  createTransfer(@CurrentAuth() auth: AuthContext, @Req() request: Request, @Body(new ZodValidationPipe(createTransferSchema)) body: z.output<typeof createTransferSchema>): Promise<StockTransfer> {
    return this.operations.createTransfer(auth.userId, body, request.ip);
  }

  // --- Reports ---

  @Get('reports/valuation')
  @RequirePermission('inventory.costs')
  @Header('Cache-Control', 'no-store')
  valuation(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<ValuationReport> {
    return this.reports.valuation(auth.userId, query.branchId);
  }

  @Get('reports/reorder')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  reorder(@CurrentAuth() auth: AuthContext, @Query(branchQuery) query: BranchQuery): Promise<ReorderReport> {
    return this.reports.reorder(auth.userId, query.branchId);
  }

  @Get('reports/low-stock')
  @RequirePermission('inventory.view')
  @Header('Cache-Control', 'no-store')
  lowStock(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(lowStockQuerySchema)) query: z.output<typeof lowStockQuerySchema>): Promise<LowStockReport> {
    return this.reports.lowStock(auth.userId, query);
  }

  @Get('reports/food-cost')
  @RequirePermission('inventory.costs')
  @Header('Cache-Control', 'no-store')
  foodCost(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(foodCostQuerySchema)) query: z.output<typeof foodCostQuerySchema>): Promise<FoodCostReport> {
    return this.reports.foodCost(auth.userId, query);
  }

  @Get('reports/menu-engineering')
  @RequirePermission('inventory.costs')
  @Header('Cache-Control', 'no-store')
  menuEngineering(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(menuEngineeringQuerySchema)) query: z.output<typeof menuEngineeringQuerySchema>): Promise<MenuEngineeringReport> {
    return this.reports.menuEngineering(auth.userId, query);
  }
}
