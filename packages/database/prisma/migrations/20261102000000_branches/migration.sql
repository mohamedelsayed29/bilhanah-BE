-- Multi-branch restaurants. The restaurant stays the brand (subdomain, shared
-- menu, subscription, branding); branches hold the location, opening hours and
-- ordering switches, and own tables, orders, order numbers and staff.
-- Every existing restaurant gets one main branch carrying its current settings.

-- A branch manager: runs one branch (or every branch when not tied to one).
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'MANAGER';

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "phone" VARCHAR(20) NOT NULL,
    "whatsapp_number" VARCHAR(20),
    "city" VARCHAR(60) NOT NULL,
    "address" VARCHAR(200) NOT NULL,
    "map_url" VARCHAR(2048),
    "opening_hours" JSONB,
    "ordering_enabled" BOOLEAN NOT NULL DEFAULT false,
    "accepts_dine_in" BOOLEAN NOT NULL DEFAULT true,
    "accepts_pickup" BOOLEAN NOT NULL DEFAULT true,
    "orders_paused" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branches_restaurant_id_slug_key" ON "branches"("restaurant_id", "slug");
CREATE INDEX "branches_restaurant_id_sort_order_idx" ON "branches"("restaurant_id", "sort_order");
ALTER TABLE "branches" ADD CONSTRAINT "branches_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one main branch per restaurant (the app keeps one; the index forbids two), and it stays active.
CREATE UNIQUE INDEX "branches_one_main_per_restaurant" ON "branches"("restaurant_id") WHERE "is_main";
ALTER TABLE "branches" ADD CONSTRAINT "branches_main_is_active" CHECK (NOT "is_main" OR "is_active");
ALTER TABLE "branches" ADD CONSTRAINT "branches_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- The main branch of every existing restaurant, with its current location, hours and ordering settings.
INSERT INTO "branches" (
    "id", "restaurant_id", "name", "slug", "is_main", "is_active", "phone", "whatsapp_number", "city", "address",
    "opening_hours", "ordering_enabled", "accepts_dine_in", "accepts_pickup", "orders_paused", "sort_order", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(), r."id",
    CASE WHEN r."default_language" = 'en' THEN 'Main branch' ELSE 'الفرع الرئيسي' END,
    'main', true, true, LEFT(r."phone", 20), LEFT(r."whatsapp_number", 20), LEFT(r."city", 60), LEFT(r."address", 200),
    r."opening_hours", r."ordering_enabled", r."accepts_dine_in", r."accepts_pickup", r."orders_paused", 0, r."created_at", CURRENT_TIMESTAMP
FROM "restaurants" r;

-- Tables belong to a branch; labels are unique per branch.
ALTER TABLE "tables" ADD COLUMN "branch_id" UUID;
UPDATE "tables" t SET "branch_id" = b."id" FROM "branches" b WHERE b."restaurant_id" = t."restaurant_id" AND b."is_main";
ALTER TABLE "tables" ALTER COLUMN "branch_id" SET NOT NULL;
DROP INDEX "tables_restaurant_id_label_key";
DROP INDEX "tables_restaurant_id_sort_order_idx";
CREATE UNIQUE INDEX "tables_branch_id_label_key" ON "tables"("branch_id", "label");
CREATE INDEX "tables_restaurant_id_idx" ON "tables"("restaurant_id");
CREATE INDEX "tables_branch_id_sort_order_idx" ON "tables"("branch_id", "sort_order");
ALTER TABLE "tables" ADD CONSTRAINT "tables_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Orders are received by a branch, and numbered per branch and day.
ALTER TABLE "orders" ADD COLUMN "branch_id" UUID;
UPDATE "orders" o SET "branch_id" = b."id" FROM "branches" b WHERE b."restaurant_id" = o."restaurant_id" AND b."is_main";
ALTER TABLE "orders" ALTER COLUMN "branch_id" SET NOT NULL;
DROP INDEX "orders_restaurant_id_business_day_number_key";
DROP INDEX "orders_restaurant_id_table_id_paid_at_idx";
CREATE UNIQUE INDEX "orders_branch_id_business_day_number_key" ON "orders"("branch_id", "business_day", "number");
CREATE INDEX "orders_branch_id_status_placed_at_idx" ON "orders"("branch_id", "status", "placed_at");
CREATE INDEX "orders_branch_id_table_id_paid_at_idx" ON "orders"("branch_id", "table_id", "paid_at");
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Order counters move from restaurants to branches.
ALTER TABLE "order_counters" ADD COLUMN "branch_id" UUID;
UPDATE "order_counters" c SET "branch_id" = b."id" FROM "branches" b WHERE b."restaurant_id" = c."restaurant_id" AND b."is_main";
ALTER TABLE "order_counters" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "order_counters" DROP CONSTRAINT "order_counters_pkey";
ALTER TABLE "order_counters" DROP CONSTRAINT "order_counters_restaurant_id_fkey";
ALTER TABLE "order_counters" DROP COLUMN "restaurant_id";
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_pkey" PRIMARY KEY ("branch_id", "business_day");
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Staff may be tied to one branch; existing kitchen accounts keep seeing every branch.
ALTER TABLE "users" ADD COLUMN "staff_branch_id" UUID;
CREATE INDEX "users_staff_branch_id_idx" ON "users"("staff_branch_id");
ALTER TABLE "users" ADD CONSTRAINT "users_staff_branch_id_fkey" FOREIGN KEY ("staff_branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Branch menu overrides.
CREATE TABLE "branch_menu_items" (
    "branch_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "is_available" BOOLEAN,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_menu_items_pkey" PRIMARY KEY ("branch_id", "item_id")
);
CREATE INDEX "branch_menu_items_item_id_idx" ON "branch_menu_items"("item_id");
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "branch_variant_prices" (
    "branch_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "price_piastres" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_variant_prices_pkey" PRIMARY KEY ("branch_id", "variant_id"),
    CONSTRAINT "branch_variant_prices_price_check" CHECK ("price_piastres" >= 0)
);
CREATE INDEX "branch_variant_prices_variant_id_idx" ON "branch_variant_prices"("variant_id");
ALTER TABLE "branch_variant_prices" ADD CONSTRAINT "branch_variant_prices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_variant_prices" ADD CONSTRAINT "branch_variant_prices_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The settings now live on branches.
ALTER TABLE "restaurants" DROP COLUMN "opening_hours",
    DROP COLUMN "ordering_enabled",
    DROP COLUMN "accepts_dine_in",
    DROP COLUMN "accepts_pickup",
    DROP COLUMN "orders_paused";
