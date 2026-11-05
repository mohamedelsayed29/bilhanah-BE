-- Merged tables: a seating group with one shared session; dissolving keeps the record.
CREATE TABLE "table_groups" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "lead_table_id" UUID NOT NULL,
    "table_ids" UUID[],
    "label" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dissolved_at" TIMESTAMPTZ(3),
    CONSTRAINT "table_groups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "table_groups_branch_id_dissolved_at_idx" ON "table_groups"("branch_id", "dissolved_at");
ALTER TABLE "table_groups" ADD CONSTRAINT "table_groups_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_groups" ADD CONSTRAINT "table_groups_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tables" ADD COLUMN "group_id" UUID;
CREATE INDEX "tables_group_id_idx" ON "tables"("group_id");
ALTER TABLE "tables" ADD CONSTRAINT "tables_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "table_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
