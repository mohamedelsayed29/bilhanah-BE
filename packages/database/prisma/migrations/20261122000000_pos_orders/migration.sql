-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('MENU', 'POS');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "channel" "OrderChannel" NOT NULL DEFAULT 'MENU',
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "created_by_name" VARCHAR(100),
ADD COLUMN     "discount_reason" VARCHAR(200),
ADD COLUMN     "service_charge_piastres" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_piastres" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_piastres" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "orders_restaurant_id_channel_placed_at_idx" ON "orders"("restaurant_id", "channel", "placed_at");


-- Orders placed before POS bills: the bill was the subtotal less the discount.
UPDATE "orders" SET "total_piastres" = "subtotal_piastres" - "discount_piastres";
ALTER TABLE "orders" ADD CONSTRAINT "orders_bill_check" CHECK ("service_charge_piastres" >= 0 AND "tax_piastres" >= 0 AND "total_piastres" >= 0);
