-- Owner-configurable inventory (docs/INVENTORY.md, Settings).
--
-- When orders deduct stock (deduct_on), what placing an order does when stock is short
-- (stock_policy, per branch too), auto sold-out and restore (per branch too), the valuation basis
-- of reports, the restaurant's own waste reasons, stock-count approval above a variance threshold,
-- and a default reorder point per ingredient. Orders remember when their stock was deducted
-- (idempotency whatever the setting) and which dishes were short when placed (WARN policy).

-- CreateEnum
CREATE TYPE "inventory_deduct_on" AS ENUM ('ACCEPTED', 'READY', 'COMPLETED');

-- CreateEnum
CREATE TYPE "inventory_stock_policy" AS ENUM ('ALLOW_NEGATIVE', 'WARN', 'BLOCK_ORDERS');

-- CreateEnum
CREATE TYPE "inventory_valuation_basis" AS ENUM ('AVERAGE', 'STANDARD');

-- A count waiting for approval. (The new value cannot be used in this transaction, so the
-- one-open-count index below is written with the values that close a count.)
ALTER TYPE "stock_count_status" ADD VALUE 'PENDING_APPROVAL' AFTER 'OPEN';

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "default_reorder_point" DECIMAL(14,3);
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_default_reorder_point_check" CHECK ("default_reorder_point" IS NULL OR "default_reorder_point" >= 0);

-- AlterTable
ALTER TABLE "inventory_counts" ADD COLUMN     "review_note" VARCHAR(300),
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3),
ADD COLUMN     "submitted_by_id" UUID;

-- One count per branch that is still open or waiting for approval.
DROP INDEX "inventory_counts_one_open_per_branch";
CREATE UNIQUE INDEX "inventory_counts_one_open_per_branch" ON "inventory_counts"("branch_id") WHERE "status" NOT IN ('POSTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "inventory_settings" ADD COLUMN     "auto_restore" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "count_variance_threshold_percent" DECIMAL(7,2) NOT NULL DEFAULT 10,
ADD COLUMN     "deduct_on" "inventory_deduct_on" NOT NULL DEFAULT 'ACCEPTED',
ADD COLUMN     "require_count_approval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stock_policy" "inventory_stock_policy" NOT NULL DEFAULT 'ALLOW_NEGATIVE',
ADD COLUMN     "valuation_basis" "inventory_valuation_basis" NOT NULL DEFAULT 'AVERAGE',
ADD COLUMN     "waste_reasons" JSONB,
ALTER COLUMN "auto_sold_out" SET DEFAULT true;
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_threshold_check" CHECK ("count_variance_threshold_percent" >= 0);
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_waste_reasons_array" CHECK ("waste_reasons" IS NULL OR jsonb_typeof("waste_reasons") = 'array');

-- Waste reasons become the restaurant's own codes, with their names copied on each entry.
ALTER TABLE "inventory_waste" ADD COLUMN "reason_name_ar" VARCHAR(60), ADD COLUMN "reason_name_en" VARCHAR(60);
ALTER TABLE "inventory_waste" ALTER COLUMN "reason" TYPE VARCHAR(40) USING "reason"::text;
UPDATE "inventory_waste" SET
  "reason" = CASE "reason" WHEN 'COMPED' THEN 'COMPLIMENTARY' WHEN 'OVERPRODUCTION' THEN 'OVERCOOKED' ELSE "reason" END,
  "reason_name_ar" = CASE "reason"
    WHEN 'EXPIRED' THEN 'انتهت صلاحيته' WHEN 'SPOILED' THEN 'باظ' WHEN 'DROPPED' THEN 'وقع'
    WHEN 'OVERPRODUCTION' THEN 'اتحرق أو زيادة تسوية' WHEN 'STAFF_MEAL' THEN 'وجبة موظفين' WHEN 'COMPED' THEN 'ضيافة' ELSE 'سبب تاني' END,
  "reason_name_en" = CASE "reason"
    WHEN 'EXPIRED' THEN 'Expired' WHEN 'SPOILED' THEN 'Spoiled' WHEN 'DROPPED' THEN 'Dropped'
    WHEN 'OVERPRODUCTION' THEN 'Overcooked' WHEN 'STAFF_MEAL' THEN 'Staff meal' WHEN 'COMPED' THEN 'Complimentary' ELSE 'Other' END;
ALTER TABLE "inventory_waste" ALTER COLUMN "reason_name_ar" SET NOT NULL;

-- DropEnum
DROP TYPE "waste_reason";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "low_stock_item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "stock_deducted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "inventory_branch_settings" (
    "branch_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "stock_policy" "inventory_stock_policy",
    "auto_sold_out" BOOLEAN,
    "auto_restore" BOOLEAN,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_branch_settings_pkey" PRIMARY KEY ("branch_id")
);

-- CreateIndex
CREATE INDEX "inventory_branch_settings_restaurant_id_idx" ON "inventory_branch_settings"("restaurant_id");

-- AddForeignKey
ALTER TABLE "inventory_branch_settings" ADD CONSTRAINT "inventory_branch_settings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Orders already accepted with inventory on were deducted at acceptance.
UPDATE "orders" o SET "stock_deducted_at" = o."accepted_at"
WHERE EXISTS (SELECT 1 FROM "stock_movements" m WHERE m."order_id" = o."id" AND m."type" = 'SALE');
