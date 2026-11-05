-- QR scans per table and local day (table analytics).
CREATE TABLE "table_daily_stats" (
    "table_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "scans" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "table_daily_stats_pkey" PRIMARY KEY ("table_id","day")
);
CREATE INDEX "table_daily_stats_restaurant_id_day_idx" ON "table_daily_stats"("restaurant_id", "day");
ALTER TABLE "table_daily_stats" ADD CONSTRAINT "table_daily_stats_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
