-- CreateEnum
CREATE TYPE "order_push_updates" AS ENUM ('READY', 'ALL');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "estimated_ready_at" TIMESTAMPTZ(3),
ADD COLUMN     "ready_notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "tracked_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN     "updates" "order_push_updates" NOT NULL DEFAULT 'READY';

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "order_prep_minutes" INTEGER;

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "order_status" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_status_events_order_id_created_at_idx" ON "order_status_events"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: the history of existing orders, from the times they already record (no actor).
INSERT INTO "order_status_events" ("id", "order_id", "status", "created_at")
SELECT gen_random_uuid(), o."id", 'PLACED', o."placed_at" FROM "orders" o;
INSERT INTO "order_status_events" ("id", "order_id", "status", "created_at")
SELECT gen_random_uuid(), o."id", 'ACCEPTED', o."accepted_at" FROM "orders" o WHERE o."accepted_at" IS NOT NULL;
INSERT INTO "order_status_events" ("id", "order_id", "status", "created_at")
SELECT gen_random_uuid(), o."id", 'READY', o."ready_at" FROM "orders" o WHERE o."ready_at" IS NOT NULL;
INSERT INTO "order_status_events" ("id", "order_id", "status", "created_at")
SELECT gen_random_uuid(), o."id", 'COMPLETED', o."completed_at" FROM "orders" o WHERE o."completed_at" IS NOT NULL;
INSERT INTO "order_status_events" ("id", "order_id", "status", "reason", "created_at")
SELECT gen_random_uuid(), o."id", o."status", o."rejection_reason", o."closed_at" FROM "orders" o
WHERE o."closed_at" IS NOT NULL AND o."status" IN ('REJECTED', 'CANCELLED');
