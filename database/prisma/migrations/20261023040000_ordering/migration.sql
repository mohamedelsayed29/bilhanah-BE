-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('DINE_IN', 'PICKUP');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "accepts_dine_in" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "accepts_pickup" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ordering_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "orders_paused" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tables" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "public_code" VARCHAR(16) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "type" "order_type" NOT NULL,
    "table_id" UUID,
    "table_label" VARCHAR(40),
    "customer_name" VARCHAR(60) NOT NULL,
    "customer_phone" VARCHAR(20),
    "note" VARCHAR(300),
    "status" "order_status" NOT NULL DEFAULT 'PLACED',
    "subtotal_piastres" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "rejection_reason" VARCHAR(300),
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "variant_name_ar" VARCHAR(40),
    "variant_name_en" VARCHAR(40),
    "unit_price_piastres" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" VARCHAR(200),
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_counters" (
    "restaurant_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "order_counters_pkey" PRIMARY KEY ("restaurant_id","business_day")
);

-- CreateIndex
CREATE UNIQUE INDEX "tables_public_code_key" ON "tables"("public_code");

-- CreateIndex
CREATE INDEX "tables_restaurant_id_sort_order_idx" ON "tables"("restaurant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "tables_restaurant_id_label_key" ON "tables"("restaurant_id", "label");

-- CreateIndex
CREATE INDEX "orders_restaurant_id_status_placed_at_idx" ON "orders"("restaurant_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "orders_restaurant_id_placed_at_idx" ON "orders"("restaurant_id", "placed_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_restaurant_id_idempotency_key_key" ON "orders"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_restaurant_id_business_day_number_key" ON "orders"("restaurant_id", "business_day", "number");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orders" ADD CONSTRAINT "orders_subtotal_check" CHECK ("subtotal_piastres" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_number_check" CHECK ("number" >= 1);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 50);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_check" CHECK ("unit_price_piastres" >= 0);
