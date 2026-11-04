-- CreateEnum
CREATE TYPE "table_area_theme" AS ENUM ('HALL', 'GARDEN', 'ROOFTOP', 'TERRACE', 'VIP', 'SMOKING');

-- AlterTable
ALTER TABLE "table_areas" ADD COLUMN "theme" "table_area_theme" NOT NULL DEFAULT 'HALL';

-- Existing areas: outdoor ones start as a terrace, then the name picks a closer look when it says what the area is.
UPDATE "table_areas" SET "theme" = 'TERRACE' WHERE "location" = 'OUTDOOR';
UPDATE "table_areas" SET "theme" = 'GARDEN' WHERE "name" ~* '(garden|جنين|حديق)';
UPDATE "table_areas" SET "theme" = 'ROOFTOP' WHERE "name" ~* '(roof|روف|سطح)';
UPDATE "table_areas" SET "theme" = 'VIP' WHERE "name" ~* 'vip';
UPDATE "table_areas" SET "theme" = 'SMOKING' WHERE "name" ~* '(smok|تدخين)';
