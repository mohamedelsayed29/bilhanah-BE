-- CreateEnum
CREATE TYPE "table_session_status" AS ENUM ('ACTIVE', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "table_session_close_reason" AS ENUM ('SETTLED', 'EXPIRED', 'STAFF');

-- CreateEnum
CREATE TYPE "table_cart_item_status" AS ENUM ('DRAFT', 'SUBMITTED');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "table_session_shared_editing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "table_sessions_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "table_sessions" ADD COLUMN     "closed_reason" "table_session_close_reason",
ADD COLUMN     "status" "table_session_status" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "table_session_id" UUID;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "guest_id" UUID,
ADD COLUMN     "guest_name" VARCHAR(30);

-- CreateTable
CREATE TABLE "table_guests" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "number" SMALLINT NOT NULL,
    "display_name" VARCHAR(30),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_cart_items" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "variant_name_ar" VARCHAR(40),
    "variant_name_en" VARCHAR(40),
    "unit_price_piastres" INTEGER NOT NULL,
    "quantity" SMALLINT NOT NULL,
    "note" VARCHAR(200),
    "status" "table_cart_item_status" NOT NULL DEFAULT 'DRAFT',
    "order_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),

    CONSTRAINT "table_cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "table_guests_session_id_number_key" ON "table_guests"("session_id", "number");

-- CreateIndex
CREATE INDEX "table_cart_items_session_id_status_idx" ON "table_cart_items"("session_id", "status");

-- CreateIndex
CREATE INDEX "table_cart_items_order_id_idx" ON "table_cart_items"("order_id");

-- CreateIndex
CREATE INDEX "table_sessions_branch_id_status_idx" ON "table_sessions"("branch_id", "status");

-- CreateIndex
CREATE INDEX "orders_table_session_id_idx" ON "orders"("table_session_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "table_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_guests" ADD CONSTRAINT "table_guests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cart_items" ADD CONSTRAINT "table_cart_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cart_items" ADD CONSTRAINT "table_cart_items_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "table_guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_cart_items" ADD CONSTRAINT "table_cart_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing sessions: ended ones are CLOSED; of the open ones, only each table's latest stays open
-- (older duplicates and idle ones close), so the partial unique index below can be built.
UPDATE "table_sessions" SET "status" = 'CLOSED', "closed_reason" = 'SETTLED' WHERE "ended_at" IS NOT NULL;
UPDATE "table_sessions" s SET "status" = 'CLOSED', "closed_reason" = 'EXPIRED', "ended_at" = s."last_activity_at"
WHERE s."ended_at" IS NULL AND (
  s."last_activity_at" < NOW() - INTERVAL '4 hours'
  OR s."id" <> (SELECT t."id" FROM "table_sessions" t WHERE t."table_id" = s."table_id" AND t."ended_at" IS NULL ORDER BY t."last_activity_at" DESC, t."id" LIMIT 1)
);

-- One open (ACTIVE or CLOSING) session per table: two phones scanning at once share it.
CREATE UNIQUE INDEX "table_sessions_one_open_per_table" ON "table_sessions"("table_id") WHERE "status" <> 'CLOSED';

ALTER TABLE "table_cart_items" ADD CONSTRAINT "table_cart_items_quantity_check" CHECK ("quantity" > 0);
