-- CreateEnum
CREATE TYPE "recommendation_type" AS ENUM ('FREQUENTLY_BOUGHT_TOGETHER', 'ADD_ON', 'UPGRADE', 'ALTERNATIVE');

-- CreateEnum
CREATE TYPE "recommendation_placement" AS ENUM ('PRODUCT_DETAILS', 'CART', 'CHECKOUT');

-- CreateEnum
CREATE TYPE "recommendation_event_kind" AS ENUM ('IMPRESSION', 'CLICK', 'ADD');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "recommendation_placement" "recommendation_placement",
ADD COLUMN     "recommendation_rule_id" UUID;

-- CreateTable
CREATE TABLE "recommendation_rules" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "source_item_id" UUID NOT NULL,
    "type" "recommendation_type" NOT NULL,
    "placements" "recommendation_placement"[],
    "title" VARCHAR(60),
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recommendation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_rule_items" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "variant_id" UUID,
    "max_quantity" SMALLINT NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "recommendation_rule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID,
    "rule_id" UUID,
    "item_id" UUID NOT NULL,
    "kind" "recommendation_event_kind" NOT NULL,
    "placement" "recommendation_placement" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_rules_restaurant_id_sort_order_idx" ON "recommendation_rules"("restaurant_id", "sort_order");

-- CreateIndex
CREATE INDEX "recommendation_rules_source_item_id_idx" ON "recommendation_rules"("source_item_id");

-- CreateIndex
CREATE INDEX "recommendation_rule_items_rule_id_sort_order_idx" ON "recommendation_rule_items"("rule_id", "sort_order");

-- CreateIndex
CREATE INDEX "recommendation_rule_items_item_id_idx" ON "recommendation_rule_items"("item_id");

-- CreateIndex
CREATE INDEX "recommendation_events_restaurant_id_created_at_idx" ON "recommendation_events"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_events_rule_id_kind_idx" ON "recommendation_events"("rule_id", "kind");

-- AddForeignKey
ALTER TABLE "recommendation_rules" ADD CONSTRAINT "recommendation_rules_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_rules" ADD CONSTRAINT "recommendation_rules_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_rule_items" ADD CONSTRAINT "recommendation_rule_items_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recommendation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_rule_items" ADD CONSTRAINT "recommendation_rule_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_rule_items" ADD CONSTRAINT "recommendation_rule_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recommendation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recommendation_rule_id_fkey" FOREIGN KEY ("recommendation_rule_id") REFERENCES "recommendation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
