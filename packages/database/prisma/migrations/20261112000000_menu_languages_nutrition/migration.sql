-- Menus in more languages, and calories and portions per size.
--
-- Arabic and English stay in their own columns. Extra languages (contracts:
-- EXTRA_MENU_LANGUAGES) live in a `translations` JSON object per category,
-- dish and size, and each restaurant chooses which ones it offers. Nutrition
-- is optional per size: kcal, a portion (amount + unit) and how many it serves.

-- CreateEnum
CREATE TYPE "portion_unit" AS ENUM ('GRAM', 'ML', 'PIECE');

-- Languages offered by each restaurant, in display order.
ALTER TABLE "restaurants" ADD COLUMN "menu_languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_menu_languages_check"
    CHECK ("menu_languages" <@ ARRAY['fr', 'de', 'it', 'es', 'ru', 'zh', 'tr']::TEXT[]);

-- Translations.
ALTER TABLE "categories" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menu_items" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "menu_item_variants" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "categories" ADD CONSTRAINT "categories_translations_object" CHECK (jsonb_typeof("translations") = 'object');
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_translations_object" CHECK (jsonb_typeof("translations") = 'object');
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_translations_object" CHECK (jsonb_typeof("translations") = 'object');

-- Nutrition and portions per size.
ALTER TABLE "menu_item_variants" ADD COLUMN "calories" INTEGER,
    ADD COLUMN "portion_value" INTEGER,
    ADD COLUMN "portion_unit" "portion_unit",
    ADD COLUMN "serves" SMALLINT;
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_calories_check" CHECK ("calories" BETWEEN 0 AND 10000);
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_portion_value_check" CHECK ("portion_value" BETWEEN 1 AND 100000);
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_serves_check" CHECK ("serves" BETWEEN 1 AND 50);
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_portion_complete"
    CHECK (("portion_value" IS NULL) = ("portion_unit" IS NULL));
