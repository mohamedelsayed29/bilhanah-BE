-- A table's housekeeping state: CLEANING after the guests leave, until staff mark it ready.
CREATE TYPE "table_condition" AS ENUM ('READY', 'CLEANING');
ALTER TABLE "tables" ADD COLUMN "condition" "table_condition" NOT NULL DEFAULT 'READY',
  ADD COLUMN "condition_at" TIMESTAMPTZ(3);
