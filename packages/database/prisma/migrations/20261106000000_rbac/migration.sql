-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "user_role" ADD VALUE 'CASHIER';
ALTER TYPE "user_role" ADD VALUE 'WAITER';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "restaurant_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "permission_grants" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "audit_logs_restaurant_id_created_at_idx" ON "audit_logs"("restaurant_id", "created_at");
