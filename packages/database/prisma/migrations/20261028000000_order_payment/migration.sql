-- Orders get a paid mark; an unpaid dine-in order keeps its table occupied.
ALTER TABLE "orders" ADD COLUMN "paid_at" TIMESTAMPTZ(3);

-- Orders finished before this change are treated as settled, so no table starts out occupied.
UPDATE "orders" SET "paid_at" = COALESCE("completed_at", "closed_at", "placed_at") WHERE "status" = 'COMPLETED';

CREATE INDEX "orders_restaurant_id_table_id_paid_at_idx" ON "orders"("restaurant_id", "table_id", "paid_at");
