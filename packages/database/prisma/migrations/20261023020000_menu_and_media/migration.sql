-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('LOGO', 'COVER', 'ITEM');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "brand_color" CHAR(7),
ADD COLUMN     "cover_id" UUID,
ADD COLUMN     "logo_id" UUID,
ADD COLUMN     "menu_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "opening_hours" JSONB;

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "variant_widths" INTEGER[],
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name_ar" VARCHAR(80) NOT NULL,
    "name_en" VARCHAR(80),
    "sort_order" INTEGER NOT NULL,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "description_ar" VARCHAR(500),
    "description_en" VARCHAR(500),
    "image_id" UUID,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_variants" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name_ar" VARCHAR(40),
    "name_en" VARCHAR(40),
    "price_piastres" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "menu_item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_restaurant_id_idx" ON "media"("restaurant_id");

-- CreateIndex
CREATE INDEX "categories_restaurant_id_sort_order_idx" ON "categories"("restaurant_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_items_category_id_sort_order_idx" ON "menu_items"("category_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_items_restaurant_id_idx" ON "menu_items"("restaurant_id");

-- CreateIndex
CREATE INDEX "menu_item_variants_item_id_sort_order_idx" ON "menu_item_variants"("item_id", "sort_order");

-- AddForeignKey
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_logo_id_fkey" FOREIGN KEY ("logo_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_cover_id_fkey" FOREIGN KEY ("cover_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guards the application also enforces (prices up to EGP 100,000).
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_price_check"
  CHECK ("price_piastres" BETWEEN 0 AND 10000000);
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_brand_color_check"
  CHECK ("brand_color" IS NULL OR "brand_color" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "categories" ADD CONSTRAINT "categories_sort_order_check" CHECK ("sort_order" >= 0);
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_sort_order_check" CHECK ("sort_order" >= 0);
