-- CreateEnum
CREATE TYPE "table_location" AS ENUM ('INDOOR', 'OUTDOOR');

-- AlterTable: every existing table counts as indoor until the owner says otherwise.
ALTER TABLE "tables" ADD COLUMN "location" "table_location" NOT NULL DEFAULT 'INDOOR';
