-- CreateEnum
CREATE TYPE "service_request_type" AS ENUM ('CALL_WAITER', 'REQUEST_BILL', 'REQUEST_WATER', 'REQUEST_NAPKINS', 'REQUEST_CLEANING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "service_request_status" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "service_request_cooldown_seconds" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "service_request_hourly_limit" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "service_requests_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "table_id" UUID,
    "table_label" VARCHAR(40) NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "service_request_type" NOT NULL,
    "status" "service_request_status" NOT NULL DEFAULT 'PENDING',
    "note" VARCHAR(200),
    "assigned_to_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "handled_by_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_guest" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "table_sessions_table_id_ended_at_idx" ON "table_sessions"("table_id", "ended_at");

-- CreateIndex
CREATE INDEX "table_sessions_restaurant_id_idx" ON "table_sessions"("restaurant_id");

-- CreateIndex
CREATE INDEX "service_requests_branch_id_status_created_at_idx" ON "service_requests"("branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "service_requests_restaurant_id_created_at_idx" ON "service_requests"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "service_requests_table_id_type_created_at_idx" ON "service_requests"("table_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "service_requests_session_id_idx" ON "service_requests"("session_id");

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
