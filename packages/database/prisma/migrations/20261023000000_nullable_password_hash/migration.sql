-- An unconfirmed account registered twice with different passwords keeps
-- neither; the inbox owner sets one through a reset link after confirming.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
