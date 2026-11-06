-- Feedback and reviews (docs/REVIEWS.md).
--
-- Per-restaurant review settings, diners' reviews (verified: one per order, proven by its tracking
-- link; or unverified feedback from a table QR or the menu), per-dish ratings of the order's own
-- lines, review photos (media kind REVIEW, private until published), and each review's history
-- (edits with the rating before, moderation, replies, follow-ups). Branches get a Google review link.
-- The new media kind is not used in this migration (a new enum value cannot be used in the
-- transaction that adds it).

-- CreateEnum
CREATE TYPE "review_ask_after" AS ENUM ('READY', 'COMPLETED');

-- CreateEnum
CREATE TYPE "review_dish_scale" AS ENUM ('THUMBS', 'STARS');

-- CreateEnum
CREATE TYPE "review_publish_mode" AS ENUM ('AUTO', 'MANUAL', 'NEVER');

-- CreateEnum
CREATE TYPE "review_display_name" AS ENUM ('FIRST_NAME_INITIAL', 'FIRST_NAME', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('PENDING', 'PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "review_source" AS ENUM ('ORDER', 'TABLE', 'MENU');

-- CreateEnum
CREATE TYPE "review_follow_up_status" AS ENUM ('OPEN', 'CONTACTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "review_event_kind" AS ENUM ('CREATED', 'EDITED', 'PUBLISHED', 'HIDDEN', 'REPLIED', 'REPLY_REMOVED', 'FOLLOW_UP');

-- AlterEnum
ALTER TYPE "media_kind" ADD VALUE 'REVIEW';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "google_review_url" VARCHAR(2048);

-- CreateTable
CREATE TABLE "review_settings" (
    "restaurant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ask_after" "review_ask_after" NOT NULL DEFAULT 'COMPLETED',
    "allow_unverified" BOOLEAN NOT NULL DEFAULT false,
    "sub_ratings" TEXT[] DEFAULT ARRAY['food', 'service']::TEXT[],
    "dish_ratings" BOOLEAN NOT NULL DEFAULT true,
    "dish_rating_scale" "review_dish_scale" NOT NULL DEFAULT 'THUMBS',
    "comment_required_below" SMALLINT NOT NULL DEFAULT 3,
    "photos" BOOLEAN NOT NULL DEFAULT true,
    "tags" JSONB,
    "publish_mode" "review_publish_mode" NOT NULL DEFAULT 'AUTO',
    "publish_min_stars" SMALLINT NOT NULL DEFAULT 1,
    "show_on_menu" BOOLEAN NOT NULL DEFAULT false,
    "menu_min_count" INTEGER NOT NULL DEFAULT 3,
    "google_prompt" BOOLEAN NOT NULL DEFAULT true,
    "google_min_stars" SMALLINT NOT NULL DEFAULT 4,
    "alert_below_stars" SMALLINT NOT NULL DEFAULT 3,
    "edit_window_hours" INTEGER NOT NULL DEFAULT 24,
    "display_name" "review_display_name" NOT NULL DEFAULT 'FIRST_NAME_INITIAL',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "review_settings_pkey" PRIMARY KEY ("restaurant_id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID,
    "source" "review_source" NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "table_label" VARCHAR(40),
    "overall" SMALLINT NOT NULL,
    "food_rating" SMALLINT,
    "service_rating" SMALLINT,
    "value_rating" SMALLINT,
    "speed_rating" SMALLINT,
    "cleanliness_rating" SMALLINT,
    "atmosphere_rating" SMALLINT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comment" VARCHAR(1000),
    "author_name" VARCHAR(40),
    "contact_phone" VARCHAR(20),
    "contact_consent" BOOLEAN NOT NULL DEFAULT false,
    "language" "language" NOT NULL DEFAULT 'ar',
    "edit_key_hash" CHAR(64),
    "editable_until" TIMESTAMPTZ(3) NOT NULL,
    "edit_count" INTEGER NOT NULL DEFAULT 0,
    "status" "review_status" NOT NULL DEFAULT 'PENDING',
    "published_at" TIMESTAMPTZ(3),
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_reason" VARCHAR(300),
    "moderated_by_id" UUID,
    "moderated_at" TIMESTAMPTZ(3),
    "reply_text" VARCHAR(1000),
    "replied_at" TIMESTAMPTZ(3),
    "reply_updated_at" TIMESTAMPTZ(3),
    "replied_by_id" UUID,
    "follow_up_status" "review_follow_up_status",
    "follow_up_assignee_id" UUID,
    "follow_up_updated_at" TIMESTAMPTZ(3),
    "alerted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_dish_ratings" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "order_item_id" UUID,
    "menu_item_id" UUID,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "rating" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_dish_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_photos" (
    "review_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "sort_order" SMALLINT NOT NULL,

    CONSTRAINT "review_photos_pkey" PRIMARY KEY ("review_id","media_id")
);

-- CreateTable
CREATE TABLE "review_events" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "kind" "review_event_kind" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(100),
    "follow_up_status" "review_follow_up_status",
    "assignee_id" UUID,
    "assignee_name" VARCHAR(100),
    "note" VARCHAR(500),
    "previous_overall" SMALLINT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_key" ON "reviews"("order_id");

-- CreateIndex
CREATE INDEX "reviews_restaurant_id_created_at_idx" ON "reviews"("restaurant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_branch_id_created_at_idx" ON "reviews"("branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_restaurant_id_status_published_at_idx" ON "reviews"("restaurant_id", "status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_restaurant_id_overall_idx" ON "reviews"("restaurant_id", "overall");

-- CreateIndex
CREATE INDEX "reviews_follow_up_assignee_id_idx" ON "reviews"("follow_up_assignee_id");

-- CreateIndex
CREATE INDEX "review_dish_ratings_menu_item_id_idx" ON "review_dish_ratings"("menu_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_dish_ratings_review_id_order_item_id_key" ON "review_dish_ratings"("review_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_photos_media_id_key" ON "review_photos"("media_id");

-- CreateIndex
CREATE INDEX "review_events_review_id_created_at_idx" ON "review_events"("review_id", "created_at");

-- AddForeignKey
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_id_fkey" FOREIGN KEY ("moderated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_id_fkey" FOREIGN KEY ("replied_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_follow_up_assignee_id_fkey" FOREIGN KEY ("follow_up_assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dish_ratings" ADD CONSTRAINT "review_dish_ratings_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dish_ratings" ADD CONSTRAINT "review_dish_ratings_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dish_ratings" ADD CONSTRAINT "review_dish_ratings_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_photos" ADD CONSTRAINT "review_photos_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_photos" ADD CONSTRAINT "review_photos_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity: ratings are integers 1–5, settings stay in range, texts are bounded (VARCHAR) and not blank.
ALTER TABLE "review_settings"
  ADD CONSTRAINT "review_settings_sub_ratings_check" CHECK ("sub_ratings" IS NOT NULL AND "sub_ratings" <@ ARRAY['food', 'service', 'value', 'speed', 'cleanliness', 'atmosphere']::TEXT[]),
  ADD CONSTRAINT "review_settings_comment_required_below_check" CHECK ("comment_required_below" BETWEEN 0 AND 5),
  ADD CONSTRAINT "review_settings_publish_min_stars_check" CHECK ("publish_min_stars" BETWEEN 1 AND 5),
  ADD CONSTRAINT "review_settings_google_min_stars_check" CHECK ("google_min_stars" BETWEEN 1 AND 5),
  ADD CONSTRAINT "review_settings_alert_below_stars_check" CHECK ("alert_below_stars" BETWEEN 0 AND 5),
  ADD CONSTRAINT "review_settings_menu_min_count_check" CHECK ("menu_min_count" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "review_settings_edit_window_hours_check" CHECK ("edit_window_hours" BETWEEN 0 AND 720),
  ADD CONSTRAINT "review_settings_tags_array" CHECK ("tags" IS NULL OR (jsonb_typeof("tags") = 'array' AND jsonb_array_length("tags") <= 20));

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_overall_check" CHECK ("overall" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_food_rating_check" CHECK ("food_rating" IS NULL OR "food_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_service_rating_check" CHECK ("service_rating" IS NULL OR "service_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_value_rating_check" CHECK ("value_rating" IS NULL OR "value_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_speed_rating_check" CHECK ("speed_rating" IS NULL OR "speed_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_cleanliness_rating_check" CHECK ("cleanliness_rating" IS NULL OR "cleanliness_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_atmosphere_rating_check" CHECK ("atmosphere_rating" IS NULL OR "atmosphere_rating" BETWEEN 1 AND 5),
  -- Verified means proven by an order (the order may be deleted later; the review keeps the mark).
  ADD CONSTRAINT "reviews_verified_check" CHECK ("verified" = ("source" = 'ORDER')),
  ADD CONSTRAINT "reviews_tags_check" CHECK ("tags" IS NULL OR cardinality("tags") <= 10),
  ADD CONSTRAINT "reviews_comment_check" CHECK ("comment" IS NULL OR char_length(btrim("comment")) > 0),
  ADD CONSTRAINT "reviews_author_name_check" CHECK ("author_name" IS NULL OR char_length(btrim("author_name")) > 0),
  -- A phone number is kept only with the diner's consent.
  ADD CONSTRAINT "reviews_contact_check" CHECK ("contact_phone" IS NULL OR "contact_consent"),
  ADD CONSTRAINT "reviews_edit_count_check" CHECK ("edit_count" >= 0),
  ADD CONSTRAINT "reviews_published_check" CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL),
  -- Hiding needs a reason (kept, and audited).
  ADD CONSTRAINT "reviews_hidden_check" CHECK ("status" <> 'HIDDEN' OR ("hidden_reason" IS NOT NULL AND "hidden_at" IS NOT NULL)),
  ADD CONSTRAINT "reviews_reply_check" CHECK (("reply_text" IS NULL) = ("replied_at" IS NULL) AND ("reply_text" IS NULL OR char_length(btrim("reply_text")) > 0));

ALTER TABLE "review_dish_ratings" ADD CONSTRAINT "review_dish_ratings_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "review_photos" ADD CONSTRAINT "review_photos_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 2);

-- Follow-ups still to do, for the inbox filter and the stats.
CREATE INDEX "reviews_follow_up_idx" ON "reviews"("restaurant_id", "follow_up_status") WHERE "follow_up_status" IS NOT NULL;
