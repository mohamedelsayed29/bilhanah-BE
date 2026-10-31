-- CreateEnum
CREATE TYPE "table_shape" AS ENUM ('ROUND', 'SQUARE', 'RECTANGLE');

-- AlterTable
ALTER TABLE "tables" ADD COLUMN "shape" "table_shape" NOT NULL DEFAULT 'SQUARE',
ADD COLUMN "seats" SMALLINT NOT NULL DEFAULT 4;
