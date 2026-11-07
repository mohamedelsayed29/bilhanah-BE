-- CreateEnum
CREATE TYPE "PosPaymentStatus" AS ENUM ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PosDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "PosIntegrationStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "PosMappingEntity" AS ENUM ('BRANCH', 'CATEGORY', 'MENU_ITEM', 'VARIANT', 'ORDER', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PosSyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'DEAD');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pos_device_id" UUID;

-- CreateTable
CREATE TABLE "order_payments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "method" "order_payment_method" NOT NULL,
    "status" "PosPaymentStatus" NOT NULL,
    "amount_piastres" INTEGER NOT NULL,
    "tendered_piastres" INTEGER,
    "change_piastres" INTEGER,
    "refunded_piastres" INTEGER NOT NULL DEFAULT 0,
    "reference" VARCHAR(100),
    "failure_reason" VARCHAR(200),
    "integration_id" UUID,
    "cashier_id" UUID,
    "cashier_name" VARCHAR(100),
    "device_id" UUID,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_payment_refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_piastres" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_devices" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "status" "PosDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_seen_at" TIMESTAMPTZ(3),
    "last_user_name" VARCHAR(100),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_integrations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "status" "PosIntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "branch_id" UUID,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials_sealed" TEXT NOT NULL,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_test_at" TIMESTAMPTZ(3),
    "last_test_ok" BOOLEAN,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_mappings" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "entity" "PosMappingEntity" NOT NULL,
    "local_id" UUID NOT NULL,
    "external_id" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_sync_jobs" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "entity_id" UUID,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PosSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(500),
    "last_status_code" INTEGER,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_webhook_events" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "event_id" VARCHAR(120) NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "error" VARCHAR(500),
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_payments_order_id_idx" ON "order_payments"("order_id");

-- CreateIndex
CREATE INDEX "order_payments_restaurant_id_created_at_idx" ON "order_payments"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_payments_restaurant_id_idempotency_key_key" ON "order_payments"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_payment_refunds_payment_id_idx" ON "order_payment_refunds"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_devices_key_hash_key" ON "pos_devices"("key_hash");

-- CreateIndex
CREATE INDEX "pos_devices_restaurant_id_status_idx" ON "pos_devices"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "pos_integrations_restaurant_id_status_idx" ON "pos_integrations"("restaurant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pos_mappings_integration_id_entity_local_id_key" ON "pos_mappings"("integration_id", "entity", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_mappings_integration_id_entity_external_id_key" ON "pos_mappings"("integration_id", "entity", "external_id");

-- CreateIndex
CREATE INDEX "pos_sync_jobs_status_next_run_at_idx" ON "pos_sync_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "pos_sync_jobs_integration_id_created_at_idx" ON "pos_sync_jobs"("integration_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sync_jobs_integration_id_idempotency_key_key" ON "pos_sync_jobs"("integration_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "pos_webhook_events_integration_id_received_at_idx" ON "pos_webhook_events"("integration_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_webhook_events_integration_id_event_id_key" ON "pos_webhook_events"("integration_id", "event_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_pos_device_id_fkey" FOREIGN KEY ("pos_device_id") REFERENCES "pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment_refunds" ADD CONSTRAINT "order_payment_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "order_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_integrations" ADD CONSTRAINT "pos_integrations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_mappings" ADD CONSTRAINT "pos_mappings_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "pos_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sync_jobs" ADD CONSTRAINT "pos_sync_jobs_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "pos_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_webhook_events" ADD CONSTRAINT "pos_webhook_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "pos_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_amounts_check" CHECK (
  "amount_piastres" > 0 AND "refunded_piastres" BETWEEN 0 AND "amount_piastres"
  AND ("tendered_piastres" IS NULL OR "tendered_piastres" >= "amount_piastres") AND ("change_piastres" IS NULL OR "change_piastres" >= 0)
);
ALTER TABLE "order_payment_refunds" ADD CONSTRAINT "order_payment_refunds_amount_check" CHECK ("amount_piastres" > 0);
ALTER TABLE "pos_sync_jobs" ADD CONSTRAINT "pos_sync_jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20);
