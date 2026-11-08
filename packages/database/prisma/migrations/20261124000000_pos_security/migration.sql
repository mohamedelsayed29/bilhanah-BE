-- POS security: device cap per restaurant, pausable devices, one-time pairing codes, and cashier PINs.
-- AlterEnum
ALTER TYPE "PosDeviceStatus" ADD VALUE 'DISABLED';

-- AlterTable
ALTER TABLE "pos_accounts" ADD COLUMN     "max_devices" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "pos_devices" ADD COLUMN     "pairing_code_hash" VARCHAR(64),
ADD COLUMN     "pairing_expires_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pos_pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pos_pin_hash" TEXT,
ADD COLUMN     "pos_pin_locked_until" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "pos_devices_pairing_code_hash_key" ON "pos_devices"("pairing_code_hash");


-- Sane bounds.
ALTER TABLE "pos_accounts" ADD CONSTRAINT "pos_accounts_max_devices_check" CHECK ("max_devices" BETWEEN 1 AND 100);
ALTER TABLE "users" ADD CONSTRAINT "users_pos_pin_failed_attempts_check" CHECK ("pos_pin_failed_attempts" >= 0);
