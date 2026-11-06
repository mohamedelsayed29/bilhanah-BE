-- Purchase and waste lines keep the English name of the unit they were entered in, next to the
-- Arabic one (unit_name), so the dashboard can show either language (docs/INVENTORY.md).

-- AlterTable
ALTER TABLE "inventory_purchase_lines" ADD COLUMN     "unit_name_en" VARCHAR(40);

-- AlterTable
ALTER TABLE "inventory_waste_lines" ADD COLUMN     "unit_name_en" VARCHAR(40);

-- Existing lines: the unit's current English name, where the unit still exists under the same
-- Arabic name (units are matched by their Arabic name, so that is the unit the line used).
UPDATE "inventory_purchase_lines" AS line
SET "unit_name_en" = unit."name_en"
FROM "ingredient_units" AS unit
WHERE line."unit_id" = unit."id" AND line."unit_name" = unit."name_ar";

UPDATE "inventory_waste_lines" AS line
SET "unit_name_en" = unit."name_en"
FROM "ingredient_units" AS unit
WHERE line."ingredient_id" = unit."ingredient_id" AND line."unit_name" = unit."name_ar";
