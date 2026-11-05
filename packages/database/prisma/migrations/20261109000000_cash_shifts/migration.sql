-- CreateEnum
CREATE TYPE "order_payment_method" AS ENUM ('CASH', 'CARD', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "cash_shift_status" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "cash_review_status" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "cash_transaction_kind" AS ENUM ('SALE', 'REFUND', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "cash_approval_status" AS ENUM ('APPROVED', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "closing_note_rule" AS ENUM ('NEVER', 'ON_DISCREPANCY', 'ALWAYS');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_method" "order_payment_method";

-- CreateTable
CREATE TABLE "cash_settings" (
    "restaurant_id" UUID NOT NULL,
    "allow_shared_register" BOOLEAN NOT NULL DEFAULT false,
    "require_shift_for_cash" BOOLEAN NOT NULL DEFAULT false,
    "adjustments_need_approval" BOOLEAN NOT NULL DEFAULT true,
    "discrepancy_tolerance_piastres" INTEGER NOT NULL DEFAULT 0,
    "closing_note" "closing_note_rule" NOT NULL DEFAULT 'ON_DISCREPANCY',
    "currency" CHAR(3) NOT NULL DEFAULT 'EGP',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_settings_pkey" PRIMARY KEY ("restaurant_id")
);

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_shifts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "register_id" UUID,
    "cashier_id" UUID,
    "cashier_name" VARCHAR(100) NOT NULL,
    "status" "cash_shift_status" NOT NULL DEFAULT 'OPEN',
    "currency" CHAR(3) NOT NULL DEFAULT 'EGP',
    "opening_piastres" INTEGER NOT NULL,
    "opening_note" VARCHAR(500),
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closing_started_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "expected_piastres" INTEGER,
    "counted_piastres" INTEGER,
    "discrepancy_piastres" INTEGER,
    "closing_note" VARCHAR(500),
    "review_status" "cash_review_status",
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transactions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "kind" "cash_transaction_kind" NOT NULL,
    "amount_piastres" INTEGER NOT NULL,
    "reason" VARCHAR(300),
    "order_id" UUID,
    "source_key" VARCHAR(120),
    "approval_status" "cash_approval_status" NOT NULL DEFAULT 'APPROVED',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_registers_restaurant_id_idx" ON "cash_registers"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_branch_id_name_key" ON "cash_registers"("branch_id", "name");

-- CreateIndex
CREATE INDEX "cash_shifts_restaurant_id_opened_at_idx" ON "cash_shifts"("restaurant_id", "opened_at");

-- CreateIndex
CREATE INDEX "cash_shifts_branch_id_status_idx" ON "cash_shifts"("branch_id", "status");

-- CreateIndex
CREATE INDEX "cash_shifts_cashier_id_opened_at_idx" ON "cash_shifts"("cashier_id", "opened_at");

-- CreateIndex
CREATE INDEX "cash_shifts_register_id_status_idx" ON "cash_shifts"("register_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transactions_source_key_key" ON "cash_transactions"("source_key");

-- CreateIndex
CREATE INDEX "cash_transactions_shift_id_created_at_idx" ON "cash_transactions"("shift_id", "created_at");

-- CreateIndex
CREATE INDEX "cash_transactions_restaurant_id_approval_status_idx" ON "cash_transactions"("restaurant_id", "approval_status");

-- CreateIndex
CREATE INDEX "cash_transactions_order_id_idx" ON "cash_transactions"("order_id");

-- AddForeignKey
ALTER TABLE "cash_settings" ADD CONSTRAINT "cash_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One active (open or closing) shift per cashier.
CREATE UNIQUE INDEX "cash_shifts_one_active_per_cashier" ON "cash_shifts"("cashier_id") WHERE "status" <> 'CLOSED';

-- Amounts are positive, except adjustments and corrections (signed, never zero).
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_amount_check"
  CHECK (("kind" IN ('ADJUSTMENT', 'CORRECTION') AND "amount_piastres" <> 0) OR ("kind" NOT IN ('ADJUSTMENT', 'CORRECTION') AND "amount_piastres" > 0));

ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_opening_check" CHECK ("opening_piastres" >= 0);
