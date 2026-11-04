-- CreateTable
CREATE TABLE "table_areas" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "location" "table_location" NOT NULL DEFAULT 'INDOOR',
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "table_areas_pkey" PRIMARY KEY ("id")
);

-- AlterTable: existing tables start without an area.
ALTER TABLE "tables" ADD COLUMN "area_id" UUID;

-- CreateIndex
CREATE INDEX "table_areas_restaurant_id_idx" ON "table_areas"("restaurant_id");
CREATE INDEX "table_areas_branch_id_sort_order_idx" ON "table_areas"("branch_id", "sort_order");
CREATE UNIQUE INDEX "table_areas_branch_id_name_key" ON "table_areas"("branch_id", "name");
CREATE INDEX "tables_area_id_idx" ON "tables"("area_id");

-- AddForeignKey
ALTER TABLE "table_areas" ADD CONSTRAINT "table_areas_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_areas" ADD CONSTRAINT "table_areas_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tables" ADD CONSTRAINT "tables_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "table_areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
