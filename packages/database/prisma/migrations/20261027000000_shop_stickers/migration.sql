-- Stickers join stands in the shop; existing lines are stands.
ALTER TABLE "stand_order_lines" ADD COLUMN "product" VARCHAR(20) NOT NULL DEFAULT 'stand';
