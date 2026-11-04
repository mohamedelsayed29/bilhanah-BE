-- CreateEnum
CREATE TYPE "table_attribute" AS ENUM ('WINDOW', 'SOFA', 'VIP', 'ACCESSIBLE', 'POWER_OUTLET', 'QUIET', 'SMOKING');
CREATE TYPE "reservation_status" AS ENUM ('PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- AlterTable: floor-plan position and table details, all empty until the owner sets them.
ALTER TABLE "tables" ADD COLUMN "floor_x" REAL,
ADD COLUMN "floor_y" REAL,
ADD COLUMN "min_order_piastres" INTEGER,
ADD COLUMN "notes" VARCHAR(200),
ADD COLUMN "attributes" "table_attribute"[] DEFAULT ARRAY[]::"table_attribute"[];

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "table_id" UUID,
    "customer_name" VARCHAR(80) NOT NULL,
    "customer_phone" VARCHAR(20),
    "guests" SMALLINT NOT NULL,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'CONFIRMED',
    "notes" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_restaurant_id_idx" ON "reservations"("restaurant_id");
CREATE INDEX "reservations_branch_id_reserved_at_idx" ON "reservations"("branch_id", "reserved_at");
CREATE INDEX "reservations_table_id_reserved_at_idx" ON "reservations"("table_id", "reserved_at");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
