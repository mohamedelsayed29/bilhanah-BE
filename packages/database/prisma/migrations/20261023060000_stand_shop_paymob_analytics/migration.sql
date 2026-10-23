-- Phase 6: online payments (Paymob), the stand shop, and visit counts.
-- CreateEnum
CREATE TYPE "stand_order_status" AS ENUM ('AWAITING_PAYMENT', 'NEW', 'CONFIRMED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "stand_payment_method" AS ENUM ('CASH_ON_DELIVERY', 'PAYMOB');

-- CreateEnum
CREATE TYPE "stand_payment_status" AS ENUM ('UNPAID', 'PAID');

-- AlterEnum
ALTER TYPE "payment_method" ADD VALUE 'PAYMOB';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "payment_status" ADD VALUE 'AWAITING_PAYMENT';
ALTER TYPE "payment_status" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "paymob_order_id" VARCHAR(40),
ADD COLUMN     "paymob_transaction_id" VARCHAR(40);

-- CreateTable
CREATE TABLE "shop_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "delivery_fee_piastres" INTEGER,
    "cash_on_delivery" BOOLEAN NOT NULL DEFAULT true,
    "online_payment" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stand_logos" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stand_logos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stand_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "stand_order_status" NOT NULL,
    "payment_method" "stand_payment_method" NOT NULL,
    "payment_status" "stand_payment_status" NOT NULL DEFAULT 'UNPAID',
    "paid_at" TIMESTAMPTZ(3),
    "customer_name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254),
    "city" VARCHAR(60) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "customer_notes" VARCHAR(500),
    "admin_note" VARCHAR(1000),
    "language" "language" NOT NULL DEFAULT 'ar',
    "subtotal_piastres" INTEGER NOT NULL,
    "delivery_fee_piastres" INTEGER,
    "total_piastres" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "paymob_order_id" VARCHAR(40),
    "paymob_transaction_id" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stand_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stand_order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "shape" VARCHAR(20) NOT NULL,
    "nfc" BOOLEAN NOT NULL,
    "design" VARCHAR(20) NOT NULL,
    "custom_background" VARCHAR(7),
    "custom_ink" VARCHAR(7),
    "purpose" VARCHAR(20) NOT NULL,
    "brand" VARCHAR(35) NOT NULL,
    "caption" VARCHAR(60) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "logo_id" UUID,
    "numbered" BOOLEAN NOT NULL,
    "start_number" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "notes" VARCHAR(300) NOT NULL,
    "unit_price_piastres" INTEGER NOT NULL,

    CONSTRAINT "stand_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stand_order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "stand_order_status" NOT NULL,
    "note" VARCHAR(300),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stand_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_daily_stats" (
    "restaurant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "qr_visits" INTEGER NOT NULL DEFAULT 0,
    "table_visits" INTEGER NOT NULL DEFAULT 0,
    "link_visits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "restaurant_daily_stats_pkey" PRIMARY KEY ("restaurant_id","day")
);

-- CreateIndex
CREATE INDEX "stand_logos_created_at_idx" ON "stand_logos"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stand_orders_number_key" ON "stand_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "stand_orders_idempotency_key_key" ON "stand_orders"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "stand_orders_paymob_transaction_id_key" ON "stand_orders"("paymob_transaction_id");

-- CreateIndex
CREATE INDEX "stand_orders_status_created_at_idx" ON "stand_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "stand_orders_created_at_idx" ON "stand_orders"("created_at");

-- CreateIndex
CREATE INDEX "stand_order_lines_order_id_sort_order_idx" ON "stand_order_lines"("order_id", "sort_order");

-- CreateIndex
CREATE INDEX "stand_order_events_order_id_created_at_idx" ON "stand_order_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "restaurant_daily_stats_day_idx" ON "restaurant_daily_stats"("day");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_paymob_transaction_id_key" ON "subscription_payments"("paymob_transaction_id");

-- AddForeignKey
ALTER TABLE "stand_order_lines" ADD CONSTRAINT "stand_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "stand_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stand_order_lines" ADD CONSTRAINT "stand_order_lines_logo_id_fkey" FOREIGN KEY ("logo_id") REFERENCES "stand_logos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stand_order_events" ADD CONSTRAINT "stand_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "stand_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stand_order_events" ADD CONSTRAINT "stand_order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_stats" ADD CONSTRAINT "restaurant_daily_stats_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The shop's single settings row: cash on delivery, delivery fee confirmed by phone.
INSERT INTO "shop_settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;

-- References start at S-1001.
ALTER SEQUENCE "stand_orders_number_seq" RESTART WITH 1001;

ALTER TABLE "stand_orders"
  ADD CONSTRAINT "stand_orders_amounts_check" CHECK ("subtotal_piastres" > 0 AND "total_piastres" >= "subtotal_piastres" AND ("delivery_fee_piastres" IS NULL OR "delivery_fee_piastres" >= 0));
ALTER TABLE "stand_order_lines"
  ADD CONSTRAINT "stand_order_lines_quantity_check" CHECK ("quantity" BETWEEN 1 AND 500 AND "unit_price_piastres" > 0 AND "start_number" >= 1);
ALTER TABLE "restaurant_daily_stats"
  ADD CONSTRAINT "restaurant_daily_stats_counts_check" CHECK ("visits" >= 0 AND "qr_visits" >= 0 AND "table_visits" >= 0 AND "link_visits" >= 0);
