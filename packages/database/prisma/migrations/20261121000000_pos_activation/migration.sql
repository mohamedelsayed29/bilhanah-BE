-- CreateEnum
CREATE TYPE "PosAccess" AS ENUM ('ENABLED', 'DISABLED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PosMode" AS ENUM ('BILHANAH', 'EXTERNAL', 'BOTH');

-- CreateTable
CREATE TABLE "pos_platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "plans" "plan_code"[] DEFAULT ARRAY['ORDERS', 'ADVANCED']::"plan_code"[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_accounts" (
    "restaurant_id" UUID NOT NULL,
    "access" "PosAccess" NOT NULL DEFAULT 'ENABLED',
    "access_reason" VARCHAR(300),
    "allowed_modes" "PosMode"[] DEFAULT ARRAY['BILHANAH', 'EXTERNAL']::"PosMode"[],
    "mode" "PosMode",
    "activated_at" TIMESTAMPTZ(3),
    "setup_completed_at" TIMESTAMPTZ(3),
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "tax_inclusive" BOOLEAN NOT NULL DEFAULT true,
    "service_charge_bps" INTEGER NOT NULL DEFAULT 0,
    "service_charge_dine_in_only" BOOLEAN NOT NULL DEFAULT true,
    "payment_methods" "order_payment_method"[] DEFAULT ARRAY['CASH', 'CARD']::"order_payment_method"[],
    "cashier_max_discount_percent" INTEGER NOT NULL DEFAULT 0,
    "require_open_shift" BOOLEAN NOT NULL DEFAULT true,
    "receipt_header" VARCHAR(200),
    "receipt_footer" VARCHAR(300),
    "receipt_show_logo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_accounts_pkey" PRIMARY KEY ("restaurant_id")
);

-- AddForeignKey
ALTER TABLE "pos_accounts" ADD CONSTRAINT "pos_accounts_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


INSERT INTO "pos_platform_settings" ("id", "updated_at") VALUES (1, now()) ON CONFLICT DO NOTHING;
ALTER TABLE "pos_platform_settings" ADD CONSTRAINT "pos_platform_settings_single" CHECK ("id" = 1);
ALTER TABLE "pos_accounts" ADD CONSTRAINT "pos_accounts_rules_check" CHECK (
  "tax_rate_bps" BETWEEN 0 AND 5000 AND "service_charge_bps" BETWEEN 0 AND 5000
  AND "cashier_max_discount_percent" BETWEEN 0 AND 100 AND cardinality("allowed_modes") > 0
);
