import { z } from 'zod';

/**
 * Inventory, recipes and cost management (docs/INVENTORY.md). Quantities are in the ingredient's
 * base unit (grams, millilitres or pieces), unit costs in piastres per base unit, values in
 * piastres. Decimals travel as JSON numbers; cost fields are null for callers without
 * inventory.costs. Dashboard only.
 */

export const INVENTORY_ERROR_CODES = {
  /** 409: the plan has no inventory (Full Experience only), or the restaurant has no access. */
  UNAVAILABLE: 'INVENTORY_UNAVAILABLE',
  INGREDIENT_NOT_FOUND: 'INVENTORY_INGREDIENT_NOT_FOUND',
  /** 409: another ingredient already has this Arabic name. */
  INGREDIENT_NAME_TAKEN: 'INVENTORY_INGREDIENT_NAME_TAKEN',
  /** 409: the ingredient has movements or is used; archive it (isActive: false) instead. */
  INGREDIENT_IN_USE: 'INVENTORY_INGREDIENT_IN_USE',
  /** 409: kind and unit type cannot change once the ingredient has history or is in a recipe (Ingredient.locked). */
  INGREDIENT_LOCKED: 'INVENTORY_INGREDIENT_LOCKED',
  /** 400: prepared ingredients hold no stock: they cannot be bought, counted or transferred. */
  NOT_RAW: 'INVENTORY_NOT_RAW',
  /** 400: only a prepared ingredient has a recipe of its own. */
  NOT_PREPARED: 'INVENTORY_NOT_PREPARED',
  /** 400: an archived ingredient cannot be used in new documents or recipes. */
  INGREDIENT_ARCHIVED: 'INVENTORY_INGREDIENT_ARCHIVED',
  /** 400: the unit does not belong to the ingredient. */
  UNIT_NOT_FOUND: 'INVENTORY_UNIT_NOT_FOUND',
  /** 400: the recipe would use itself (directly or through another prepared ingredient). details: { path } */
  RECIPE_CYCLE: 'RECIPE_CYCLE',
  /** 400: prepared ingredients nest at most INVENTORY_LIMITS.maxPrepDepth levels. */
  RECIPE_TOO_DEEP: 'RECIPE_TOO_DEEP',
  /** 400: the same ingredient twice in one recipe or document. details: { ingredientId } */
  DUPLICATE_LINE: 'INVENTORY_DUPLICATE_LINE',
  VARIANT_NOT_FOUND: 'INVENTORY_VARIANT_NOT_FOUND',
  /** 400: wasting whole dishes needs the size's recipe. */
  NO_RECIPE: 'INVENTORY_NO_RECIPE',
  /** 409: a limit (ingredients, suppliers per restaurant) is reached. details: { limit } */
  LIMIT_REACHED: 'INVENTORY_LIMIT_REACHED',
  SUPPLIER_NOT_FOUND: 'INVENTORY_SUPPLIER_NOT_FOUND',
  SUPPLIER_NAME_TAKEN: 'INVENTORY_SUPPLIER_NAME_TAKEN',
  /** 409: the supplier has purchases; archive it instead. */
  SUPPLIER_IN_USE: 'INVENTORY_SUPPLIER_IN_USE',
  PURCHASE_NOT_FOUND: 'INVENTORY_PURCHASE_NOT_FOUND',
  /** 409: the purchase is not in a status that allows this (received twice, edited after receiving…). details: { status } */
  PURCHASE_STATUS: 'INVENTORY_PURCHASE_STATUS',
  COUNT_NOT_FOUND: 'INVENTORY_COUNT_NOT_FOUND',
  /** 409: the count was posted or cancelled. details: { status } */
  COUNT_NOT_OPEN: 'INVENTORY_COUNT_NOT_OPEN',
  /** 409: the branch already has an open count. details: { countId } */
  COUNT_ALREADY_OPEN: 'INVENTORY_COUNT_ALREADY_OPEN',
  /** 400: a counted line for an ingredient that is not on the count. */
  COUNT_LINE_UNKNOWN: 'INVENTORY_COUNT_LINE_UNKNOWN',
  /** 400: a transfer goes to another branch. */
  SAME_BRANCH: 'INVENTORY_SAME_BRANCH',
  /** 400: the reason is not one of the restaurant's waste reasons (settings). details: { reason } */
  WASTE_REASON_UNKNOWN: 'INVENTORY_WASTE_REASON_UNKNOWN',
  /** 409: the count is not waiting for approval. details: { status } */
  COUNT_NOT_PENDING: 'INVENTORY_COUNT_NOT_PENDING',
} as const;

export const INVENTORY_LIMITS = {
  ingredients: 2000,
  suppliers: 300,
  unitsPerIngredient: 10,
  recipeLines: 60,
  documentLines: 200,
  /** A prepared ingredient may use prepared ingredients this many levels deep. */
  maxPrepDepth: 3,
  maxWastePercent: 90,
  /** Reports cover at most this many days. */
  reportDays: 366,
  nameLength: 80,
  noteLength: 300,
  /** Guards against typos: 100 tonnes (or 100,000 litres, pieces) in one line. */
  maxQuantity: 100_000_000,
  /** Piastres per base unit: EGP 100,000 per gram is clearly a typo. */
  maxUnitCost: 10_000_000,
  wasteReasons: 20,
} as const;

export const INGREDIENT_KINDS = ['RAW', 'PREPARED'] as const;
export type IngredientKind = (typeof INGREDIENT_KINDS)[number];

/**
 * Why an ingredient is locked (its kind and unit type can no longer change, and it can only be
 * archived, not deleted): HISTORY, it has stock movements or appears on a document (purchase,
 * waste, count, transfer), which never goes away; RECIPES, it is used in a recipe (removing it
 * from every recipe unlocks it). HISTORY wins when both apply.
 */
export const INGREDIENT_LOCK_REASONS = ['HISTORY', 'RECIPES'] as const;
export type IngredientLockReason = (typeof INGREDIENT_LOCK_REASONS)[number];

/** What an ingredient is measured in; its base unit is grams, millilitres or pieces. */
export const INVENTORY_DIMENSIONS = ['MASS', 'VOLUME', 'COUNT'] as const;
export type InventoryDimension = (typeof INVENTORY_DIMENSIONS)[number];

export const BASE_UNITS: Record<InventoryDimension, { code: 'g' | 'ml' | 'pcs'; label: [string, string] }> = {
  MASS: { code: 'g', label: ['جرام', 'g'] },
  VOLUME: { code: 'ml', label: ['مللي', 'ml'] },
  COUNT: { code: 'pcs', label: ['قطعة', 'pcs'] },
};
export type BaseUnit = (typeof BASE_UNITS)[InventoryDimension]['code'];

/**
 * Every change of stock. Signs: PURCHASE, SALE_REVERSAL, TRANSFER_IN add; PURCHASE_VOID, SALE,
 * WASTE, TRANSFER_OUT remove; COUNT_VARIANCE either way.
 */
export const STOCK_MOVEMENT_TYPES = ['PURCHASE', 'PURCHASE_VOID', 'SALE', 'SALE_REVERSAL', 'WASTE', 'COUNT_VARIANCE', 'TRANSFER_IN', 'TRANSFER_OUT'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const PURCHASE_STATUSES = ['DRAFT', 'RECEIVED', 'VOID'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** PENDING_APPROVAL: posted while a variance is above the threshold by someone without inventory.approve. */
export const STOCK_COUNT_STATUSES = ['OPEN', 'PENDING_APPROVAL', 'POSTED', 'CANCELLED'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/** When an order's stock is deducted: on reaching this status, or any later one. */
export const INVENTORY_DEDUCT_ON = ['ACCEPTED', 'READY', 'COMPLETED'] as const;
export type InventoryDeductOn = (typeof INVENTORY_DEDUCT_ON)[number];

/**
 * When the branch's stock cannot cover an order's recipes at placement: ALLOW_NEGATIVE places it;
 * WARN places it and flags it (OwnerOrder.lowStockItemIds, the low-stock report); BLOCK_ORDERS
 * refuses it with 409 INSUFFICIENT_STOCK. Never applies without inventory or to dishes without a recipe.
 */
export const INVENTORY_STOCK_POLICIES = ['ALLOW_NEGATIVE', 'WARN', 'BLOCK_ORDERS'] as const;
export type InventoryStockPolicy = (typeof INVENTORY_STOCK_POLICIES)[number];

/** The unit cost costing and reports value stock at: the branch's weighted average or the ingredient's standard cost. */
export const INVENTORY_VALUATION_BASES = ['AVERAGE', 'STANDARD'] as const;
export type InventoryValuationBasis = (typeof INVENTORY_VALUATION_BASES)[number];

/** A waste reason code (the restaurant edits its list in the settings). */
export type WasteReason = string;
export type WasteReasonOption = { code: string; nameAr: string; nameEn: string | null };

export const DEFAULT_WASTE_REASONS: readonly WasteReasonOption[] = [
  { code: 'EXPIRED', nameAr: 'انتهت صلاحيته', nameEn: 'Expired' },
  { code: 'SPOILED', nameAr: 'باظ', nameEn: 'Spoiled' },
  { code: 'DROPPED', nameAr: 'وقع', nameEn: 'Dropped' },
  { code: 'OVERCOOKED', nameAr: 'اتحرق أو زيادة تسوية', nameEn: 'Overcooked' },
  { code: 'STAFF_MEAL', nameAr: 'وجبة موظفين', nameEn: 'Staff meal' },
  { code: 'COMPLIMENTARY', nameAr: 'ضيافة', nameEn: 'Complimentary' },
  { code: 'OTHER', nameAr: 'سبب تاني', nameEn: 'Other' },
];

/** OUT: at or below zero; LOW: at or below the reorder point. */
export const STOCK_STATUSES = ['OK', 'LOW', 'OUT'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Menu engineering (popularity × margin). */
export const MENU_ENGINEERING_CLASSES = ['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG'] as const;
export type MenuEngineeringClass = (typeof MENU_ENGINEERING_CLASSES)[number];

// --- Input numbers -----------------------------------------------------------------------------------

const decimals = (places: number) => (value: number) => {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
/** A quantity in base units, up to 0.001. */
const quantity = z.number().positive().max(INVENTORY_LIMITS.maxQuantity).refine(decimals(3), 'At most 3 decimals');
const nonNegativeQuantity = z.number().min(0).max(INVENTORY_LIMITS.maxQuantity).refine(decimals(3), 'At most 3 decimals');
/** Piastres per base unit, up to 0.0001. */
const unitCost = z.number().min(0).max(INVENTORY_LIMITS.maxUnitCost).refine(decimals(4), 'At most 4 decimals');
/** Piastres, up to 0.01. */
const unitPrice = z.number().min(0).max(10_000_000_000).refine(decimals(4), 'At most 4 decimals');
const money = z.number().min(0).max(100_000_000_000).refine(decimals(2), 'At most 2 decimals');
const wastePercent = z.number().min(0).max(INVENTORY_LIMITS.maxWastePercent).refine(decimals(2), 'At most 2 decimals');
const name = z.string().trim().min(1).max(INVENTORY_LIMITS.nameLength);
const optionalName = z.string().trim().max(INVENTORY_LIMITS.nameLength).nullish().transform((value) => value || null);
const optionalNote = z.string().trim().max(INVENTORY_LIMITS.noteLength).nullish().transform((value) => value || null);
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

// --- Settings ----------------------------------------------------------------------------------------

const wasteReasonCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Letters, digits and _');

export const wasteReasonSchema = z.strictObject({
  code: wasteReasonCode,
  nameAr: z.string().trim().min(1).max(60),
  nameEn: z.string().trim().max(60).nullish().transform((value) => value || null),
});

/** A branch's own rules; null (or missing) follows the restaurant's. */
export const inventoryBranchSettingsSchema = z.strictObject({
  branchId: z.uuid(),
  stockPolicy: z.enum(INVENTORY_STOCK_POLICIES).nullable().default(null),
  autoSoldOut: z.boolean().nullable().default(null),
  autoRestore: z.boolean().nullable().default(null),
});

/** PUT /v1/inventory/settings: any of the fields; the others keep their value. `branches` replaces every branch override. */
export const inventorySettingsSchema = z.strictObject({
  /** Orders deduct stock through recipes, and auto sold-out acts. Off by default. */
  enabled: z.boolean().optional(),
  deductOn: z.enum(INVENTORY_DEDUCT_ON).optional(),
  stockPolicy: z.enum(INVENTORY_STOCK_POLICIES).optional(),
  /** A dish whose every size needs an ingredient that ran out is marked sold out at that branch. */
  autoSoldOut: z.boolean().optional(),
  /** Restocking lifts the sold-out marks inventory set. */
  autoRestore: z.boolean().optional(),
  valuationBasis: z.enum(INVENTORY_VALUATION_BASES).optional(),
  wasteReasons: z
    .array(wasteReasonSchema)
    .min(1)
    .max(INVENTORY_LIMITS.wasteReasons)
    .refine((reasons) => new Set(reasons.map((reason) => reason.code)).size === reasons.length, 'Each reason code once')
    .optional(),
  /** Posting a count with a line off by more than the threshold needs inventory.approve. */
  requireCountApproval: z.boolean().optional(),
  countVarianceThresholdPercent: z.number().min(0).max(10_000).refine(decimals(2), 'At most 2 decimals').optional(),
  branches: z
    .array(inventoryBranchSettingsSchema)
    .max(50)
    .refine((rows) => new Set(rows.map((row) => row.branchId)).size === rows.length, 'Each branch once')
    .optional(),
});

export type InventoryBranchSettings = {
  branchId: string;
  branchName: string;
  /** The branch's own values (null: the restaurant's). */
  stockPolicy: InventoryStockPolicy | null;
  autoSoldOut: boolean | null;
  autoRestore: boolean | null;
  /** What applies at the branch. */
  effective: { stockPolicy: InventoryStockPolicy; autoSoldOut: boolean; autoRestore: boolean };
};

export type InventorySettings = {
  enabled: boolean;
  deductOn: InventoryDeductOn;
  stockPolicy: InventoryStockPolicy;
  autoSoldOut: boolean;
  autoRestore: boolean;
  valuationBasis: InventoryValuationBasis;
  wasteReasons: WasteReasonOption[];
  requireCountApproval: boolean;
  countVarianceThresholdPercent: number;
  /** Every branch the caller may see, with its overrides. */
  branches: InventoryBranchSettings[];
  updatedAt: string | null;
};

export const DEFAULT_INVENTORY_SETTINGS: Omit<InventorySettings, 'branches' | 'updatedAt'> = {
  enabled: false,
  deductOn: 'ACCEPTED',
  stockPolicy: 'ALLOW_NEGATIVE',
  autoSoldOut: true,
  autoRestore: true,
  valuationBasis: 'AVERAGE',
  wasteReasons: [...DEFAULT_WASTE_REASONS],
  requireCountApproval: false,
  countVarianceThresholdPercent: 10,
};

// --- Ingredients and units ---------------------------------------------------------------------------

export const ingredientUnitSchema = z.strictObject({
  nameAr: z.string().trim().min(1).max(40),
  nameEn: z.string().trim().max(40).nullish().transform((value) => value || null),
  /** Base units in one of this unit: kg = 1000, "25 kg sack" = 25000, "carton of 24" = 24. */
  factor: quantity,
});

export const ingredientUnitsSchema = z.strictObject({
  units: z.array(ingredientUnitSchema).max(INVENTORY_LIMITS.unitsPerIngredient),
});

export const createIngredientSchema = z.strictObject({
  nameAr: name,
  nameEn: optionalName,
  /** Free text used to group stock and valuation: "خضار", "ألبان", "تغليف"… */
  category: z.string().trim().max(40).nullish().transform((value) => value || null),
  kind: z.enum(INGREDIENT_KINDS).default('RAW'),
  dimension: z.enum(INVENTORY_DIMENSIONS),
  /** Piastres per base unit, used until the branch has received the ingredient. */
  standardCost: unitCost.nullish().transform((value) => value ?? null),
  preferredSupplierId: z.uuid().nullish().transform((value) => value ?? null),
  /** The reorder point at branches that have not set their own. */
  defaultReorderPoint: nonNegativeQuantity.nullish().transform((value) => value ?? null),
  units: z.array(ingredientUnitSchema).max(INVENTORY_LIMITS.unitsPerIngredient).default([]),
});

export const updateIngredientSchema = z.strictObject({
  nameAr: name.optional(),
  nameEn: optionalName.optional(),
  category: z.string().trim().max(40).nullish().transform((value) => value || null).optional(),
  kind: z.enum(INGREDIENT_KINDS).optional(),
  dimension: z.enum(INVENTORY_DIMENSIONS).optional(),
  standardCost: unitCost.nullable().optional(),
  preferredSupplierId: z.uuid().nullable().optional(),
  defaultReorderPoint: nonNegativeQuantity.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const ingredientsQuerySchema = z.object({
  /** Branch whose current cost is shown (defaults to the caller's, or the main branch). */
  branchId: z.uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});

// --- Recipes -----------------------------------------------------------------------------------------

export const recipeLineSchema = z.strictObject({
  ingredientId: z.uuid(),
  /** Base units as served. */
  quantity,
  /** Trimming and loss: usage = quantity / (1 − waste% / 100). */
  wastePercent: wastePercent.default(0),
});

/** A dish size's recipe; an empty list removes it. */
export const variantRecipeSchema = z.strictObject({
  lines: z.array(recipeLineSchema).max(INVENTORY_LIMITS.recipeLines),
});

/** A prepared ingredient's recipe and how much it makes (base units); an empty list removes it. */
export const preparedRecipeSchema = z
  .strictObject({
    yieldQuantity: quantity.nullish().transform((value) => value ?? null),
    lines: z.array(recipeLineSchema).max(INVENTORY_LIMITS.recipeLines),
  })
  .refine((value) => !value.lines.length || value.yieldQuantity !== null, { message: 'Give how much the recipe makes', path: ['yieldQuantity'] });

// --- Suppliers ---------------------------------------------------------------------------------------

export const createSupplierSchema = z.strictObject({
  name,
  phone: z.string().trim().max(30).nullish().transform((value) => value || null),
  email: z.string().trim().toLowerCase().max(254).pipe(z.union([z.email(), z.literal('')])).nullish().transform((value) => value || null),
  note: optionalNote,
});
export const updateSupplierSchema = z.strictObject({
  name: name.optional(),
  phone: z.string().trim().max(30).nullish().transform((value) => value || null).optional(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.union([z.email(), z.literal('')])).nullish().transform((value) => value || null).optional(),
  note: optionalNote.optional(),
  isActive: z.boolean().optional(),
});

// --- Stock and movements -----------------------------------------------------------------------------

export const inventoryBranchQuerySchema = z.object({ branchId: z.uuid().optional() });

export const stockLevelsSchema = z
  .strictObject({
    /** At or below this, the ingredient is LOW and suggested for reordering. */
    reorderPoint: nonNegativeQuantity.nullable().optional(),
    /** Reorder suggestions fill up to this level. */
    parLevel: nonNegativeQuantity.nullable().optional(),
  })
  .refine((value) => value.reorderPoint !== undefined || value.parLevel !== undefined, { message: 'Give a reorder point or a par level', path: ['reorderPoint'] });

export const movementsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  ingredientId: z.uuid().optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  ...page,
});

// --- Purchases ---------------------------------------------------------------------------------------

/** A line in any of the ingredient's units (none: the base unit), with a unit price or a line total. */
export const purchaseLineSchema = z
  .strictObject({
    ingredientId: z.uuid(),
    unitId: z.uuid().nullish().transform((value) => value ?? null),
    /** How many of the unit. */
    quantity,
    /** Piastres per unit as invoiced. */
    unitPrice: unitPrice.optional(),
    /** Piastres for the whole line. */
    lineTotal: money.optional(),
  })
  .refine((value) => (value.unitPrice === undefined) !== (value.lineTotal === undefined), { message: 'Give a unit price or a line total', path: ['unitPrice'] });

export const createPurchaseSchema = z.strictObject({
  /** Defaults to the caller's branch, or the main branch. */
  branchId: z.uuid().optional(),
  supplierId: z.uuid().nullish().transform((value) => value ?? null),
  invoiceNumber: z.string().trim().max(60).nullish().transform((value) => value || null),
  invoiceDate: z.iso.date().nullish().transform((value) => value ?? null),
  note: optionalNote,
  lines: z.array(purchaseLineSchema).min(1).max(INVENTORY_LIMITS.documentLines),
  /** Receive at once (the goods are here): stock and costs are posted. */
  receive: z.boolean().default(false),
});

export const updatePurchaseSchema = z.strictObject({
  supplierId: z.uuid().nullable().optional(),
  invoiceNumber: z.string().trim().max(60).nullish().transform((value) => value || null).optional(),
  invoiceDate: z.iso.date().nullable().optional(),
  note: optionalNote.optional(),
  lines: z.array(purchaseLineSchema).min(1).max(INVENTORY_LIMITS.documentLines).optional(),
});

export const voidPurchaseSchema = z.strictObject({ reason: z.string().trim().min(3).max(INVENTORY_LIMITS.noteLength) });

export const purchasesQuerySchema = z.object({
  branchId: z.uuid().optional(),
  status: z.enum(PURCHASE_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  ...page,
});

// --- Waste -------------------------------------------------------------------------------------------

/** An ingredient (in any of its units), or whole dishes (their recipe is wasted). */
export const wasteLineSchema = z.union([
  z.strictObject({ ingredientId: z.uuid(), unitId: z.uuid().nullish().transform((value) => value ?? null), quantity }),
  z.strictObject({ variantId: z.uuid(), quantity: z.number().int().min(1).max(1000) }),
]);

export const createWasteSchema = z.strictObject({
  branchId: z.uuid().optional(),
  /** A code from the restaurant's waste reasons. */
  reason: wasteReasonCode,
  note: optionalNote,
  lines: z.array(wasteLineSchema).min(1).max(INVENTORY_LIMITS.documentLines),
});

export const wasteQuerySchema = z.object({
  branchId: z.uuid().optional(),
  reason: wasteReasonCode.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  ...page,
});

// --- Stock counts ------------------------------------------------------------------------------------

export const createCountSchema = z.strictObject({
  branchId: z.uuid().optional(),
  note: optionalNote,
  /** Count only these ingredients (or one category); default: every active raw ingredient. */
  ingredientIds: z.array(z.uuid()).min(1).max(INVENTORY_LIMITS.ingredients).optional(),
  category: z.string().trim().min(1).max(40).optional(),
});

export const updateCountSchema = z.strictObject({
  /** Counted quantities in base units; null clears a line (it is not posted). */
  lines: z.array(z.strictObject({ ingredientId: z.uuid(), counted: nonNegativeQuantity.nullable() })).max(INVENTORY_LIMITS.ingredients).default([]),
  note: optionalNote.optional(),
});

/** Approving or sending back a count that waits for approval. */
export const reviewCountSchema = z.strictObject({ note: optionalNote });

export const countsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  status: z.enum(STOCK_COUNT_STATUSES).optional(),
  ...page,
});

// --- Transfers ---------------------------------------------------------------------------------------

export const createTransferSchema = z.strictObject({
  /** Defaults to the caller's branch, or the main branch. */
  fromBranchId: z.uuid().optional(),
  toBranchId: z.uuid(),
  note: optionalNote,
  lines: z.array(z.strictObject({ ingredientId: z.uuid(), unitId: z.uuid().nullish().transform((value) => value ?? null), quantity })).min(1).max(INVENTORY_LIMITS.documentLines),
});

export const transfersQuerySchema = z.object({ branchId: z.uuid().optional(), ...page });

// --- Reports -----------------------------------------------------------------------------------------

export const foodCostQuerySchema = z.object({
  branchId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
});

export const lowStockQuerySchema = z.object({
  branchId: z.uuid().optional(),
  /** Orders flagged by the WARN policy over this many days. */
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const menuEngineeringQuerySchema = z.object({
  branchId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(INVENTORY_LIMITS.reportDays).default(30),
});

// --- Responses ---------------------------------------------------------------------------------------

export type IngredientUnit = { id: string; nameAr: string; nameEn: string | null; factor: number };

export type RecipeLine = {
  ingredientId: string;
  nameAr: string;
  nameEn: string | null;
  kind: IngredientKind;
  baseUnit: BaseUnit;
  quantity: number;
  wastePercent: number;
  /** quantity / (1 − waste% / 100). */
  usage: number;
  /** At the branch asked for; null without inventory.costs. */
  unitCost: number | null;
  cost: number | null;
};

export type Ingredient = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  category: string | null;
  kind: IngredientKind;
  dimension: InventoryDimension;
  baseUnit: BaseUnit;
  standardCost: number | null;
  /** Piastres per base unit at the branch asked for: its average cost (raw), or its recipe's cost (prepared). */
  currentCost: number | null;
  preferredSupplier: { id: string; name: string } | null;
  defaultReorderPoint: number | null;
  isActive: boolean;
  units: IngredientUnit[];
  /** Prepared ingredients: how much the recipe makes, and its lines. */
  yieldQuantity: number | null;
  recipe: RecipeLine[];
  /** Dish sizes and prepared ingredients whose recipes use it. */
  usedIn: number;
  /**
   * Kind and unit type can no longer change (PATCH answers 409 INVENTORY_INGREDIENT_LOCKED) and it
   * cannot be deleted (409 INVENTORY_INGREDIENT_IN_USE; archive it instead). The same rule the API enforces.
   */
  locked: boolean;
  /** Why it is locked; null when it is not. */
  lockReason: IngredientLockReason | null;
  createdAt: string;
  updatedAt: string;
};

export type VariantRecipe = {
  variantId: string;
  itemId: string;
  itemNameAr: string;
  itemNameEn: string | null;
  variantNameAr: string | null;
  variantNameEn: string | null;
  branchId: string;
  lines: RecipeLine[];
  /** Cost per branch (with its price), when allowed. */
  costs: { branchId: string; branchName: string; pricePiastres: number; cost: number; foodCostPercent: number | null }[] | null;
};

export type CostingRow = {
  itemId: string;
  variantId: string;
  categoryNameAr: string;
  itemNameAr: string;
  itemNameEn: string | null;
  variantNameAr: string | null;
  variantNameEn: string | null;
  /** The branch's own price where it has one. */
  pricePiastres: number;
  hasRecipe: boolean;
  /** Piastres; null without a recipe. */
  recipeCost: number | null;
  /** recipeCost / price × 100. */
  foodCostPercent: number | null;
  marginPiastres: number | null;
  /** A line has no cost yet (never received, no standard cost) or a prepared ingredient has no recipe. */
  incomplete: boolean;
};

export type InventoryCosting = {
  branchId: string;
  rows: CostingRow[];
  summary: { sizes: number; withRecipe: number; averageFoodCostPercent: number | null };
};

/** A recipe line without costs: what GET /v1/inventory/dishes returns for every caller. */
export type DishRecipeLine = Omit<RecipeLine, 'unitCost' | 'cost'>;

/**
 * GET /v1/inventory/dishes (inventory.view or inventory.waste): every dish size of the menu with its
 * recipe's ingredients and quantities, for recipe views and whole-dish waste. Never carries a cost
 * or a price, whatever the caller's permissions (GET /costing has those).
 */
export type InventoryDish = {
  itemId: string;
  variantId: string;
  categoryId: string;
  categoryNameAr: string;
  categoryNameEn: string | null;
  itemNameAr: string;
  itemNameEn: string | null;
  /** Null when the dish has one size. */
  variantNameAr: string | null;
  variantNameEn: string | null;
  hasRecipe: boolean;
  lines: DishRecipeLine[];
};

export type InventoryDishes = { branchId: string; rows: InventoryDish[] };

/**
 * GET /v1/inventory/transfer-destinations?branchId= (inventory.operate): the restaurant's other
 * active branches a transfer from the branch may go to. Only these three fields.
 */
export type TransferDestination = { id: string; name: string; slug: string };

export type InventorySupplier = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  isActive: boolean;
  ingredients: number;
  purchases: number;
  createdAt: string;
};

export type StockRow = {
  ingredientId: string;
  nameAr: string;
  nameEn: string | null;
  category: string | null;
  baseUnit: BaseUnit;
  onHand: number;
  avgCost: number | null;
  value: number | null;
  /** The branch's own, else the ingredient's default. */
  reorderPoint: number | null;
  reorderPointIsDefault: boolean;
  parLevel: number | null;
  status: StockStatus;
  isActive: boolean;
};

export type InventoryStock = { branchId: string; branchName: string; rows: StockRow[]; totalValue: number | null; negativeItems: number };

export type StockMovement = {
  id: string;
  type: StockMovementType;
  branchId: string;
  branchName: string;
  ingredientId: string;
  ingredientNameAr: string;
  ingredientNameEn: string | null;
  baseUnit: BaseUnit;
  /** Signed: positive adds stock. */
  quantity: number;
  unitCost: number | null;
  /** Signed piastres. */
  value: number | null;
  onHandAfter: number;
  /** The document behind it. */
  source: { kind: 'PURCHASE' | 'ORDER' | 'WASTE' | 'COUNT' | 'TRANSFER'; id: string; label: string | null } | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type PurchaseLine = {
  id: string;
  ingredientId: string;
  nameAr: string;
  nameEn: string | null;
  baseUnit: BaseUnit;
  unitId: string | null;
  /** The unit's names when the line was made (null: the base unit); English may be null for a unit without one. */
  unitNameAr: string | null;
  unitNameEn: string | null;
  factor: number;
  quantity: number;
  baseQuantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
  /** Piastres per base unit. */
  unitCost: number | null;
};

export type Purchase = {
  id: string;
  branchId: string;
  branchName: string;
  supplier: { id: string | null; name: string } | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  status: PurchaseStatus;
  note: string | null;
  total: number | null;
  lineCount: number;
  createdBy: string | null;
  createdAt: string;
  receivedAt: string | null;
  receivedBy: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
};

export type PurchaseDetail = Purchase & { lines: PurchaseLine[] };

export type WasteEntry = {
  id: string;
  branchId: string;
  branchName: string;
  reason: WasteReason;
  reasonNameAr: string;
  reasonNameEn: string | null;
  note: string | null;
  total: number | null;
  /** Ingredient lines: quantity in base units, and the unit it was entered in (names copied; null: the base unit). Dish lines: dishes. */
  lines: { ingredientId: string | null; variantId: string | null; nameAr: string; nameEn: string | null; unitNameAr: string | null; unitNameEn: string | null; quantity: number; baseUnit: BaseUnit | null; value: number | null }[];
  createdBy: string | null;
  createdAt: string;
};

export type StockCountLine = {
  ingredientId: string;
  nameAr: string;
  nameEn: string | null;
  category: string | null;
  baseUnit: BaseUnit;
  /** On hand when the count was created. */
  expected: number;
  counted: number | null;
  /** counted − expected (posted as a COUNT_VARIANCE). */
  variance: number | null;
  /** Piastres at the average cost; null without inventory.costs. */
  varianceValue: number | null;
  /** |variance| / expected is above the settings' threshold (needs approval when that is on). */
  overThreshold: boolean;
};

export type StockCount = {
  id: string;
  branchId: string;
  branchName: string;
  status: StockCountStatus;
  note: string | null;
  lineCount: number;
  countedLines: number;
  /** Net variance value (negative is a loss). */
  varianceValue: number | null;
  createdBy: string | null;
  createdAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  reviewNote: string | null;
  postedAt: string | null;
  postedBy: string | null;
  cancelledAt: string | null;
};

export type StockCountDetail = StockCount & { lines: StockCountLine[] };

export type StockTransfer = {
  id: string;
  fromBranch: { id: string; name: string };
  toBranch: { id: string; name: string };
  note: string | null;
  total: number | null;
  lines: { ingredientId: string; nameAr: string; nameEn: string | null; baseUnit: BaseUnit; quantity: number; unitCost: number | null; value: number | null }[];
  createdBy: string | null;
  createdAt: string;
};

export type ValuationReport = {
  branchId: string;
  branchName: string;
  total: number;
  byCategory: { category: string | null; items: number; value: number }[];
  /** Ingredients below zero (not valued): sales or waste were recorded before the goods. */
  negativeItems: number;
};

export type LowStockReport = {
  branchId: string;
  branchName: string;
  /** Ingredients LOW or OUT at the branch. */
  rows: StockRow[];
  /** Orders placed under the WARN policy whose dishes the stock could not cover. */
  warnedOrders: { orderId: string; number: number; status: string; placedAt: string; items: { menuItemId: string; nameAr: string; nameEn: string | null }[] }[];
};

export type ReorderLine = {
  ingredientId: string;
  nameAr: string;
  nameEn: string | null;
  baseUnit: BaseUnit;
  onHand: number;
  reorderPoint: number;
  parLevel: number | null;
  /** Base units to reach the par level (or the reorder point without one). */
  suggestedQuantity: number;
  /** The same in the ingredient's first purchase unit, rounded up (English name null when the unit has none). */
  suggestedUnits: { unitId: string; unitNameAr: string; unitNameEn: string | null; quantity: number } | null;
  estimatedCost: number | null;
};

export type ReorderReport = {
  branchId: string;
  branchName: string;
  groups: { supplier: { id: string; name: string; phone: string | null } | null; lines: ReorderLine[]; estimatedCost: number | null }[];
};

export type FoodCostRow = {
  branchId: string | null;
  branchName: string | null;
  /** Counted orders' subtotals (not rejected or cancelled), piastres. */
  revenue: number;
  /** SALE − SALE_REVERSAL. */
  theoreticalCost: number;
  wasteCost: number;
  /** Net count variance value: negative is a loss. */
  countVariance: number;
  purchases: number;
  theoreticalFoodCostPercent: number | null;
  /** (theoretical + waste − net variance) / revenue. */
  actualFoodCostPercent: number | null;
};

export type FoodCostReport = { from: string; to: string; total: FoodCostRow; byBranch: FoodCostRow[] };

export type MenuEngineeringRow = {
  itemId: string;
  nameAr: string;
  nameEn: string | null;
  sold: number;
  revenue: number;
  cost: number | null;
  /** Per unit sold: average price − average cost. */
  unitMargin: number | null;
  totalMargin: number | null;
  /** Of items sold among the classified dishes. */
  share: number | null;
  foodCostPercent: number | null;
  /** null: no recipe cost for its sales. */
  class: MenuEngineeringClass | null;
};

export type MenuEngineeringReport = {
  days: number;
  branchId: string | null;
  /** Thresholds: 70% of an equal share, and the sales-weighted average unit margin. */
  popularityThreshold: number | null;
  averageMargin: number | null;
  rows: MenuEngineeringRow[];
};

// --- Labels ------------------------------------------------------------------------------------------

/** Names on screen: [Arabic, English]. */
export const STOCK_MOVEMENT_TYPE_LABELS: Record<StockMovementType, [string, string]> = {
  PURCHASE: ['استلام مشتريات', 'Purchase'],
  PURCHASE_VOID: ['إلغاء مشتريات', 'Purchase voided'],
  SALE: ['بيع', 'Sale'],
  SALE_REVERSAL: ['إلغاء بيع', 'Sale reversed'],
  WASTE: ['هالك', 'Waste'],
  COUNT_VARIANCE: ['فرق جرد', 'Count variance'],
  TRANSFER_IN: ['تحويل وارد', 'Transfer in'],
  TRANSFER_OUT: ['تحويل صادر', 'Transfer out'],
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, [string, string]> = {
  DRAFT: ['مسودة', 'Draft'],
  RECEIVED: ['اتستلمت', 'Received'],
  VOID: ['اتلغت', 'Void'],
};

export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, [string, string]> = {
  OPEN: ['مفتوح', 'Open'],
  PENDING_APPROVAL: ['مستني موافقة', 'Awaiting approval'],
  POSTED: ['اترحّل', 'Posted'],
  CANCELLED: ['اتلغى', 'Cancelled'],
};

export const STOCK_STATUS_LABELS: Record<StockStatus, [string, string]> = {
  OK: ['متوفر', 'In stock'],
  LOW: ['قرب يخلص', 'Low'],
  OUT: ['خلص', 'Out'],
};

export const MENU_ENGINEERING_CLASS_LABELS: Record<MenuEngineeringClass, [string, string]> = {
  STAR: ['نجم', 'Star'],
  PLOWHORSE: ['حصان شغل', 'Plowhorse'],
  PUZZLE: ['لغز', 'Puzzle'],
  DOG: ['ضعيف', 'Dog'],
};

export const INVENTORY_DEDUCT_ON_LABELS: Record<InventoryDeductOn, [string, string]> = {
  ACCEPTED: ['لما الطلب يتقبل', 'When accepted'],
  READY: ['لما الطلب يجهز', 'When ready'],
  COMPLETED: ['لما الطلب يتسلم', 'When completed'],
};

export const INVENTORY_STOCK_POLICY_LABELS: Record<InventoryStockPolicy, [string, string]> = {
  ALLOW_NEGATIVE: ['اقبل الطلب عادي', 'Allow (stock may go negative)'],
  WARN: ['اقبل ونبّه', 'Allow and warn'],
  BLOCK_ORDERS: ['ارفض الطلب', 'Refuse the order'],
};
