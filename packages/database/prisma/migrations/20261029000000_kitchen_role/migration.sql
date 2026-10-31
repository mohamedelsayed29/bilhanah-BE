-- Kitchen accounts: created by a restaurant's owner, they only see and move its orders.
ALTER TYPE "user_role" ADD VALUE 'KITCHEN';

ALTER TABLE "users" ADD COLUMN "staff_restaurant_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_staff_restaurant_id_fkey" FOREIGN KEY ("staff_restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "users_staff_restaurant_id_idx" ON "users"("staff_restaurant_id");
