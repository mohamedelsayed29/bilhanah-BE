-- Web Push subscriptions for order-ready alerts (one row per order and browser).
-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "p256dh" VARCHAR(100) NOT NULL,
    "auth" VARCHAR(32) NOT NULL,
    "language" "language" NOT NULL DEFAULT 'ar',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_subscriptions_created_at_idx" ON "push_subscriptions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_order_id_endpoint_key" ON "push_subscriptions"("order_id", "endpoint");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

