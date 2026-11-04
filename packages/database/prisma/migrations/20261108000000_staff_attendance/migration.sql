-- CreateEnum
CREATE TYPE "attendance_method" AS ENUM ('PORTAL', 'QR', 'KIOSK', 'FINGERPRINT', 'MANUAL');

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'INCOMPLETE', 'EARLY_LEAVE', 'OVERTIME', 'PENDING_CORRECTION');

-- CreateEnum
CREATE TYPE "attendance_event_type" AS ENUM ('CHECK_IN', 'CHECK_OUT');

-- CreateEnum
CREATE TYPE "attendance_qr_mode" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "attendance_location_mode" AS ENUM ('OFF', 'FLAG', 'REJECT');

-- CreateEnum
CREATE TYPE "correction_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_number" VARCHAR(12) NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "job_title" VARCHAR(60),
    "phone" VARCHAR(20),
    "user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "hire_date" DATE,
    "pin_hash" TEXT,
    "pin_must_change" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID,
    "methods" "attendance_method"[] DEFAULT ARRAY['PORTAL']::"attendance_method"[],
    "primary_method" "attendance_method" NOT NULL DEFAULT 'PORTAL',
    "grace_minutes" SMALLINT NOT NULL DEFAULT 10,
    "early_check_in_minutes" SMALLINT NOT NULL DEFAULT 30,
    "late_check_out_minutes" SMALLINT NOT NULL DEFAULT 60,
    "record_overtime" BOOLEAN NOT NULL DEFAULT true,
    "allow_without_shift" BOOLEAN NOT NULL DEFAULT false,
    "allow_outside_shift" BOOLEAN NOT NULL DEFAULT false,
    "allow_multiple_shifts" BOOLEAN NOT NULL DEFAULT false,
    "require_check_out" BOOLEAN NOT NULL DEFAULT true,
    "corrections_enabled" BOOLEAN NOT NULL DEFAULT true,
    "manual_needs_approval" BOOLEAN NOT NULL DEFAULT false,
    "qr_mode" "attendance_qr_mode" NOT NULL DEFAULT 'DYNAMIC',
    "qr_ttl_seconds" SMALLINT NOT NULL DEFAULT 30,
    "qr_static_code" VARCHAR(32),
    "qr_secret" VARCHAR(64),
    "qr_enabled" BOOLEAN NOT NULL DEFAULT true,
    "location_mode" "attendance_location_mode" NOT NULL DEFAULT 'OFF',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radius_meters" INTEGER,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "is_leave" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID,
    "day" DATE NOT NULL,
    "check_in_at" TIMESTAMPTZ(3) NOT NULL,
    "check_out_at" TIMESTAMPTZ(3),
    "status" "attendance_status" NOT NULL DEFAULT 'PRESENT',
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "check_in_method" "attendance_method" NOT NULL,
    "check_out_method" "attendance_method",
    "kiosk_id" UUID,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "manager_note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "type" "attendance_event_type" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "method" "attendance_method" NOT NULL,
    "kiosk_id" UUID,
    "idempotency_key" VARCHAR(64),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_kiosks" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "activation_code_hash" VARCHAR(64),
    "activation_expires_at" TIMESTAMPTZ(3),
    "token_hash" VARCHAR(64),
    "activated_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_kiosks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "record_id" UUID,
    "day" DATE NOT NULL,
    "requested_check_in" TIMESTAMPTZ(3),
    "requested_check_out" TIMESTAMPTZ(3),
    "reason" VARCHAR(300) NOT NULL,
    "status" "correction_status" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_branch_id_idx" ON "employees"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_restaurant_id_employee_number_key" ON "employees"("restaurant_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_branch_id_key" ON "attendance_policies"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_qr_static_code_key" ON "attendance_policies"("qr_static_code");

-- CreateIndex
CREATE INDEX "attendance_policies_restaurant_id_idx" ON "attendance_policies"("restaurant_id");

-- CreateIndex
CREATE INDEX "shifts_restaurant_id_day_idx" ON "shifts"("restaurant_id", "day");

-- CreateIndex
CREATE INDEX "shifts_employee_id_day_idx" ON "shifts"("employee_id", "day");

-- CreateIndex
CREATE INDEX "attendance_records_restaurant_id_day_idx" ON "attendance_records"("restaurant_id", "day");

-- CreateIndex
CREATE INDEX "attendance_records_employee_id_day_idx" ON "attendance_records"("employee_id", "day");

-- CreateIndex
CREATE INDEX "attendance_events_record_id_idx" ON "attendance_events"("record_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_restaurant_id_idempotency_key_key" ON "attendance_events"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_kiosks_token_hash_key" ON "attendance_kiosks"("token_hash");

-- CreateIndex
CREATE INDEX "attendance_kiosks_restaurant_id_idx" ON "attendance_kiosks"("restaurant_id");

-- CreateIndex
CREATE INDEX "attendance_corrections_restaurant_id_status_idx" ON "attendance_corrections"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "attendance_corrections_employee_id_idx" ON "attendance_corrections"("employee_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_kiosk_id_fkey" FOREIGN KEY ("kiosk_id") REFERENCES "attendance_kiosks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_kiosks" ADD CONSTRAINT "attendance_kiosks_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_kiosks" ADD CONSTRAINT "attendance_kiosks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
