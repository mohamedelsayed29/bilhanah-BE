-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "media_kind" ADD VALUE 'PAYMENT_PROOF';

-- AlterTable
ALTER TABLE "entitlements" ADD COLUMN     "granted_by_id" UUID,
ADD COLUMN     "note" VARCHAR(300);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "plan_code" "plan_code" NOT NULL,
    "months" INTEGER NOT NULL,
    "amount_piastres" INTEGER NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "payer_name" VARCHAR(80),
    "proof_id" UUID,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "entitlement_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "rejection_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "instapay_address" VARCHAR(100),
    "vodafone_cash_number" VARCHAR(20),
    "bank_name" VARCHAR(80),
    "bank_account_name" VARCHAR(100),
    "bank_account_number" VARCHAR(40),
    "notes_ar" VARCHAR(500),
    "notes_en" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(60) NOT NULL,
    "target_type" VARCHAR(40) NOT NULL,
    "target_id" VARCHAR(64),
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expiry_reminders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "entitlement_id" UUID NOT NULL,
    "days_before" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_entitlement_id_key" ON "subscription_payments"("entitlement_id");

-- CreateIndex
CREATE INDEX "subscription_payments_status_created_at_idx" ON "subscription_payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "subscription_payments_restaurant_id_created_at_idx" ON "subscription_payments"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "expiry_reminders_entitlement_id_days_before_key" ON "expiry_reminders"("entitlement_id", "days_before");

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_reminders" ADD CONSTRAINT "expiry_reminders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_reminders" ADD CONSTRAINT "expiry_reminders_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One payment awaiting review per restaurant.
CREATE UNIQUE INDEX "subscription_payments_one_pending_per_restaurant"
  ON "subscription_payments" ("restaurant_id") WHERE "status" = 'PENDING';

ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_months_check" CHECK ("months" IN (1, 3, 6, 12));
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_amount_check" CHECK ("amount_piastres" >= 0);
ALTER TABLE "expiry_reminders" ADD CONSTRAINT "expiry_reminders_days_check" CHECK ("days_before" IN (0, 1, 3, 7));

ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_singleton" CHECK ("id" = 1);
INSERT INTO "payment_settings" ("id") VALUES (1);
