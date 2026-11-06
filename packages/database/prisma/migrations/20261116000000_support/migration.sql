-- CreateEnum
CREATE TYPE "support_topic" AS ENUM ('GETTING_STARTED', 'RESTAURANT_SETUP', 'MENU', 'QR_TABLES', 'ORDERS', 'PAYMENTS', 'BRANCHES', 'BILLING', 'ACCOUNT', 'TROUBLESHOOTING');

-- CreateEnum
CREATE TYPE "faq_status" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "faq_interaction_kind" AS ENUM ('VIEW', 'SEARCH', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "assistant_message_role" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "support_ticket_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "support_ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "support_message_side" AS ENUM ('CUSTOMER', 'AGENT');

-- CreateEnum
CREATE TYPE "support_activity_kind" AS ENUM ('CREATED', 'STATUS', 'PRIORITY', 'ASSIGNED', 'REPLIED', 'NOTE', 'REOPENED');

-- CreateEnum
CREATE TYPE "support_notification_kind" AS ENUM ('TICKET_CREATED', 'CUSTOMER_REPLIED', 'TICKET_ASSIGNED', 'NEEDS_ATTENTION', 'AGENT_REPLIED', 'STATUS_CHANGED', 'TICKET_RESOLVED');

-- CreateTable
CREATE TABLE "faq_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "topic" "support_topic" NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'question',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faq_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_articles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "language" "language" NOT NULL,
    "category_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "related_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggested" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "faq_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faq_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_revisions" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "faq_status" NOT NULL,
    "editor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_interactions" (
    "id" UUID NOT NULL,
    "kind" "faq_interaction_kind" NOT NULL,
    "article_id" UUID,
    "restaurant_id" UUID,
    "user_id" UUID,
    "session_id" UUID,
    "helpful" BOOLEAN,
    "query" TEXT,
    "result_count" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "language" "language" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "assistant_message_role" NOT NULL,
    "provider" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "topic" "support_topic" NOT NULL,
    "priority" "support_ticket_priority" NOT NULL DEFAULT 'NORMAL',
    "status" "support_ticket_status" NOT NULL DEFAULT 'OPEN',
    "module" TEXT,
    "faq_article_id" UUID,
    "assistant_session_id" UUID,
    "assignee_id" UUID,
    "first_response_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customer_seen_at" TIMESTAMPTZ(3),
    "agent_seen_at" TIMESTAMPTZ(3),
    "last_customer_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_agent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID,
    "side" "support_message_side" NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" UUID NOT NULL,
    "uploader_id" UUID,
    "restaurant_id" UUID,
    "ticket_id" UUID,
    "message_id" UUID,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_assignments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "assignee_id" UUID,
    "assigned_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_activity" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "actor_id" UUID,
    "kind" "support_activity_kind" NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "restaurant_id" UUID,
    "ticket_id" UUID NOT NULL,
    "kind" "support_notification_kind" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "faq_categories_slug_key" ON "faq_categories"("slug");

-- CreateIndex
CREATE INDEX "faq_articles_language_status_category_id_sort_order_idx" ON "faq_articles"("language", "status", "category_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "faq_articles_key_language_key" ON "faq_articles"("key", "language");

-- CreateIndex
CREATE UNIQUE INDEX "faq_revisions_article_id_version_key" ON "faq_revisions"("article_id", "version");

-- CreateIndex
CREATE INDEX "faq_interactions_article_id_kind_idx" ON "faq_interactions"("article_id", "kind");

-- CreateIndex
CREATE INDEX "faq_interactions_restaurant_id_created_at_idx" ON "faq_interactions"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_sessions_user_id_updated_at_idx" ON "assistant_sessions"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "assistant_messages_session_id_created_at_idx" ON "assistant_messages"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_number_key" ON "support_tickets"("number");

-- CreateIndex
CREATE INDEX "support_tickets_restaurant_id_last_activity_at_idx" ON "support_tickets"("restaurant_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_last_activity_at_idx" ON "support_tickets"("status", "last_activity_at");

-- CreateIndex
CREATE INDEX "support_tickets_assignee_id_status_idx" ON "support_tickets"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "support_attachments_ticket_id_idx" ON "support_attachments"("ticket_id");

-- CreateIndex
CREATE INDEX "support_attachments_uploader_id_created_at_idx" ON "support_attachments"("uploader_id", "created_at");

-- CreateIndex
CREATE INDEX "support_assignments_ticket_id_created_at_idx" ON "support_assignments"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "support_ticket_activity_ticket_id_created_at_idx" ON "support_ticket_activity"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "support_notifications_recipient_id_read_at_updated_at_idx" ON "support_notifications"("recipient_id", "read_at", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_notifications_recipient_id_ticket_id_kind_key" ON "support_notifications"("recipient_id", "ticket_id", "kind");

-- AddForeignKey
ALTER TABLE "faq_articles" ADD CONSTRAINT "faq_articles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "faq_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_revisions" ADD CONSTRAINT "faq_revisions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "faq_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_revisions" ADD CONSTRAINT "faq_revisions_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_interactions" ADD CONSTRAINT "faq_interactions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "faq_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_interactions" ADD CONSTRAINT "faq_interactions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_interactions" ADD CONSTRAINT "faq_interactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_sessions" ADD CONSTRAINT "assistant_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_sessions" ADD CONSTRAINT "assistant_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assistant_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_faq_article_id_fkey" FOREIGN KEY ("faq_article_id") REFERENCES "faq_articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assistant_session_id_fkey" FOREIGN KEY ("assistant_session_id") REFERENCES "assistant_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_assignments" ADD CONSTRAINT "support_assignments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_assignments" ADD CONSTRAINT "support_assignments_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_assignments" ADD CONSTRAINT "support_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_activity" ADD CONSTRAINT "support_ticket_activity_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_activity" ADD CONSTRAINT "support_ticket_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_notifications" ADD CONSTRAINT "support_notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_notifications" ADD CONSTRAINT "support_notifications_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Sequence: ticket references start at BIL-10001.
ALTER SEQUENCE "support_tickets_number_seq" RESTART WITH 10001;

-- Starting FAQ content (editable by Bilhanah admins).
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'getting-started','GETTING_STARTED','البداية','Getting started','rocket',0,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'restaurant-setup','RESTAURANT_SETUP','إعداد المطعم','Restaurant setup','storefront',10,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'menu','MENU','إدارة المنيو','Menu management','fork-knife',20,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'qr-tables','QR_TABLES','أكواد QR والطاولات','QR codes & tables','qr-code',30,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'orders','ORDERS','إدارة الطلبات','Orders management','receipt',40,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'payments','PAYMENTS','المدفوعات','Payments','coins',50,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'branches','BRANCHES','الفروع','Branch management','buildings',60,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'billing','BILLING','الاشتراك والفواتير','Subscription & billing','credit-card',70,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'account','ACCOUNT','الحساب والصلاحيات','Account & permissions','user-gear',80,now());
INSERT INTO "faq_categories" ("id","slug","topic","name_ar","name_en","icon","sort_order","updated_at") VALUES (gen_random_uuid(),'troubleshooting','TROUBLESHOOTING','حل المشاكل','Troubleshooting','wrench',90,now());
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'first-steps','ar',"id",'أبدأ منين على بالهنا؟','أول ما تدخل لوحة التحكم:

1. كمّل **بيانات المطعم** واللوجو من [الإعدادات](/settings).
2. ضيف أقسام وأصناف المنيو من [المنيو](/menu).
3. ضيف طاولاتك واطبع أكوادها من [الطاولات](/tables).
4. شغّل الطلبات من [إعدادات الطلبات](/ordering) لو باقتك فيها طلبات.

بعدها الزباين يقدروا يمسحوا الكود ويشوفوا المنيو ويطلبوا.',ARRAY['بداية','ابدأ','خطوات','إعداد']::text[],ARRAY['add-menu-item','table-qr-code','restaurant-info']::text[],false,0,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='getting-started';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'first-steps','en',"id",'Where do I start with Bilhanah?','Once you are in the dashboard:

1. Complete your **restaurant details** and logo in [Settings](/settings).
2. Add menu categories and dishes in [Menu](/menu).
3. Add your tables and print their codes in [Tables](/tables).
4. Switch ordering on in [Ordering](/ordering) if your plan includes it.

Your guests can then scan a code, browse the menu and order.',ARRAY['start','setup','steps','begin']::text[],ARRAY['add-menu-item','table-qr-code','restaurant-info']::text[],false,0,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='getting-started';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'add-menu-item','ar',"id",'إزاي أضيف صنف جديد للمنيو؟','من صفحة [المنيو](/menu):

1. اختار القسم، أو اعمل قسم جديد من **ضيف قسم**.
2. دوس **ضيف صنف**، واكتب الاسم بالعربي (والإنجليزي لو حابب) والوصف.
3. حط السعر، ولو الصنف له أحجام ضيف كل حجم بسعره.
4. ارفع صورة واحفظ.

الصنف بيظهر للزباين على طول.',ARRAY['صنف','منيو','اضافة','طبق','سعر']::text[],ARRAY['sold-out-item','item-photo','first-steps']::text[],true,10,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'add-menu-item','en',"id",'How can I add a new menu item?','From [Menu](/menu):

1. Pick a category, or create one with **Add category**.
2. Press **Add item** and enter its name in Arabic (and English if you like) and a description.
3. Set the price; if it comes in sizes, add each size with its price.
4. Upload a photo and save.

The item shows on your menu straight away.',ARRAY['item','dish','menu','add','price']::text[],ARRAY['sold-out-item','item-photo','first-steps']::text[],true,10,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'sold-out-item','ar',"id",'إزاي أعلّم صنف إنه خلص؟','من [المنيو](/menu) دوس على مفتاح **متاح** جنب الصنف، فيظهر للزباين إنه خلص ومحدش يقدر يطلبه. رجّعه بنفس المفتاح لما يتوفر تاني. لو عندك فروع، كل فرع يعلّم الأصناف بتاعته لوحده.',ARRAY['خلص','متاح','غير متاح','نفد']::text[],ARRAY['add-menu-item']::text[],false,20,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'sold-out-item','en',"id",'How do I mark an item as sold out?','In [Menu](/menu), switch off **Available** next to the item; guests see it as sold out and cannot order it. Switch it back on when it is in stock again. With several branches, each branch marks its own items.',ARRAY['sold out','available','out of stock']::text[],ARRAY['add-menu-item']::text[],false,20,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'item-photo','ar',"id",'مقاس صورة الصنف المناسب كام؟','ارفع صورة JPEG أو PNG أو WebP، أقل حاجة 400 بكسل عرض وطول، وأكبر حجم 8 ميجا. إحنا بنصغّرها ونجهز منها مقاسات مختلفة عشان المنيو يفتح بسرعة على الموبايل.',ARRAY['صورة','مقاس','رفع','بكسل']::text[],ARRAY['add-menu-item']::text[],false,30,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'item-photo','en',"id",'What image size should a dish photo be?','Upload a JPEG, PNG or WebP image at least 400 pixels wide and tall, up to 8 MB. We resize it and make lighter versions so the menu loads fast on phones.',ARRAY['photo','image','size','upload']::text[],ARRAY['add-menu-item']::text[],false,30,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='menu';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'table-qr-code','ar',"id",'إزاي أعمل كود QR لطاولة؟','كل طاولة بتضيفها في [الطاولات](/tables) بيبقى ليها كود QR لوحدها. افتح قايمة الطاولة واختار **كود QR**، وتقدر تنزّله PNG أو SVG بالمقاس اللي يناسبك. ولو عايز كل الأكواد مرة واحدة، روح على [اطبع الأكواد](/tables/print).',ARRAY['qr','كود','طاولة','باركود']::text[],ARRAY['print-table-codes','regenerate-qr','first-steps']::text[],true,40,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'table-qr-code','en',"id",'How do I generate a QR code for a table?','Every table you add in [Tables](/tables) gets its own QR code. Open the table’s menu and choose **View QR code** to download it as PNG or SVG at the size you need. To get them all at once, use [Print QR codes](/tables/print).',ARRAY['qr','code','table','barcode']::text[],ARRAY['print-table-codes','regenerate-qr','first-steps']::text[],true,40,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'print-table-codes','ar',"id",'إزاي أطبع أكواد كل الطاولات؟','من [اطبع الأكواد](/tables/print) اختار شكل الطباعة (كروت، ستيكرات، ستاند بيتطبق، أو بوستر) واختار الطاولات، ودوس **اطبع**. وتقدر كمان تنزّل كل الأكواد في ملف ZIP واحد، PNG أو SVG.',ARRAY['طباعة','اطبع','ستيكر','zip']::text[],ARRAY['table-qr-code']::text[],false,50,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'print-table-codes','en',"id",'How do I print the codes for all my tables?','In [Print QR codes](/tables/print), pick a layout (cards, stickers, a folding table tent or a poster), choose the tables and press **Print**. You can also download every code in one ZIP, as PNG or SVG.',ARRAY['print','sticker','zip','layout']::text[],ARRAY['table-qr-code']::text[],false,50,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'regenerate-qr','ar',"id",'الكود اتسرق أو اتصور، أعمل إيه؟','من قايمة الطاولة في [الطاولات](/tables) اختار **اعمل QR جديد**. الكود القديم هيبطل يشتغل فورًا، فلازم تطبع الكارت الجديد وتحطه على الطاولة. الطلبات القديمة مش هتتأثر.',ARRAY['سرقة','جديد','قديم','تغيير الكود']::text[],ARRAY['table-qr-code']::text[],false,60,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'regenerate-qr','en',"id",'A table code was copied or lost. What should I do?','From the table’s menu in [Tables](/tables), choose **Regenerate QR code**. The old code stops working at once, so print the new card and put it on the table. Past orders are not affected.',ARRAY['regenerate','new code','stolen','copied']::text[],ARRAY['table-qr-code']::text[],false,60,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='qr-tables';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'track-orders','ar',"id",'إزاي أتابع الطلبات اللي جاية؟','الطلبات بتوصل على طول في صفحة [الطلبات](/orders) من غير ما تعمل refresh. كل طلب بيمشي من **جديد** لـ**بيتحضر** لـ**جاهز** لـ**اتسلم**، ودوس على الزرار عشان تنقله للخطوة اللي بعدها. الطلبات القديمة في [سجل الطلبات](/orders/history).',ARRAY['طلبات','متابعة','طلب جديد','لوحة']::text[],ARRAY['order-sound','pause-orders']::text[],true,70,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'track-orders','en',"id",'How can I track incoming orders?','Orders arrive live on [Orders](/orders) without refreshing. Each order moves from **New** to **Preparing** to **Ready** to **Completed**; press its button to move it on. Past orders are in [Order history](/orders/history).',ARRAY['orders','track','incoming','board']::text[],ARRAY['order-sound','pause-orders']::text[],true,70,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'order-sound','ar',"id",'مش سامع صوت لما طلب جديد يوصل','المتصفح مش بيسمح بالصوت غير بعد ما تدوس على الصفحة. افتح [الطلبات](/orders) ودوس على زرار **الصوت** مرة. وخلي التابة مفتوحة، ومتقفلش صوت الجهاز.',ARRAY['صوت','تنبيه','مش سامع','جرس']::text[],ARRAY['track-orders']::text[],false,80,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'order-sound','en',"id",'I do not hear a sound when a new order arrives','Browsers only play sound after you interact with the page. Open [Orders](/orders) and press the **Sound** button once. Keep the tab open and the device volume up.',ARRAY['sound','alert','notification','bell']::text[],ARRAY['track-orders']::text[],false,80,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'pause-orders','ar',"id",'إزاي أوقف استقبال الطلبات شوية؟','من [الطلبات](/orders) دوس **وقّف الطلبات**. الزباين هيشوفوا المنيو بس مش هيقدروا يطلبوا لحد ما ترجّعها. ومواعيد الشغل من [المواعيد](/hours) بتقفل الطلبات لوحدها برا المواعيد.',ARRAY['وقف','ايقاف','زحمة','مواعيد']::text[],ARRAY['track-orders']::text[],false,90,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'pause-orders','en',"id",'How do I pause orders for a while?','On [Orders](/orders), press **Pause orders**. Guests can still see the menu but cannot order until you resume. Your [opening hours](/hours) also stop orders automatically outside them.',ARRAY['pause','stop','busy','hours']::text[],ARRAY['track-orders']::text[],false,90,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='orders';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'mark-paid','ar',"id",'إزاي أعلّم إن الطاولة دفعت؟','من [الطاولات](/tables) افتح قايمة الطاولة واختار **الحساب وفضّي الترابيزة**، راجع الحساب واختار طريقة الدفع وأكّد. الطاولة بتتحول لـ**بتتنضف** لحد ما تخليها متاحة.',ARRAY['دفع','حساب','فاتورة','كاش']::text[],ARRAY['track-orders']::text[],false,100,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='payments';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'mark-paid','en',"id",'How do I mark a table as paid?','In [Tables](/tables), open the table’s menu and choose **Bill and clear table**, check the bill, pick the payment method and confirm. The table moves to **Cleaning** until you make it available.',ARRAY['paid','bill','payment','cash']::text[],ARRAY['track-orders']::text[],false,100,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='payments';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'manage-branches','ar',"id",'إزاي أدير فروع مطعمي؟','من [الفروع](/branches) تقدر تضيف فرع، وتحدد مواعيده وطلباته وطاولاته. كل فرع ليه لينك وأكواد لوحده، وتقدر تخفي أصناف أو تغيّر أسعارها في فرع معيّن من [منيو الفروع](/branches/menu). اختار الفرع من الزرار اللي فوق في أي صفحة.',ARRAY['فروع','فرع','اضافة فرع']::text[],ARRAY['branch-staff']::text[],true,110,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='branches';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'manage-branches','en',"id",'How can I manage my restaurant branches?','In [Branches](/branches) you can add a branch and set its hours, ordering and tables. Each branch has its own link and codes, and you can hide dishes or change prices per branch in [Branch menus](/branches/menu). Switch branch from the picker at the top of any page.',ARRAY['branches','branch','locations']::text[],ARRAY['branch-staff']::text[],true,110,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='branches';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'branch-staff','ar',"id",'أقدر أدي موظف صلاحية على فرع واحد بس؟','أيوه. من [الموظفين](/staff) لما تضيف أو تعدّل حساب، اختار الفرع اللي بيشتغل فيه. هيشوف طلبات وطاولات الفرع ده بس.',ARRAY['موظف','فرع واحد','صلاحية']::text[],ARRAY['manage-branches','staff-roles']::text[],false,120,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'branch-staff','en',"id",'Can I give a staff member access to one branch only?','Yes. In [Staff](/staff), when you add or edit an account, choose the branch they work at. They will only see that branch’s orders and tables.',ARRAY['staff','one branch','access']::text[],ARRAY['manage-branches','staff-roles']::text[],false,120,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'staff-roles','ar',"id",'إيه الفرق بين المدير والكاشير والويتر؟','**المدير** بيدير الفرع: الطلبات والطاولات والموظفين والإحصائيات. **الكاشير** بيقفل الحسابات والفلوس. **الويتر** بيتابع الطاولات والحجوزات وطلبات الزباين. **المطبخ** بيشوف شاشة المطبخ بس. وتقدر تدي صلاحيات زيادة من [الموظفين](/staff).',ARRAY['صلاحيات','مدير','كاشير','ويتر','دور']::text[],ARRAY['branch-staff']::text[],false,130,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'staff-roles','en',"id",'What is the difference between manager, cashier and waiter?','A **manager** runs the branch: orders, tables, staff and insights. A **cashier** closes bills and handles cash. A **waiter** looks after tables, reservations and guest requests. **Kitchen** sees the kitchen screen only. You can grant extra permissions in [Staff](/staff).',ARRAY['roles','permissions','manager','cashier','waiter']::text[],ARRAY['branch-staff']::text[],false,130,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'restaurant-info','ar',"id",'إزاي أعدّل بيانات المطعم؟','من [الإعدادات](/settings) تقدر تغيّر اسم المطعم والتليفون والعنوان ورقم الواتساب. واللوجو وصورة الغلاف والألوان من [الهوية](/branding). التغييرات بتظهر في المنيو على طول.',ARRAY['بيانات','اسم','عنوان','تليفون','لوجو']::text[],ARRAY['first-steps','brand-colors']::text[],true,140,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='restaurant-setup';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'restaurant-info','en',"id",'How can I update my restaurant information?','In [Settings](/settings) you can change the restaurant’s name, phone, address and WhatsApp number. The logo, cover photo and colors are in [Branding](/branding). Changes show on your menu straight away.',ARRAY['information','name','address','phone','logo']::text[],ARRAY['first-steps','brand-colors']::text[],true,140,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='restaurant-setup';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'brand-colors','ar',"id",'أقدر أغيّر ألوان المنيو؟','أيوه، من [الهوية](/branding) اختار لون مطعمك وشكل المنيو. اللون ده بيظهر كمان على كروت الـ QR اللي بتطبعها.',ARRAY['لون','ألوان','شكل','ثيم']::text[],ARRAY['restaurant-info']::text[],false,150,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='restaurant-setup';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'brand-colors','en',"id",'Can I change my menu colors?','Yes. In [Branding](/branding), pick your restaurant’s color and menu style. The color also shows on the QR cards you print.',ARRAY['color','theme','branding','style']::text[],ARRAY['restaurant-info']::text[],false,150,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='restaurant-setup';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'subscription-renew','ar',"id",'إزاي أجدد اشتراكي؟','من [الاشتراك](/subscription) اختار الباقة والمدة، وادفع أونلاين أو بالتحويل (إنستاباي أو فودافون كاش أو بنك) وارفع صورة الإيصال. هنراجع التحويل ونفعّل الاشتراك.',ARRAY['تجديد','اشتراك','دفع','باقة']::text[],ARRAY['subscription-plans']::text[],false,160,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='billing';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'subscription-renew','en',"id",'How do I renew my subscription?','In [Subscription](/subscription), choose a plan and period, then pay online or by transfer (InstaPay, Vodafone Cash or bank) and upload the receipt. We review transfers and activate your subscription.',ARRAY['renew','subscription','pay','plan']::text[],ARRAY['subscription-plans']::text[],false,160,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='billing';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'subscription-plans','ar',"id",'إيه الفرق بين الباقات؟','**المنيو** للمنيو الديجيتال وأكواد QR. **الطلبات** بتزود الطلب من الطاولة والتيك أواي. **المتقدمة** فيها كمان الفروع والإحصائيات المتقدمة وأدوات أكتر. الأسعار والتفاصيل في [الاشتراك](/subscription).',ARRAY['باقات','الفرق','سعر','خطة']::text[],ARRAY['subscription-renew']::text[],false,170,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='billing';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'subscription-plans','en',"id",'What is the difference between the plans?','**Menu** covers the digital menu and QR codes. **Orders** adds ordering from the table and takeaway. **Advanced** adds branches, advanced insights and more tools. Prices and details are in [Subscription](/subscription).',ARRAY['plans','difference','price','compare']::text[],ARRAY['subscription-renew']::text[],false,170,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='billing';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'forgot-password','ar',"id",'نسيت كلمة السر','من صفحة الدخول دوس **نسيت كلمة السر؟** واكتب إيميلك، هيوصلك لينك تعمل بيه كلمة سر جديدة. لو اللينك موصلش، بص في الـ Spam. حسابات الموظفين بيغيّرها صاحب المطعم من [الموظفين](/staff).',ARRAY['كلمة السر','باسورد','نسيت','دخول']::text[],ARRAY['staff-roles']::text[],false,180,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'forgot-password','en',"id",'I forgot my password','On the sign-in page, press **Forgot password?** and enter your email; you will get a link to set a new one. If it does not arrive, check your spam folder. Staff passwords are reset by the owner in [Staff](/staff).',ARRAY['password','forgot','reset','sign in']::text[],ARRAY['staff-roles']::text[],false,180,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='account';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'menu-not-loading','ar',"id",'الزباين بيقولوا المنيو مش بيفتح','اتأكد إن:

- الاشتراك شغال في [الاشتراك](/subscription).
- الطاولة مش متوقفة في [الطاولات](/tables).
- الكود المطبوع هو الأحدث، لو عملت QR جديد لازم تطبعه تاني.

لو لسه مش شغال، كلّمنا وابعتلنا صورة من اللي بيظهر للزبون.',ARRAY['مش بيفتح','مشكلة','عطل','منيو']::text[],ARRAY['regenerate-qr','table-qr-code']::text[],false,190,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='troubleshooting';
INSERT INTO "faq_articles" ("id","key","language","category_id","question","answer","keywords","related_keys","suggested","sort_order","status","updated_at") SELECT gen_random_uuid(),'menu-not-loading','en',"id",'Guests say the menu does not open','Check that:

- Your subscription is active in [Subscription](/subscription).
- The table is switched on in [Tables](/tables).
- The printed code is the latest one; after regenerating a code you must print it again.

If it still fails, contact us with a screenshot of what the guest sees.',ARRAY['not opening','problem','error','menu']::text[],ARRAY['regenerate-qr','table-qr-code']::text[],false,190,'PUBLISHED',now() FROM "faq_categories" WHERE "slug"='troubleshooting';
INSERT INTO "faq_revisions" ("id","article_id","version","question","answer","keywords","status") SELECT gen_random_uuid(),"id",1,"question","answer","keywords","status" FROM "faq_articles";
