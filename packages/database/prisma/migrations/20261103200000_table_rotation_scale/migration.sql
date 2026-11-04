-- AlterTable: how each table is turned and sized on the floor plan; existing tables stay upright at their natural size.
ALTER TABLE "tables" ADD COLUMN "floor_rotation" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN "floor_scale" REAL NOT NULL DEFAULT 1;
