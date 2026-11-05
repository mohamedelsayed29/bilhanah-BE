-- Orders moved between tables: from, to, when and by whom.
CREATE TABLE "order_table_transfers" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_table_id" UUID,
    "from_table_label" VARCHAR(40) NOT NULL,
    "to_table_id" UUID,
    "to_table_label" VARCHAR(40) NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_table_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_table_transfers_order_id_created_at_idx" ON "order_table_transfers"("order_id", "created_at");
ALTER TABLE "order_table_transfers" ADD CONSTRAINT "order_table_transfers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_table_transfers" ADD CONSTRAINT "order_table_transfers_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
