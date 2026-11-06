-- Inventory, recipes and cost management (docs/INVENTORY.md).
--
-- Ingredients (raw or prepared from a recipe) with purchase units, suppliers, stock per branch with
-- a weighted average cost, an immutable stock ledger (stock_movements, idempotent by source_key),
-- purchases, waste, stock counts and transfers, and recipes per dish size. Orders deduct stock
-- through recipes when accepted (order_items.variant_id, cost_piastres), and a dish can be marked
-- sold out at a branch by inventory (branch_menu_items.sold_out_by_inventory).
-- Quantities DECIMAL(14,3) in base units, unit costs DECIMAL(14,4) piastres per base unit, values
-- DECIMAL(16,2) piastres.

-- CreateEnum
CREATE TYPE "ingredient_kind" AS ENUM ('RAW', 'PREPARED');

-- CreateEnum
CREATE TYPE "inventory_dimension" AS ENUM ('MASS', 'VOLUME', 'COUNT');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('PURCHASE', 'PURCHASE_VOID', 'SALE', 'SALE_REVERSAL', 'WASTE', 'COUNT_VARIANCE', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "purchase_status" AS ENUM ('DRAFT', 'RECEIVED', 'VOID');

-- CreateEnum
CREATE TYPE "stock_count_status" AS ENUM ('OPEN', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "waste_reason" AS ENUM ('SPOILED', 'EXPIRED', 'DROPPED', 'OVERPRODUCTION', 'STAFF_MEAL', 'COMPED', 'OTHER');

-- AlterTable
ALTER TABLE "branch_menu_items" ADD COLUMN     "sold_out_by_inventory" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "cost_piastres" INTEGER,
ADD COLUMN     "variant_id" UUID;

-- CreateTable
CREATE TABLE "inventory_settings" (
    "restaurant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_sold_out" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("restaurant_id")
);

-- CreateTable
CREATE TABLE "inventory_suppliers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(30),
    "email" VARCHAR(254),
    "note" VARCHAR(300),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name_ar" VARCHAR(80) NOT NULL,
    "name_en" VARCHAR(80),
    "category" VARCHAR(40),
    "kind" "ingredient_kind" NOT NULL DEFAULT 'RAW',
    "dimension" "inventory_dimension" NOT NULL,
    "standard_cost" DECIMAL(14,4),
    "yield_quantity" DECIMAL(14,3),
    "preferred_supplier_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_units" (
    "id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "name_ar" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(40),
    "factor" DECIMAL(14,3) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "ingredient_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_lines" (
    "id" UUID NOT NULL,
    "variant_id" UUID,
    "prepared_ingredient_id" UUID,
    "ingredient_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "waste_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock" (
    "branch_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "on_hand" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avg_cost" DECIMAL(14,4),
    "reorder_point" DECIMAL(14,3),
    "par_level" DECIMAL(14,3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_stock_pkey" PRIMARY KEY ("branch_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "type" "stock_movement_type" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "value" DECIMAL(16,2) NOT NULL,
    "on_hand_after" DECIMAL(14,3) NOT NULL,
    "avg_cost_after" DECIMAL(14,4),
    "source_key" VARCHAR(160) NOT NULL,
    "purchase_id" UUID,
    "order_id" UUID,
    "order_item_id" UUID,
    "waste_id" UUID,
    "count_id" UUID,
    "transfer_id" UUID,
    "note" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_purchases" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID,
    "supplier_name" VARCHAR(80),
    "invoice_number" VARCHAR(60),
    "invoice_date" DATE,
    "status" "purchase_status" NOT NULL DEFAULT 'DRAFT',
    "note" VARCHAR(300),
    "total" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "received_by_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_purchase_lines" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "unit_id" UUID,
    "unit_name" VARCHAR(40),
    "factor" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "quantity" DECIMAL(14,3) NOT NULL,
    "base_quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(16,4) NOT NULL,
    "line_total" DECIMAL(16,2) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "inventory_purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_waste" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "reason" "waste_reason" NOT NULL,
    "note" VARCHAR(300),
    "total" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_waste_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_waste_lines" (
    "id" UUID NOT NULL,
    "waste_id" UUID NOT NULL,
    "ingredient_id" UUID,
    "variant_id" UUID,
    "name_ar" VARCHAR(150) NOT NULL,
    "name_en" VARCHAR(150),
    "unit_name" VARCHAR(40),
    "quantity" DECIMAL(14,3) NOT NULL,
    "value" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "inventory_waste_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_counts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "stock_count_status" NOT NULL DEFAULT 'OPEN',
    "note" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(3),
    "posted_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_lines" (
    "count_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "expected" DECIMAL(14,3) NOT NULL,
    "counted" DECIMAL(14,3),
    "unit_cost" DECIMAL(14,4),

    CONSTRAINT "inventory_count_lines_pkey" PRIMARY KEY ("count_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "inventory_transfers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "from_branch_id" UUID NOT NULL,
    "to_branch_id" UUID NOT NULL,
    "note" VARCHAR(300),
    "total" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfer_lines" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "value" DECIMAL(16,2) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "inventory_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_suppliers_restaurant_id_name_key" ON "inventory_suppliers"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "ingredients_restaurant_id_kind_idx" ON "ingredients"("restaurant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_restaurant_id_name_ar_key" ON "ingredients"("restaurant_id", "name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_units_ingredient_id_name_ar_key" ON "ingredient_units"("ingredient_id", "name_ar");

-- CreateIndex
CREATE INDEX "recipe_lines_ingredient_id_idx" ON "recipe_lines"("ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_variant_id_ingredient_id_key" ON "recipe_lines"("variant_id", "ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_prepared_ingredient_id_ingredient_id_key" ON "recipe_lines"("prepared_ingredient_id", "ingredient_id");

-- CreateIndex
CREATE INDEX "inventory_stock_restaurant_id_idx" ON "inventory_stock"("restaurant_id");

-- CreateIndex
CREATE INDEX "inventory_stock_ingredient_id_idx" ON "inventory_stock"("ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_source_key_key" ON "stock_movements"("source_key");

-- CreateIndex
CREATE INDEX "stock_movements_branch_id_ingredient_id_created_at_idx" ON "stock_movements"("branch_id", "ingredient_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_restaurant_id_type_created_at_idx" ON "stock_movements"("restaurant_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_ingredient_id_idx" ON "stock_movements"("ingredient_id");

-- CreateIndex
CREATE INDEX "stock_movements_order_item_id_idx" ON "stock_movements"("order_item_id");

-- CreateIndex
CREATE INDEX "stock_movements_order_id_idx" ON "stock_movements"("order_id");

-- CreateIndex
CREATE INDEX "stock_movements_purchase_id_idx" ON "stock_movements"("purchase_id");

-- CreateIndex
CREATE INDEX "inventory_purchases_restaurant_id_created_at_idx" ON "inventory_purchases"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_purchases_branch_id_status_created_at_idx" ON "inventory_purchases"("branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "inventory_purchases_supplier_id_idx" ON "inventory_purchases"("supplier_id");

-- CreateIndex
CREATE INDEX "inventory_purchase_lines_purchase_id_idx" ON "inventory_purchase_lines"("purchase_id");

-- CreateIndex
CREATE INDEX "inventory_purchase_lines_ingredient_id_idx" ON "inventory_purchase_lines"("ingredient_id");

-- CreateIndex
CREATE INDEX "inventory_waste_restaurant_id_created_at_idx" ON "inventory_waste"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_waste_branch_id_created_at_idx" ON "inventory_waste"("branch_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_waste_lines_waste_id_idx" ON "inventory_waste_lines"("waste_id");

-- CreateIndex
CREATE INDEX "inventory_waste_lines_ingredient_id_idx" ON "inventory_waste_lines"("ingredient_id");

-- CreateIndex
CREATE INDEX "inventory_counts_restaurant_id_created_at_idx" ON "inventory_counts"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_counts_branch_id_status_idx" ON "inventory_counts"("branch_id", "status");

-- CreateIndex
CREATE INDEX "inventory_count_lines_ingredient_id_idx" ON "inventory_count_lines"("ingredient_id");

-- CreateIndex
CREATE INDEX "inventory_transfers_restaurant_id_created_at_idx" ON "inventory_transfers"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transfers_from_branch_id_created_at_idx" ON "inventory_transfers"("from_branch_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transfers_to_branch_id_created_at_idx" ON "inventory_transfers"("to_branch_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transfer_lines_transfer_id_idx" ON "inventory_transfer_lines"("transfer_id");

-- CreateIndex
CREATE INDEX "inventory_transfer_lines_ingredient_id_idx" ON "inventory_transfer_lines"("ingredient_id");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_preferred_supplier_id_fkey" FOREIGN KEY ("preferred_supplier_id") REFERENCES "inventory_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_units" ADD CONSTRAINT "ingredient_units_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_prepared_ingredient_id_fkey" FOREIGN KEY ("prepared_ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "inventory_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_waste_id_fkey" FOREIGN KEY ("waste_id") REFERENCES "inventory_waste"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "inventory_counts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "inventory_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchase_lines" ADD CONSTRAINT "inventory_purchase_lines_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "inventory_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchase_lines" ADD CONSTRAINT "inventory_purchase_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchase_lines" ADD CONSTRAINT "inventory_purchase_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "ingredient_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste" ADD CONSTRAINT "inventory_waste_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste" ADD CONSTRAINT "inventory_waste_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste" ADD CONSTRAINT "inventory_waste_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste_lines" ADD CONSTRAINT "inventory_waste_lines_waste_id_fkey" FOREIGN KEY ("waste_id") REFERENCES "inventory_waste"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste_lines" ADD CONSTRAINT "inventory_waste_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_waste_lines" ADD CONSTRAINT "inventory_waste_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "inventory_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_to_branch_id_fkey" FOREIGN KEY ("to_branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- --- Integrity rules Prisma does not model -------------------------------------------------------

-- One open stock count per branch.
CREATE UNIQUE INDEX "inventory_counts_one_open_per_branch" ON "inventory_counts"("branch_id") WHERE "status" = 'OPEN';

ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_standard_cost_check" CHECK ("standard_cost" IS NULL OR "standard_cost" >= 0);
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_yield_check" CHECK ("yield_quantity" IS NULL OR "yield_quantity" > 0);
-- Only prepared ingredients make a yield.
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_yield_prepared_only" CHECK ("kind" = 'PREPARED' OR "yield_quantity" IS NULL);

ALTER TABLE "ingredient_units" ADD CONSTRAINT "ingredient_units_factor_check" CHECK ("factor" > 0);

-- A recipe line belongs to exactly one recipe: a dish size's or a prepared ingredient's.
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_one_owner" CHECK (num_nonnulls("variant_id", "prepared_ingredient_id") = 1);
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_waste_percent_check" CHECK ("waste_percent" >= 0 AND "waste_percent" <= 90);
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_not_self" CHECK ("prepared_ingredient_id" IS DISTINCT FROM "ingredient_id");

ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_avg_cost_check" CHECK ("avg_cost" IS NULL OR "avg_cost" >= 0);
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_levels_check" CHECK (("reorder_point" IS NULL OR "reorder_point" >= 0) AND ("par_level" IS NULL OR "par_level" >= 0));

-- Movements are never zero, are valued at a non-negative cost, and carry the sign of their type.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_check" CHECK ("quantity" <> 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_cost_check" CHECK ("unit_cost" >= 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sign_check" CHECK (
  ("type" IN ('PURCHASE', 'SALE_REVERSAL', 'TRANSFER_IN') AND "quantity" > 0)
  OR ("type" IN ('PURCHASE_VOID', 'SALE', 'WASTE', 'TRANSFER_OUT') AND "quantity" < 0)
  OR "type" = 'COUNT_VARIANCE'
);

ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_total_check" CHECK ("total" >= 0);
ALTER TABLE "inventory_purchase_lines" ADD CONSTRAINT "inventory_purchase_lines_quantity_check" CHECK ("quantity" > 0 AND "base_quantity" > 0 AND "factor" > 0);
ALTER TABLE "inventory_purchase_lines" ADD CONSTRAINT "inventory_purchase_lines_price_check" CHECK ("unit_price" >= 0 AND "line_total" >= 0);

ALTER TABLE "inventory_waste_lines" ADD CONSTRAINT "inventory_waste_lines_quantity_check" CHECK ("quantity" > 0);
-- An ingredient or a dish size (both may be gone later: the names are copies).
ALTER TABLE "inventory_waste_lines" ADD CONSTRAINT "inventory_waste_lines_one_subject" CHECK (num_nonnulls("ingredient_id", "variant_id") <= 1);

ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_counted_check" CHECK ("counted" IS NULL OR "counted" >= 0);

ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_branches_check" CHECK ("from_branch_id" <> "to_branch_id");
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_check" CHECK ("quantity" > 0 AND "unit_cost" >= 0);

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cost_check" CHECK ("cost_piastres" IS NULL OR "cost_piastres" >= 0);
