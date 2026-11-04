-- CreateEnum
CREATE TYPE "order_item_status" AS ENUM ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "order_priority" AS ENUM ('NORMAL', 'RUSH');

-- CreateEnum
CREATE TYPE "kitchen_ready_rule" AS ENUM ('ALL_ITEMS', 'MANUAL');

-- CreateEnum
CREATE TYPE "kitchen_station_kind" AS ENUM ('MAIN', 'GRILL', 'DRINKS', 'DESSERTS', 'COLD', 'BAKERY', 'OTHER');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "station_id" UUID;

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "station_id" UUID;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "accepted_at" TIMESTAMPTZ(3),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "prep_status" "order_item_status" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "ready_at" TIMESTAMPTZ(3),
ADD COLUMN     "served_at" TIMESTAMPTZ(3),
ADD COLUMN     "started_at" TIMESTAMPTZ(3),
ADD COLUMN     "station_id" UUID,
ADD COLUMN     "station_name" VARCHAR(40);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "priority" "order_priority" NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "kitchen_ready_rule" "kitchen_ready_rule" NOT NULL DEFAULT 'ALL_ITEMS';

-- CreateTable
CREATE TABLE "kitchen_stations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name_ar" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(40),
    "kind" "kitchen_station_kind" NOT NULL DEFAULT 'OTHER',
    "target_minutes" SMALLINT NOT NULL DEFAULT 15,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kitchen_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "status" "order_item_status" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kitchen_stations_restaurant_id_sort_order_idx" ON "kitchen_stations"("restaurant_id", "sort_order");

-- CreateIndex
CREATE INDEX "order_item_events_order_id_created_at_idx" ON "order_item_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_item_events_order_item_id_created_at_idx" ON "order_item_events"("order_item_id", "created_at");

-- CreateIndex
CREATE INDEX "order_items_station_id_idx" ON "order_items"("station_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_events" ADD CONSTRAINT "order_item_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_events" ADD CONSTRAINT "order_item_events_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_events" ADD CONSTRAINT "order_item_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing orders: their dishes follow the order's own status.
UPDATE "order_items" i SET
  "prep_status" = CASE o."status"
    WHEN 'ACCEPTED' THEN 'ACCEPTED'::"order_item_status"
    WHEN 'PREPARING' THEN 'PREPARING'::"order_item_status"
    WHEN 'READY' THEN 'READY'::"order_item_status"
    WHEN 'COMPLETED' THEN 'SERVED'::"order_item_status"
    WHEN 'REJECTED' THEN 'CANCELLED'::"order_item_status"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"order_item_status"
    ELSE 'NEW'::"order_item_status" END,
  "accepted_at" = o."accepted_at",
  "ready_at" = o."ready_at",
  "served_at" = o."completed_at",
  "cancelled_at" = CASE WHEN o."status" IN ('REJECTED', 'CANCELLED') THEN o."closed_at" END
FROM "orders" o WHERE o."id" = i."order_id";
