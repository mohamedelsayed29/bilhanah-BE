-- CreateEnum
CREATE TYPE "MenuSource" AS ENUM ('BILHANAH', 'EXTERNAL', 'NONE');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('BILHANAH', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "RestaurantServiceKey" AS ENUM ('DIGITAL_MENU', 'QR_ORDERING', 'REVIEWS', 'INVENTORY', 'CASH_DRAWER', 'ATTENDANCE');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "source" "DataSource" NOT NULL DEFAULT 'BILHANAH';

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "external_menu_url" VARCHAR(500),
ADD COLUMN     "external_pos_name" VARCHAR(60),
ADD COLUMN     "menu_source" "MenuSource" NOT NULL DEFAULT 'BILHANAH',
ADD COLUMN     "setup_completed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "restaurant_services" (
    "restaurant_id" UUID NOT NULL,
    "service" "RestaurantServiceKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by_id" UUID,

    CONSTRAINT "restaurant_services_pkey" PRIMARY KEY ("restaurant_id","service")
);

-- AddForeignKey
ALTER TABLE "restaurant_services" ADD CONSTRAINT "restaurant_services_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Restaurants that already exist keep working as before: their setup counts as done, and with no
-- service rows every service stays on.
UPDATE "restaurants" SET "setup_completed_at" = "created_at" WHERE "setup_completed_at" IS NULL;
