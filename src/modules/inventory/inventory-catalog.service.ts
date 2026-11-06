import { Injectable } from '@nestjs/common';
import {
  BASE_UNITS,
  type createIngredientSchema,
  type createSupplierSchema,
  type CostingRow,
  type DishRecipeLine,
  type Ingredient,
  type IngredientLockReason,
  type ingredientsQuerySchema,
  type ingredientUnitsSchema,
  INVENTORY_ERROR_CODES as CODES,
  INVENTORY_LIMITS,
  type InventoryCosting,
  type InventoryDishes,
  type InventorySettings,
  type inventorySettingsSchema,
  type InventoryValuationBasis,
  type InventoryStock,
  type InventorySupplier,
  type movementsQuerySchema,
  type Paginated,
  type preparedRecipeSchema,
  type RecipeLine,
  type StockMovement,
  type StockRow,
  type stockLevelsSchema,
  type updateIngredientSchema,
  type updateSupplierSchema,
  type VariantRecipe,
  type variantRecipeSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { branchNotFound } from '../branches/branch-scope.service.js';
import { fail, ingredientNotFound, InventoryAccess, type InventoryScope, localDayRange, supplierNotFound, type Tx, variantNotFound } from './inventory-access.service.js';
import { type IngredientInfo, InventoryEngine, type RestaurantRecipes } from './inventory-engine.service.js';
import {
  assertValidGraph,
  assertValidPrepared,
  type Decimal,
  dec,
  decOrNull,
  explode,
  foodCostPercent,
  num,
  numOrNull,
  preparedUnitCost,
  type RecipeGraph,
  type RecipeLineInput,
  RecipeCycleError,
  RecipeDepthError,
  recipeCost,
  roundQuantity,
  roundUnitCost,
  roundValue,
  stockStatus,
  usageOf,
  ZERO,
} from './inventory-math.js';

type RecipeLineBody = z.output<typeof variantRecipeSchema>['lines'];

const ingredientInclude = {
  units: { orderBy: { sortOrder: 'asc' } },
  preferredSupplier: { select: { id: true, name: true } },
  recipe: { orderBy: { sortOrder: 'asc' }, select: { ingredientId: true, quantity: true, wastePercent: true } },
} satisfies Prisma.IngredientInclude;
type IngredientRow = Prisma.IngredientGetPayload<{ include: typeof ingredientInclude }>;

const nameTaken = () => fail('conflict', CODES.INGREDIENT_NAME_TAKEN, 'Another ingredient has this name.');
const supplierNameTaken = () => fail('conflict', CODES.SUPPLIER_NAME_TAKEN, 'Another supplier has this name.');

/** Turns a recipe validation error into the API's 400. */
export function recipeError(error: unknown): never {
  if (error instanceof RecipeCycleError) throw fail('bad', CODES.RECIPE_CYCLE, 'A prepared ingredient cannot use itself, directly or through another one.', { path: error.path });
  if (error instanceof RecipeDepthError) throw fail('bad', CODES.RECIPE_TOO_DEEP, `Prepared ingredients nest at most ${INVENTORY_LIMITS.maxPrepDepth} levels.`, { path: error.path });
  throw error;
}

/** Costs at one branch: any ingredient's unit cost (prepared ones through their recipe). */
export type BranchCosts = { raw: (id: string) => Decimal | null; any: (id: string) => Decimal | null };

/**
 * Settings, ingredients and their units, recipes (dish sizes and prepared ingredients), suppliers,
 * costing, stock levels and the ledger. Every id is checked against the caller's restaurant (other
 * restaurants' look unknown) and branch ids through BranchScopeService.
 */
@Injectable()
export class InventoryCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InventoryAccess,
    private readonly engine: InventoryEngine,
    private readonly audit: AuditService,
  ) {}

  // --- Settings ------------------------------------------------------------------------------------

  async getSettings(userId: string): Promise<InventorySettings> {
    const scope = await this.access.scope(userId, 'inventory.view', 'inventory.manage');
    return this.settingsView(scope);
  }

  /** Changes any of the rules (the others stay); `branches` replaces the branch overrides of the branches given. */
  async updateSettings(userId: string, input: z.output<typeof inventorySettingsSchema>, ipAddress?: string): Promise<InventorySettings> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const restaurantId = scope.restaurant.id;
    const { branches, countVarianceThresholdPercent, ...fields } = input;
    if (branches?.length) {
      const known = await this.prisma.branch.count({ where: { id: { in: branches.map((row) => row.branchId) }, restaurantId } });
      if (known !== branches.length) throw branchNotFound();
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await this.engine.settings(restaurantId, tx);
      const data = {
        ...fields,
        ...(countVarianceThresholdPercent !== undefined && { countVarianceThresholdPercent: dec(countVarianceThresholdPercent) }),
        ...(fields.wasteReasons && { wasteReasons: fields.wasteReasons }),
        updatedById: userId,
      };
      await tx.inventorySettings.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
      for (const row of branches ?? []) {
        const own = { stockPolicy: row.stockPolicy, autoSoldOut: row.autoSoldOut, autoRestore: row.autoRestore };
        if (own.stockPolicy === null && own.autoSoldOut === null && own.autoRestore === null) await tx.inventoryBranchSettings.deleteMany({ where: { branchId: row.branchId } });
        else await tx.inventoryBranchSettings.upsert({ where: { branchId: row.branchId }, create: { branchId: row.branchId, restaurantId, ...own }, update: own });
      }
      // Where auto sold-out no longer applies (switched off, or inventory off), the marks it set are lifted; manual marks stay.
      const after = await this.engine.settings(restaurantId, tx);
      const all = (await tx.branch.findMany({ where: { restaurantId }, select: { id: true } })).map((branch) => branch.id);
      const rules = await this.engine.branchRules(after, all, tx);
      await this.engine.clearSoldOut(tx, restaurantId, all.filter((id) => !after.enabled || !rules.get(id)!.autoSoldOut));
      await this.audit.record({
        actorId: userId, restaurantId, action: 'inventory.settings', targetType: 'inventory-settings', targetId: restaurantId,
        metadata: { from: { ...before, countVarianceThresholdPercent: num(before.countVarianceThresholdPercent), updatedAt: undefined }, changes: input } as Prisma.InputJsonValue, ipAddress,
      }, tx);
    });
    return this.settingsView(scope);
  }

  private async settingsView(scope: InventoryScope): Promise<InventorySettings> {
    const settings = await this.engine.settings(scope.restaurant.id);
    const branches = await this.access.branches.visibleBranches(scope);
    const own = new Map((await this.prisma.inventoryBranchSettings.findMany({ where: { branchId: { in: branches.map((branch) => branch.id) } } })).map((row) => [row.branchId, row]));
    const rules = await this.engine.branchRules(settings, branches.map((branch) => branch.id));
    return {
      enabled: settings.enabled, deductOn: settings.deductOn, stockPolicy: settings.stockPolicy, autoSoldOut: settings.autoSoldOut, autoRestore: settings.autoRestore,
      valuationBasis: settings.valuationBasis, wasteReasons: settings.wasteReasons, requireCountApproval: settings.requireCountApproval,
      countVarianceThresholdPercent: num(settings.countVarianceThresholdPercent),
      branches: branches.map((branch) => ({
        branchId: branch.id, branchName: branch.name,
        stockPolicy: own.get(branch.id)?.stockPolicy ?? null, autoSoldOut: own.get(branch.id)?.autoSoldOut ?? null, autoRestore: own.get(branch.id)?.autoRestore ?? null,
        effective: rules.get(branch.id)!,
      })),
      updatedAt: settings.updatedAt?.toISOString() ?? null,
    };
  }

  // --- Ingredients ---------------------------------------------------------------------------------

  async ingredients(userId: string, query: z.output<typeof ingredientsQuerySchema>): Promise<Ingredient[]> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const branch = await this.access.branches.branch(scope, query.branchId);
    const rows = await this.prisma.ingredient.findMany({
      where: { restaurantId: scope.restaurant.id, ...(!query.includeInactive && { isActive: true }) },
      include: ingredientInclude,
      orderBy: [{ category: 'asc' }, { nameAr: 'asc' }],
    });
    const recipes = await this.engine.recipes(scope.restaurant.id);
    const costs = scope.costs ? await this.branchCosts(branch.id, recipes) : null;
    const ids = rows.map((row) => row.id);
    const [used, locks] = await Promise.all([this.usedInCounts(ids), this.lockReasons(ids)]);
    return rows.map((row) => this.toIngredient(row, recipes, costs, used.get(row.id) ?? 0, locks.get(row.id) ?? null, scope.costs));
  }

  async ingredient(scope: InventoryScope, id: string): Promise<Ingredient> {
    const row = await this.prisma.ingredient.findFirst({ where: { id, restaurantId: scope.restaurant.id }, include: ingredientInclude });
    if (!row) throw ingredientNotFound();
    const branch = await this.access.branches.branch(scope);
    const recipes = await this.engine.recipes(scope.restaurant.id);
    const costs = scope.costs ? await this.branchCosts(branch.id, recipes) : null;
    const [used, locks] = await Promise.all([this.usedInCounts([id]), this.lockReasons([id])]);
    return this.toIngredient(row, recipes, costs, used.get(id) ?? 0, locks.get(id) ?? null, scope.costs);
  }

  async createIngredient(userId: string, input: z.output<typeof createIngredientSchema>, ipAddress?: string): Promise<Ingredient> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const restaurantId = scope.restaurant.id;
    if ((await this.prisma.ingredient.count({ where: { restaurantId } })) >= INVENTORY_LIMITS.ingredients) {
      throw fail('conflict', CODES.LIMIT_REACHED, `A restaurant can have at most ${INVENTORY_LIMITS.ingredients} ingredients.`, { limit: INVENTORY_LIMITS.ingredients });
    }
    if (input.preferredSupplierId) await this.assertSupplier(restaurantId, input.preferredSupplierId);
    const { units, standardCost, defaultReorderPoint, ...fields } = input;
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.ingredient.create({
          data: {
            ...fields, restaurantId, standardCost: decOrNull(standardCost), defaultReorderPoint: decOrNull(defaultReorderPoint),
            units: { create: units.map((unit, sortOrder) => ({ ...unit, factor: dec(unit.factor), sortOrder })) },
          },
        });
        await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.ingredient_created', targetType: 'ingredient', targetId: created.id, metadata: { nameAr: input.nameAr, kind: input.kind, dimension: input.dimension }, ipAddress }, tx);
        return created.id;
      });
      return this.ingredient(scope, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateIngredient(userId: string, id: string, input: z.output<typeof updateIngredientSchema>, ipAddress?: string): Promise<Ingredient> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const restaurantId = scope.restaurant.id;
    const current = await this.prisma.ingredient.findFirst({ where: { id, restaurantId } });
    if (!current) throw ingredientNotFound();
    if (input.preferredSupplierId) await this.assertSupplier(restaurantId, input.preferredSupplierId);
    const kindChanged = input.kind !== undefined && input.kind !== current.kind;
    const dimensionChanged = input.dimension !== undefined && input.dimension !== current.dimension;
    if ((kindChanged || dimensionChanged) && (await this.isLocked(id))) {
      throw fail('conflict', CODES.INGREDIENT_LOCKED, 'This ingredient already has stock movements or is used in recipes: its kind and unit cannot change.');
    }
    const { standardCost, defaultReorderPoint, ...fields } = input;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (kindChanged && input.kind === 'RAW') {
          // No longer made in-house: its recipe goes.
          await tx.recipeLine.deleteMany({ where: { preparedIngredientId: id } });
        }
        await tx.ingredient.update({
          where: { id },
          data: {
            ...fields, ...(standardCost !== undefined && { standardCost: decOrNull(standardCost) }),
            ...(defaultReorderPoint !== undefined && { defaultReorderPoint: decOrNull(defaultReorderPoint) }), ...(kindChanged && input.kind === 'RAW' && { yieldQuantity: null }) },
        });
        await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.ingredient_updated', targetType: 'ingredient', targetId: id, metadata: { changes: input }, ipAddress }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    return this.ingredient(scope, id);
  }

  /** Only an unused ingredient is deleted; one with history is archived instead (isActive: false). */
  async deleteIngredient(userId: string, id: string, ipAddress?: string): Promise<void> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const current = await this.prisma.ingredient.findFirst({ where: { id, restaurantId: scope.restaurant.id }, select: { id: true, nameAr: true } });
    if (!current) throw ingredientNotFound();
    if (await this.isLocked(id)) throw fail('conflict', CODES.INGREDIENT_IN_USE, 'This ingredient has history or is used in recipes. Archive it instead.');
    await this.prisma.$transaction(async (tx) => {
      await tx.ingredient.delete({ where: { id } });
      await this.audit.record({ actorId: userId, restaurantId: scope.restaurant.id, action: 'inventory.ingredient_deleted', targetType: 'ingredient', targetId: id, metadata: { nameAr: current.nameAr }, ipAddress }, tx);
    });
  }

  /** Replaces the purchase units. Units used on purchases keep their name and factor there. */
  async setUnits(userId: string, id: string, input: z.output<typeof ingredientUnitsSchema>): Promise<Ingredient> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const current = await this.prisma.ingredient.findFirst({ where: { id, restaurantId: scope.restaurant.id }, include: { units: true } });
    if (!current) throw ingredientNotFound();
    const names = input.units.map((unit) => unit.nameAr);
    if (new Set(names).size !== names.length) throw fail('bad', CODES.DUPLICATE_LINE, 'Two units have the same name.');
    await this.prisma.$transaction(async (tx) => {
      // Matched by name, so a unit chosen on a draft purchase keeps its id.
      const keep = new Map(current.units.map((unit) => [unit.nameAr, unit.id]));
      await tx.ingredientUnit.deleteMany({ where: { ingredientId: id, nameAr: { notIn: names } } });
      for (const [sortOrder, unit] of input.units.entries()) {
        const existing = keep.get(unit.nameAr);
        const data = { nameEn: unit.nameEn, factor: dec(unit.factor), sortOrder };
        if (existing) await tx.ingredientUnit.update({ where: { id: existing }, data });
        else await tx.ingredientUnit.create({ data: { ...data, ingredientId: id, nameAr: unit.nameAr } });
      }
    });
    return this.ingredient(scope, id);
  }

  /** A prepared ingredient's recipe and yield; refuses cycles and nesting deeper than allowed. */
  async setPreparedRecipe(userId: string, id: string, input: z.output<typeof preparedRecipeSchema>, ipAddress?: string): Promise<Ingredient> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const restaurantId = scope.restaurant.id;
    const current = await this.prisma.ingredient.findFirst({ where: { id, restaurantId } });
    if (!current) throw ingredientNotFound();
    if (current.kind !== 'PREPARED') throw fail('bad', CODES.NOT_PREPARED, 'Only a prepared ingredient has a recipe of its own.');
    await this.prisma.$transaction(async (tx) => {
      await this.lockRecipes(tx, restaurantId);
      const recipes = await this.engine.recipes(restaurantId, tx);
      this.assertLines(recipes, input.lines);
      const graph = new Map(recipes.graph);
      graph.set(id, { kind: 'PREPARED', yieldQuantity: decOrNull(input.yieldQuantity), lines: this.toInputs(input.lines) });
      try {
        // This recipe first (so the error names its own path), then everything that uses it.
        assertValidPrepared(graph, id);
        assertValidGraph(graph);
      } catch (error) {
        recipeError(error);
      }
      await tx.recipeLine.deleteMany({ where: { preparedIngredientId: id } });
      await tx.recipeLine.createMany({ data: this.toInputs(input.lines).map((line, sortOrder) => ({ ...line, preparedIngredientId: id, sortOrder })) });
      await tx.ingredient.update({ where: { id }, data: { yieldQuantity: input.lines.length ? decOrNull(input.yieldQuantity) : null } });
      await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.recipe_changed', targetType: 'ingredient', targetId: id, metadata: { yieldQuantity: input.yieldQuantity, lines: input.lines }, ipAddress }, tx);
    });
    return this.ingredient(scope, id);
  }

  // --- Dish recipes and costing ---------------------------------------------------------------------

  async variantRecipe(userId: string, variantId: string, branchId?: string): Promise<VariantRecipe> {
    const scope = await this.access.scope(userId, 'inventory.view');
    return this.recipeView(scope, variantId, branchId);
  }

  async setVariantRecipe(userId: string, variantId: string, input: z.output<typeof variantRecipeSchema>, ipAddress?: string): Promise<VariantRecipe> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const restaurantId = scope.restaurant.id;
    const variant = await this.findVariant(restaurantId, variantId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockRecipes(tx, restaurantId);
      const recipes = await this.engine.recipes(restaurantId, tx);
      this.assertLines(recipes, input.lines);
      try {
        explode(this.toInputs(input.lines), dec(1), recipes.graph);
      } catch (error) {
        recipeError(error);
      }
      await tx.recipeLine.deleteMany({ where: { variantId } });
      await tx.recipeLine.createMany({ data: this.toInputs(input.lines).map((line, sortOrder) => ({ ...line, variantId, sortOrder })) });
      await this.audit.record({ actorId: userId, restaurantId, action: 'inventory.recipe_changed', targetType: 'menu-item-variant', targetId: variantId, metadata: { itemId: variant.itemId, lines: input.lines }, ipAddress }, tx);
    });
    return this.recipeView(scope, variantId);
  }

  /** Every dish size: its recipe cost at the branch, the branch's price, food cost % and margin. */
  async costing(userId: string, branchId?: string): Promise<InventoryCosting> {
    const scope = await this.access.scope(userId, 'inventory.costs');
    const branch = await this.access.branches.branch(scope, branchId);
    const restaurantId = scope.restaurant.id;
    const [items, prices, recipes] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { restaurantId },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
        select: { id: true, nameAr: true, nameEn: true, category: { select: { nameAr: true } }, variants: { orderBy: { sortOrder: 'asc' }, select: { id: true, nameAr: true, nameEn: true, pricePiastres: true } } },
      }),
      this.prisma.branchVariantPrice.findMany({ where: { branchId: branch.id }, select: { variantId: true, pricePiastres: true } }),
      this.engine.recipes(restaurantId),
    ]);
    const lines = await this.engine.variantRecipes(items.flatMap((item) => item.variants.map((variant) => variant.id)));
    const costs = await this.branchCosts(branch.id, recipes, (await this.engine.settings(restaurantId)).valuationBasis);
    const own = new Map(prices.map((row) => [row.variantId, row.pricePiastres]));
    const rows: CostingRow[] = items.flatMap((item) => item.variants.map((variant) => {
      const price = own.get(variant.id) ?? variant.pricePiastres;
      const recipe = lines.get(variant.id);
      const base = {
        itemId: item.id, variantId: variant.id, categoryNameAr: item.category.nameAr, itemNameAr: item.nameAr, itemNameEn: item.nameEn,
        variantNameAr: item.variants.length > 1 ? variant.nameAr : null, variantNameEn: item.variants.length > 1 ? variant.nameEn : null, pricePiastres: price,
      };
      if (!recipe?.length) return { ...base, hasRecipe: false, recipeCost: null, foodCostPercent: null, marginPiastres: null, incomplete: false };
      const costed = this.safeRecipeCost(recipe, recipes.graph, costs.raw);
      return {
        ...base, hasRecipe: true, recipeCost: num(costed.cost), foodCostPercent: foodCostPercent(costed.cost, price),
        marginPiastres: num(roundValue(dec(price).minus(costed.cost))), incomplete: costed.incomplete,
      };
    }));
    const percents = rows.flatMap((row) => (row.foodCostPercent === null ? [] : [row.foodCostPercent]));
    return {
      branchId: branch.id,
      rows,
      summary: {
        sizes: rows.length,
        withRecipe: rows.filter((row) => row.hasRecipe).length,
        averageFoodCostPercent: percents.length ? Math.round((percents.reduce((sum, value) => sum + value, 0) / percents.length) * 100) / 100 : null,
      },
    };
  }

  /**
   * Every dish size with its recipe's ingredients and quantities, for inventory users without
   * inventory.costs (recipe views, whole-dish waste). No cost or price, whoever asks.
   */
  async dishes(userId: string, branchId?: string): Promise<InventoryDishes> {
    const scope = await this.access.scope(userId, 'inventory.view', 'inventory.waste');
    const branch = await this.access.branches.branch(scope, branchId);
    const restaurantId = scope.restaurant.id;
    const items = await this.prisma.menuItem.findMany({
      where: { restaurantId },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        id: true, nameAr: true, nameEn: true, category: { select: { id: true, nameAr: true, nameEn: true } },
        variants: { orderBy: { sortOrder: 'asc' }, select: { id: true, nameAr: true, nameEn: true } },
      },
    });
    const [recipes, lines] = await Promise.all([
      this.engine.recipes(restaurantId),
      this.engine.variantRecipes(items.flatMap((item) => item.variants.map((variant) => variant.id))),
    ]);
    return {
      branchId: branch.id,
      rows: items.flatMap((item) => item.variants.map((variant) => {
        const recipe = lines.get(variant.id) ?? [];
        const sized = item.variants.length > 1;
        return {
          itemId: item.id, variantId: variant.id, categoryId: item.category.id, categoryNameAr: item.category.nameAr, categoryNameEn: item.category.nameEn,
          itemNameAr: item.nameAr, itemNameEn: item.nameEn,
          variantNameAr: sized ? variant.nameAr : null, variantNameEn: sized ? variant.nameEn : null,
          hasRecipe: recipe.length > 0,
          // Built field by field (not by dropping fields), so a cost can never slip in.
          lines: this.recipeLines(recipe, recipes.ingredients, null).map((line): DishRecipeLine => ({
            ingredientId: line.ingredientId, nameAr: line.nameAr, nameEn: line.nameEn, kind: line.kind, baseUnit: line.baseUnit,
            quantity: line.quantity, wastePercent: line.wastePercent, usage: line.usage,
          })),
        };
      })),
    };
  }

  // --- Suppliers -----------------------------------------------------------------------------------

  async suppliers(userId: string): Promise<InventorySupplier[]> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const rows = await this.prisma.supplier.findMany({
      where: { restaurantId: scope.restaurant.id },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { ingredients: true, purchases: true } } },
    });
    return rows.map((row) => this.toSupplier(row));
  }

  async createSupplier(userId: string, input: z.output<typeof createSupplierSchema>): Promise<InventorySupplier> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    if ((await this.prisma.supplier.count({ where: { restaurantId: scope.restaurant.id } })) >= INVENTORY_LIMITS.suppliers) {
      throw fail('conflict', CODES.LIMIT_REACHED, `A restaurant can have at most ${INVENTORY_LIMITS.suppliers} suppliers.`, { limit: INVENTORY_LIMITS.suppliers });
    }
    try {
      const row = await this.prisma.supplier.create({ data: { ...input, restaurantId: scope.restaurant.id }, include: { _count: { select: { ingredients: true, purchases: true } } } });
      return this.toSupplier(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw supplierNameTaken();
      throw error;
    }
  }

  async updateSupplier(userId: string, id: string, input: z.output<typeof updateSupplierSchema>): Promise<InventorySupplier> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    await this.assertSupplier(scope.restaurant.id, id);
    try {
      const row = await this.prisma.supplier.update({ where: { id }, data: input, include: { _count: { select: { ingredients: true, purchases: true } } } });
      return this.toSupplier(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw supplierNameTaken();
      throw error;
    }
  }

  /** Only a supplier without purchases is deleted (ingredients preferring it lose the preference). */
  async deleteSupplier(userId: string, id: string): Promise<void> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    await this.assertSupplier(scope.restaurant.id, id);
    if (await this.prisma.purchase.count({ where: { supplierId: id } })) {
      throw fail('conflict', CODES.SUPPLIER_IN_USE, 'This supplier has purchases. Archive it instead.');
    }
    await this.prisma.supplier.delete({ where: { id } });
  }

  // --- Stock and movements -------------------------------------------------------------------------

  async stock(userId: string, branchId?: string): Promise<InventoryStock> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const branch = await this.access.branches.branch(scope, branchId);
    const [ingredients, stock] = await Promise.all([
      this.prisma.ingredient.findMany({ where: { restaurantId: scope.restaurant.id, kind: 'RAW' }, orderBy: [{ category: 'asc' }, { nameAr: 'asc' }] }),
      this.prisma.inventoryStock.findMany({ where: { branchId: branch.id } }),
    ]);
    const byIngredient = new Map(stock.map((row) => [row.ingredientId, row]));
    const basis = (await this.engine.settings(scope.restaurant.id)).valuationBasis;
    let total = ZERO;
    let negativeItems = 0;
    const rows: StockRow[] = ingredients.flatMap((ingredient) => {
      const row = byIngredient.get(ingredient.id);
      const onHand = row?.onHand ?? ZERO;
      // Archived ingredients are listed only while they still hold (or owe) stock.
      if (!ingredient.isActive && onHand.isZero()) return [];
      // Valued as the settings say: the branch average (else standard cost), or the standard cost (else the average).
      const cost = basis === 'STANDARD' ? (ingredient.standardCost ?? row?.avgCost ?? null) : (row?.avgCost ?? ingredient.standardCost ?? null);
      const reorderPoint = row?.reorderPoint ?? ingredient.defaultReorderPoint ?? null;
      const value = cost === null ? null : roundValue(onHand.mul(cost));
      if (onHand.lt(0)) negativeItems++;
      else if (value) total = total.plus(value);
      return [{
        ingredientId: ingredient.id, nameAr: ingredient.nameAr, nameEn: ingredient.nameEn, category: ingredient.category, baseUnit: BASE_UNITS[ingredient.dimension].code,
        onHand: num(onHand), avgCost: scope.costs ? numOrNull(row?.avgCost) : null, value: scope.costs ? numOrNull(value) : null,
        reorderPoint: numOrNull(reorderPoint), reorderPointIsDefault: (row?.reorderPoint ?? null) === null && reorderPoint !== null,
        parLevel: numOrNull(row?.parLevel), status: stockStatus(onHand, reorderPoint), isActive: ingredient.isActive,
      }];
    });
    return { branchId: branch.id, branchName: branch.name, rows, totalValue: scope.costs ? num(roundValue(total)) : null, negativeItems };
  }

  async setStockLevels(userId: string, ingredientId: string, branchId: string | undefined, input: z.output<typeof stockLevelsSchema>): Promise<StockRow> {
    const scope = await this.access.scope(userId, 'inventory.manage');
    const branch = await this.access.branches.branch(scope, branchId);
    const ingredient = await this.prisma.ingredient.findFirst({ where: { id: ingredientId, restaurantId: scope.restaurant.id } });
    if (!ingredient) throw ingredientNotFound();
    if (ingredient.kind !== 'RAW') throw fail('bad', CODES.NOT_RAW, 'A prepared ingredient holds no stock.');
    const data = {
      ...(input.reorderPoint !== undefined && { reorderPoint: decOrNull(input.reorderPoint) }),
      ...(input.parLevel !== undefined && { parLevel: decOrNull(input.parLevel) }),
    };
    await this.prisma.inventoryStock.upsert({
      where: { branchId_ingredientId: { branchId: branch.id, ingredientId } },
      create: { branchId: branch.id, ingredientId, restaurantId: scope.restaurant.id, ...data },
      update: data,
    });
    return (await this.stock(userId, branch.id)).rows.find((row) => row.ingredientId === ingredientId)!;
  }

  async movements(userId: string, query: z.output<typeof movementsQuerySchema>): Promise<Paginated<StockMovement>> {
    const scope = await this.access.scope(userId, 'inventory.view');
    const where: Prisma.StockMovementWhereInput = {
      ...(await this.access.branches.branchWhere(scope, query.branchId)),
      ...(query.ingredientId && { ingredientId: query.ingredientId }),
      ...(query.type && { type: query.type }),
      ...((query.from || query.to) && { createdAt: localDayRange(scope.restaurant.timezone, query.from, query.to) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          branch: { select: { name: true } },
          ingredient: { select: { nameAr: true, nameEn: true, dimension: true } },
          createdBy: { select: { fullName: true } },
          purchase: { select: { invoiceNumber: true, supplierName: true } },
          order: { select: { number: true } },
          waste: { select: { reason: true } },
          transfer: { select: { fromBranch: { select: { name: true } }, toBranch: { select: { name: true } } } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id, type: row.type, branchId: row.branchId, branchName: row.branch.name, ingredientId: row.ingredientId,
        ingredientNameAr: row.ingredient.nameAr, ingredientNameEn: row.ingredient.nameEn, baseUnit: BASE_UNITS[row.ingredient.dimension].code,
        quantity: num(row.quantity), unitCost: scope.costs ? num(row.unitCost) : null, value: scope.costs ? num(row.value) : null, onHandAfter: num(row.onHandAfter),
        source: row.purchaseId ? { kind: 'PURCHASE' as const, id: row.purchaseId, label: row.purchase?.invoiceNumber ?? row.purchase?.supplierName ?? null }
          : row.orderId ? { kind: 'ORDER' as const, id: row.orderId, label: row.order ? `#${row.order.number}` : null }
          : row.wasteId ? { kind: 'WASTE' as const, id: row.wasteId, label: row.waste?.reason ?? null }
          : row.countId ? { kind: 'COUNT' as const, id: row.countId, label: null }
          : row.transferId ? { kind: 'TRANSFER' as const, id: row.transferId, label: row.type === 'TRANSFER_IN' ? (row.transfer?.fromBranch.name ?? null) : (row.transfer?.toBranch.name ?? null) }
          : null,
        note: row.note, createdBy: row.createdBy?.fullName ?? null, createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // --- Shared helpers ------------------------------------------------------------------------------

  /** Unit costs at a branch: raw ingredients' averages (else standard cost), prepared ones through their recipe. */
  async branchCosts(branchId: string, recipes: RestaurantRecipes, basis: InventoryValuationBasis = 'AVERAGE', tx: Tx = this.prisma): Promise<BranchCosts> {
    const raw = await this.engine.unitCosts(branchId, recipes.ingredients, basis, tx);
    const prepared = new Map<string, Decimal | null>();
    const any = (id: string): Decimal | null => {
      if (recipes.ingredients.get(id)?.kind !== 'PREPARED') return raw(id);
      if (!prepared.has(id)) {
        try {
          const result = preparedUnitCost(recipes.graph, id, raw);
          prepared.set(id, result.cost);
        } catch {
          prepared.set(id, null);
        }
      }
      return prepared.get(id)!;
    };
    return { raw, any };
  }

  /** Recipe lines as shown: usage, and (with costs) unit cost and line cost at the branch. */
  recipeLines(lines: readonly RecipeLineInput[], ingredients: ReadonlyMap<string, IngredientInfo>, costs: BranchCosts | null): RecipeLine[] {
    return lines.map((line) => {
      const ingredient = ingredients.get(line.ingredientId)!;
      const usage = roundQuantity(usageOf(line.quantity, line.wastePercent));
      const unitCost = costs ? costs.any(line.ingredientId) : null;
      return {
        ingredientId: line.ingredientId, nameAr: ingredient.nameAr, nameEn: ingredient.nameEn, kind: ingredient.kind, baseUnit: BASE_UNITS[ingredient.dimension].code,
        quantity: num(line.quantity), wastePercent: num(line.wastePercent), usage: num(usage),
        unitCost: costs ? numOrNull(unitCost) : null, cost: costs ? num(roundValue(usage.mul(unitCost ?? ZERO))) : null,
      };
    });
  }

  /** A variant of the caller's restaurant. */
  async findVariant(restaurantId: string, variantId: string) {
    const variant = await this.prisma.menuItemVariant.findFirst({
      where: { id: variantId, item: { restaurantId } },
      select: { id: true, itemId: true, nameAr: true, nameEn: true, pricePiastres: true, item: { select: { nameAr: true, nameEn: true, _count: { select: { variants: true } } } } },
    });
    if (!variant) throw variantNotFound();
    return variant;
  }

  safeRecipeCost(lines: readonly RecipeLineInput[], graph: RecipeGraph, unitCost: (id: string) => Decimal | null) {
    try {
      return recipeCost(lines, graph, unitCost);
    } catch {
      return { cost: ZERO, incomplete: true, usage: new Map<string, Decimal>() };
    }
  }

  private async recipeView(scope: InventoryScope, variantId: string, branchId?: string): Promise<VariantRecipe> {
    const restaurantId = scope.restaurant.id;
    const variant = await this.findVariant(restaurantId, variantId);
    const branch = await this.access.branches.branch(scope, branchId);
    const [recipes, lines] = await Promise.all([this.engine.recipes(restaurantId), this.engine.variantRecipes([variantId])]);
    const recipe = lines.get(variantId) ?? [];
    const basis = (await this.engine.settings(restaurantId)).valuationBasis;
    const costs = scope.costs ? await this.branchCosts(branch.id, recipes, basis) : null;
    let perBranch: VariantRecipe['costs'] = null;
    if (scope.costs) {
      const branches = await this.access.branches.visibleBranches(scope);
      const prices = new Map((await this.prisma.branchVariantPrice.findMany({ where: { variantId } })).map((row) => [row.branchId, row.pricePiastres]));
      perBranch = [];
      for (const each of branches) {
        const price = prices.get(each.id) ?? variant.pricePiastres;
        const cost = recipe.length ? this.safeRecipeCost(recipe, recipes.graph, (await this.branchCosts(each.id, recipes, basis)).raw).cost : ZERO;
        perBranch.push({ branchId: each.id, branchName: each.name, pricePiastres: price, cost: num(cost), foodCostPercent: recipe.length ? foodCostPercent(cost, price) : null });
      }
    }
    const several = variant.item._count.variants > 1;
    return {
      variantId, itemId: variant.itemId, itemNameAr: variant.item.nameAr, itemNameEn: variant.item.nameEn,
      variantNameAr: several ? variant.nameAr : null, variantNameEn: several ? variant.nameEn : null, branchId: branch.id,
      lines: this.recipeLines(recipe, recipes.ingredients, costs),
      costs: perBranch,
    };
  }

  private toInputs(lines: RecipeLineBody): RecipeLineInput[] {
    return lines.map((line) => ({ ingredientId: line.ingredientId, quantity: dec(line.quantity), wastePercent: dec(line.wastePercent) }));
  }

  /** Each ingredient once, all of this restaurant and active. */
  private assertLines(recipes: RestaurantRecipes, lines: RecipeLineBody): void {
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.ingredientId)) throw fail('bad', CODES.DUPLICATE_LINE, 'An ingredient appears twice in the recipe.', { ingredientId: line.ingredientId });
      seen.add(line.ingredientId);
      const ingredient = recipes.ingredients.get(line.ingredientId);
      if (!ingredient) throw ingredientNotFound();
      if (!ingredient.isActive) throw fail('bad', CODES.INGREDIENT_ARCHIVED, 'An archived ingredient cannot be added to a recipe.', { ingredientId: line.ingredientId });
    }
  }

  /** Recipe changes of one restaurant run one at a time, so two edits cannot form a cycle together. */
  private async lockRecipes(tx: Tx, restaurantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory-recipes:${restaurantId}`}))`;
  }

  private async assertSupplier(restaurantId: string, id: string): Promise<void> {
    if (!(await this.prisma.supplier.count({ where: { id, restaurantId } }))) throw supplierNotFound();
  }

  /**
   * Which of the ingredients are locked, and why: HISTORY (stock movements, or a line on a purchase,
   * waste entry, count or transfer) before RECIPES (used in a recipe). Absent: not locked. The one
   * rule behind Ingredient.locked, the kind/unit lock (409 INGREDIENT_LOCKED) and delete (409 INGREDIENT_IN_USE).
   */
  private async lockReasons(ids: readonly string[]): Promise<Map<string, IngredientLockReason>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; history: boolean; recipes: boolean }[]>`
      SELECT i.id,
        (EXISTS (SELECT 1 FROM stock_movements m WHERE m.ingredient_id = i.id)
          OR EXISTS (SELECT 1 FROM inventory_purchase_lines l WHERE l.ingredient_id = i.id)
          OR EXISTS (SELECT 1 FROM inventory_waste_lines l WHERE l.ingredient_id = i.id)
          OR EXISTS (SELECT 1 FROM inventory_count_lines l WHERE l.ingredient_id = i.id)
          OR EXISTS (SELECT 1 FROM inventory_transfer_lines l WHERE l.ingredient_id = i.id)) AS history,
        EXISTS (SELECT 1 FROM recipe_lines r WHERE r.ingredient_id = i.id) AS recipes
      FROM ingredients i
      WHERE i.id = ANY(${[...ids]}::uuid[])`;
    const reasons = new Map<string, IngredientLockReason>();
    for (const row of rows) {
      if (row.history) reasons.set(row.id, 'HISTORY');
      else if (row.recipes) reasons.set(row.id, 'RECIPES');
    }
    return reasons;
  }

  private async isLocked(id: string): Promise<boolean> {
    return (await this.lockReasons([id])).has(id);
  }

  private async usedInCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const groups = await this.prisma.recipeLine.groupBy({ by: ['ingredientId'], where: { ingredientId: { in: ids } }, _count: { _all: true } });
    return new Map(groups.map((group) => [group.ingredientId, group._count._all]));
  }

  private toIngredient(row: IngredientRow, recipes: RestaurantRecipes, costs: BranchCosts | null, usedIn: number, lockReason: IngredientLockReason | null, showCosts: boolean): Ingredient {
    return {
      id: row.id, nameAr: row.nameAr, nameEn: row.nameEn, category: row.category, kind: row.kind, dimension: row.dimension, baseUnit: BASE_UNITS[row.dimension].code,
      standardCost: showCosts ? numOrNull(row.standardCost) : null,
      currentCost: costs ? numOrNull(costs.any(row.id) === null ? null : roundUnitCost(costs.any(row.id)!)) : null,
      preferredSupplier: row.preferredSupplier,
      defaultReorderPoint: numOrNull(row.defaultReorderPoint),
      isActive: row.isActive,
      units: row.units.map((unit) => ({ id: unit.id, nameAr: unit.nameAr, nameEn: unit.nameEn, factor: num(unit.factor) })),
      yieldQuantity: numOrNull(row.yieldQuantity),
      recipe: this.recipeLines(row.recipe, recipes.ingredients, costs),
      usedIn,
      locked: lockReason !== null,
      lockReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSupplier(row: Prisma.SupplierGetPayload<{ include: { _count: { select: { ingredients: true; purchases: true } } } }>): InventorySupplier {
    return {
      id: row.id, name: row.name, phone: row.phone, email: row.email, note: row.note, isActive: row.isActive,
      ingredients: row._count.ingredients, purchases: row._count.purchases, createdAt: row.createdAt.toISOString(),
    };
  }

}

