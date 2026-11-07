-- CreateEnum
CREATE TYPE "LoyaltyEarnOn" AS ENUM ('COMPLETED', 'PAID');

-- CreateEnum
CREATE TYPE "LoyaltyRewardType" AS ENUM ('FIXED_DISCOUNT', 'PERCENT_DISCOUNT', 'FREE_PRODUCT', 'FREE_ADDON');

-- CreateEnum
CREATE TYPE "LoyaltyTransactionKind" AS ENUM ('EARN', 'EARN_REVERSAL', 'REDEEM', 'REDEEM_RETURN', 'EXPIRE', 'ADJUST');

-- AlterEnum
ALTER TYPE "RestaurantServiceKey" ADD VALUE 'LOYALTY';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discount_piastres" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyalty_earned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "loyalty_member_id" UUID,
ADD COLUMN     "loyalty_points_spent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyalty_points_to_earn" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyalty_reward_id" UUID,
ADD COLUMN     "loyalty_reward_name" VARCHAR(80),
ADD COLUMN     "loyalty_spent_held" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refunded_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "loyalty_settings" (
    "restaurant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name_ar" VARCHAR(40),
    "name_en" VARCHAR(40),
    "points_per_unit" INTEGER NOT NULL DEFAULT 1,
    "spend_unit_piastres" INTEGER NOT NULL DEFAULT 1000,
    "earn_on" "LoyaltyEarnOn" NOT NULL DEFAULT 'COMPLETED',
    "order_types" "order_type"[] DEFAULT ARRAY['DINE_IN', 'PICKUP']::"order_type"[],
    "min_order_piastres" INTEGER NOT NULL DEFAULT 0,
    "min_redeem_points" INTEGER NOT NULL DEFAULT 0,
    "max_discount_percent" INTEGER NOT NULL DEFAULT 100,
    "expiry_days" INTEGER,
    "cancel_returns_redeemed" BOOLEAN NOT NULL DEFAULT true,
    "refund_reverses_earned" BOOLEAN NOT NULL DEFAULT true,
    "refund_returns_redeemed" BOOLEAN NOT NULL DEFAULT true,
    "tiers_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("restaurant_id")
);

-- CreateTable
CREATE TABLE "loyalty_tiers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name_ar" VARCHAR(30) NOT NULL,
    "name_en" VARCHAR(30),
    "min_lifetime_points" INTEGER NOT NULL,
    "earn_multiplier" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_rewards" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "type" "LoyaltyRewardType" NOT NULL,
    "name_ar" VARCHAR(80) NOT NULL,
    "name_en" VARCHAR(80),
    "points_cost" INTEGER NOT NULL,
    "amount_piastres" INTEGER,
    "percent" INTEGER,
    "max_discount_piastres" INTEGER,
    "menu_item_id" UUID,
    "variant_id" UUID,
    "min_order_piastres" INTEGER NOT NULL DEFAULT 0,
    "max_per_member" INTEGER,
    "tier_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_members" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "pass_version" INTEGER NOT NULL DEFAULT 1,
    "join_order_id" UUID,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "LoyaltyTransactionKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "order_id" UUID,
    "reward_id" UUID,
    "reason" VARCHAR(200) NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_tiers_restaurant_id_min_lifetime_points_key" ON "loyalty_tiers"("restaurant_id", "min_lifetime_points");

-- CreateIndex
CREATE INDEX "loyalty_rewards_restaurant_id_sort_order_idx" ON "loyalty_rewards"("restaurant_id", "sort_order");

-- CreateIndex
CREATE INDEX "loyalty_members_restaurant_id_created_at_idx" ON "loyalty_members"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_members_restaurant_id_last_activity_at_idx" ON "loyalty_members"("restaurant_id", "last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_members_restaurant_id_phone_key" ON "loyalty_members"("restaurant_id", "phone");

-- CreateIndex
CREATE INDEX "loyalty_transactions_member_id_created_at_idx" ON "loyalty_transactions"("member_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_transactions_restaurant_id_created_at_idx" ON "loyalty_transactions"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_transactions_order_id_idx" ON "loyalty_transactions"("order_id");

-- CreateIndex
CREATE INDEX "orders_loyalty_member_id_placed_at_idx" ON "orders"("loyalty_member_id", "placed_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_loyalty_member_id_fkey" FOREIGN KEY ("loyalty_member_id") REFERENCES "loyalty_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_loyalty_reward_id_fkey" FOREIGN KEY ("loyalty_reward_id") REFERENCES "loyalty_rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "loyalty_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "loyalty_rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Checks the application relies on.
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_check" CHECK ("discount_piastres" >= 0 AND "discount_piastres" <= "subtotal_piastres");
ALTER TABLE "orders" ADD CONSTRAINT "orders_loyalty_points_check" CHECK ("loyalty_points_spent" >= 0 AND "loyalty_points_to_earn" >= 0);
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_rules_check" CHECK (
  "points_per_unit" BETWEEN 1 AND 1000 AND "spend_unit_piastres" BETWEEN 100 AND 10000000
  AND "min_order_piastres" >= 0 AND "min_redeem_points" >= 0
  AND "max_discount_percent" BETWEEN 1 AND 100 AND ("expiry_days" IS NULL OR "expiry_days" BETWEEN 7 AND 3650)
);
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_rules_check" CHECK ("min_lifetime_points" >= 0 AND "earn_multiplier" BETWEEN 100 AND 500);
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_value_check" CHECK (
  "points_cost" > 0 AND "min_order_piastres" >= 0 AND ("max_per_member" IS NULL OR "max_per_member" > 0) AND (
    ("type" = 'FIXED_DISCOUNT' AND "amount_piastres" > 0)
    OR ("type" = 'PERCENT_DISCOUNT' AND "percent" BETWEEN 1 AND 100)
    OR ("type" IN ('FREE_PRODUCT', 'FREE_ADDON'))
  )
);
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_points_check" CHECK ("points" <> 0);
