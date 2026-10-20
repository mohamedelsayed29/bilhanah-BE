// Policy copy reflects the behaviour described in PROJECT_PLAN.md (trials, billing, data handling).
// Have it reviewed by legal counsel before launch.

type Localized<T> = { ar: T; en: T };
/** A paragraph, or a bulleted list when given as an array. */
export type LegalBlock = string | string[];
export type LegalSection = { id: string; title: Localized<string>; body: Localized<LegalBlock[]> };
export type LegalDocument = { title: Localized<string>; intro: Localized<string>; updated: string; sections: LegalSection[] };
export type LegalDocumentId = 'privacy' | 'terms';

const UPDATED = '2026-10-20';

const privacy: LegalDocument = {
  title: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
  intro: {
    ar: 'بنشرح هنا البيانات اللي بنجمعها، وبنستخدمها في إيه، وإزاي بنحافظ عليها. بيانات مطعمك ملكك، وإحنا بنتعامل معاها على الأساس ده.',
    en: 'This explains what we collect, why we use it, and how we protect it. Your restaurant’s data belongs to you, and we treat it that way.',
  },
  updated: UPDATED,
  sections: [
    {
      id: 'scope',
      title: { ar: 'نطاق السياسة', en: 'Scope' },
      body: {
        ar: ['السياسة دي بتغطي موقع بالهنا، ولوحة تحكم المطاعم، وصفحات المنيو العامة اللي بتظهر على عنوان كل مطعم (زي restaurant.bilhanah.com).'],
        en: ['This policy covers the Bilhanah website, the restaurant dashboard, and the public menu pages served at each restaurant’s address (such as restaurant.bilhanah.com).'],
      },
    },
    {
      id: 'collect',
      title: { ar: 'البيانات اللي بنجمعها', en: 'What we collect' },
      body: {
        ar: [
          'بنجمع بس البيانات اللي الخدمة محتاجاها عشان تشتغل:',
          [
            'بيانات حساب صاحب المطعم: الاسم، والإيميل، وكلمة المرور (بتتخزن مشفّرة ومحدش يقدر يشوفها)، ولغتك المفضلة.',
            'بيانات المطعم: اسم المطعم، واسم المسؤول، والتليفون، والمدينة، والعنوان، واللوجو ولينكات التواصل لو ضفتها.',
            'محتوى المنيو: الأقسام، والأطباق، والصور، والأوصاف، والأحجام، والأسعار.',
            'بيانات الطلبات: الأصناف، ورقم الترابيزة أو بيانات الاستلام، والملاحظات، وحالة الطلب. الزبون مش محتاج يعمل حساب عشان يطلب.',
            'بيانات الاشتراك: الفواتير وحالة الدفع. ولو اخترت التحويل اليدوي، بنحتفظ بإثبات التحويل اللي بتبعته، وبيفضل خاص.',
          ],
        ],
        en: [
          'We only collect what the service needs to work:',
          [
            'Owner account details: name, email, password (stored hashed and never readable), and preferred language.',
            'Restaurant details: restaurant name, contact person, phone, city, address, and optional logo and contact links.',
            'Menu content: categories, dishes, photos, descriptions, sizes, and prices.',
            'Order details: items, table or pickup details, notes, and status. Guests do not need an account to order.',
            'Subscription details: invoices and payment status. If you choose a manual transfer, we keep the evidence you upload, privately.',
          ],
        ],
      },
    },
    {
      id: 'payments',
      title: { ar: 'المدفوعات', en: 'Payments' },
      body: {
        ar: ['الدفع الإلكتروني للاشتراك بيتم من خلال صفحة دفع Paymob الآمنة. إحنا ما بنشوفش ولا بنخزّن بيانات الكارت. ودفع تمن الأكل بيتم مباشرةً بين الزبون والمطعم، وبالهنا مش طرف فيه.'],
        en: ['Electronic subscription payments go through Paymob’s secure hosted checkout. We never see or store card details. Payment for food happens directly between the guest and the restaurant; Bilhanah is not involved.'],
      },
    },
    {
      id: 'use',
      title: { ar: 'بنستخدم البيانات في إيه', en: 'How we use it' },
      body: {
        ar: [[
          'تشغيل المنيو والطلبات وتنبيهات الطلب الجاهز.',
          'إرسال إيميلات ضرورية: تأكيد الحساب، واسترجاع كلمة المرور، وتذكيرات قبل انتهاء الاشتراك.',
          'إدارة الاشتراك والفواتير والتجربة المجانية.',
          'حماية الخدمة من إساءة الاستخدام وتحسين أدائها.',
        ], 'مش بنبيع بياناتك، ومش بنستخدمها في إعلانات.'],
        en: [[
          'Running the menu, orders, and order-ready alerts.',
          'Sending essential emails: account verification, password recovery, and reminders before your subscription ends.',
          'Managing subscriptions, invoices, and the free trial.',
          'Protecting the service from abuse and improving its performance.',
        ], 'We do not sell your data or use it for advertising.'],
      },
    },
    {
      id: 'sharing',
      title: { ar: 'مشاركة البيانات', en: 'Sharing' },
      body: {
        ar: ['بنشارك البيانات بس مع مقدّمي الخدمات اللي بنعتمد عليهم في التشغيل (الاستضافة، وتخزين الصور، وإرسال الإيميلات، وPaymob للدفع)، وفي حدود اللي يحتاجوه عشان يقدموا الخدمة. وممكن نشارك بيانات لو القانون طلب ده.'],
        en: ['We share data only with the providers we rely on to operate (hosting, image storage, email delivery, and Paymob for payments), limited to what they need to provide their service, or when the law requires it.'],
      },
    },
    {
      id: 'security',
      title: { ar: 'الحماية وفصل البيانات', en: 'Security and separation' },
      body: {
        ar: ['بيانات كل مطعم منفصلة عن غيره، ومحدش يقدر يوصل لمنيو أو طلبات أو ملفات مطعم تاني. إثباتات الدفع بتتخزن بشكل خاص ومش بتظهر للعامة، وبنعمل نسخ احتياطية منتظمة لقاعدة البيانات.'],
        en: ['Each restaurant’s data is isolated; no one can reach another restaurant’s menu, orders, or files. Payment evidence is stored privately, and the database is backed up regularly.'],
      },
    },
    {
      id: 'retention',
      title: { ar: 'الاحتفاظ بالبيانات وحذفها', en: 'Retention and deletion' },
      body: {
        ar: ['لو الاشتراك خلص، بنحتفظ ببيانات مطعمك وعنوانه والـ QR بتاعه عشان ترجع تكمّل من مكانك أول ما تجدد. ولو عايز تمسح حسابك وبياناتك نهائيًا، ابعتلنا من صفحة التواصل.'],
        en: ['When a subscription ends, we keep your restaurant data, address, and QR code so you can pick up where you left off after renewing. To permanently delete your account and data, contact us.'],
      },
    },
    {
      id: 'rights',
      title: { ar: 'حقوقك', en: 'Your rights' },
      body: {
        ar: ['تقدر تعدّل بيانات حسابك ومطعمك في أي وقت من لوحة التحكم، وتطلب نسخة من بياناتك أو حذفها عن طريق التواصل معانا.'],
        en: ['You can update your account and restaurant details at any time from the dashboard, and request a copy or deletion of your data by contacting us.'],
      },
    },
    {
      id: 'changes',
      title: { ar: 'التعديلات على السياسة', en: 'Changes to this policy' },
      body: {
        ar: ['لو عدّلنا السياسة دي تعديل مهم، هنبلّغك بالإيميل قبلها. تاريخ آخر تحديث مكتوب أول الصفحة.'],
        en: ['If we make a significant change, we will email you beforehand. The date of the latest update appears at the top of this page.'],
      },
    },
  ],
};

const terms: LegalDocument = {
  title: { ar: 'شروط الاستخدام', en: 'Terms of service' },
  intro: {
    ar: 'الشروط دي بتنظّم استخدامك لبالهنا. كتبناها بلغة بسيطة عشان تعرف بالظبط إيه اللي ليك وإيه اللي عليك.',
    en: 'These terms govern your use of Bilhanah. We wrote them plainly so you know exactly what to expect.',
  },
  updated: UPDATED,
  sections: [
    {
      id: 'acceptance',
      title: { ar: 'الموافقة على الشروط', en: 'Accepting these terms' },
      body: {
        ar: ['لما بتعمل حساب أو بتستخدم بالهنا، إنت بتوافق على الشروط دي وعلى سياسة الخصوصية.'],
        en: ['By creating an account or using Bilhanah, you agree to these terms and to our privacy policy.'],
      },
    },
    {
      id: 'account',
      title: { ar: 'حسابك', en: 'Your account' },
      body: {
        ar: [[
          'كل مطعم ليه حساب صاحب واحد، وفرع واحد، ومنيو واحد في الإصدار الحالي.',
          'لازم تكون البيانات اللي بتدخلها صحيحة، وإنت مسؤول عن سرية كلمة المرور.',
          'لازم تأكّد الإيميل قبل ما تبدأ تجهّز مطعمك.',
        ]],
        en: [[
          'Each restaurant has one owner account, one location, and one menu in the current release.',
          'The details you provide must be accurate, and you are responsible for keeping your password secret.',
          'You must verify your email before setting up your restaurant.',
        ]],
      },
    },
    {
      id: 'trial',
      title: { ar: 'التجربة المجانية', en: 'Free trial' },
      body: {
        ar: ['التجربة المجانية مدتها ٣٠ يوم على الباقة الكاملة، ولكل حساب تجربة واحدة. بتبدأ لما تجهّز بيانات مطعمك بعد تأكيد الإيميل، ومش محتاجة أي بيانات دفع.'],
        en: ['The free trial lasts 30 days on the Full Experience plan, once per account. It starts when you set up your restaurant after verifying your email, and needs no payment details.'],
      },
    },
    {
      id: 'billing',
      title: { ar: 'الاشتراك والدفع', en: 'Subscription and billing' },
      body: {
        ar: [[
          'الاشتراك شهري وبالجنيه المصري، وبتدفع إلكترونيًا من خلال Paymob أو بتحويل يدوي بنراجعه ونأكّده.',
          'مفيش تجديد تلقائي ولا خصم من الكارت من غير ما تطلب. إنت اللي بتجدد لما تحب.',
          'لو السعر اتغيّر، التغيير مش بيأثر على فترة إنت دافعها بالفعل.',
          'لو دفعت أثناء التجربة، الشهر المدفوع بيبدأ بعد ما التجربة تخلص.',
        ]],
        en: [[
          'Subscriptions are monthly, in Egyptian pounds, paid electronically via Paymob or by a manual transfer we review and confirm.',
          'There is no automatic renewal and no card charge you did not request. You renew when you choose.',
          'Price changes never affect a period you have already paid for.',
          'If you pay during your trial, the paid month starts after the trial ends.',
        ]],
      },
    },
    {
      id: 'expiry',
      title: { ar: 'لما الاشتراك يخلص', en: 'When a subscription ends' },
      body: {
        ar: ['المنيو العام والطلبات الجديدة بيتوقفوا مؤقتًا، وبتظهر للزبون صفحة إن المنيو مش متاح دلوقتي. بياناتك وعنوانك والـ QR بيفضلوا محفوظين، والطلبات المفتوحة بتكمل عادي، وكل حاجة بترجع أول ما تجدد.'],
        en: ['The public menu and new orders pause, and guests see a neutral temporarily-unavailable page. Your data, address, and QR code are preserved, open orders can still be completed, and everything returns as soon as you renew.'],
      },
    },
    {
      id: 'content',
      title: { ar: 'محتوى المنيو ومسؤوليته', en: 'Your menu content' },
      body: {
        ar: ['إنت مسؤول عن دقة المنيو: الأسعار، والأوصاف، والمكونات، والصور، وإن عندك حق استخدامها. دفع تمن الأكل وتحضير الطلبات وتسليمها مسؤولية المطعم مباشرةً مع الزبون.'],
        en: ['You are responsible for the accuracy of your menu, including prices, descriptions, ingredients, and photos, and for having the right to use them. Payment for food and preparing and handing over orders are between the restaurant and the guest.'],
      },
    },
    {
      id: 'alerts',
      title: { ar: 'تنبيهات الطلب', en: 'Order alerts' },
      body: {
        ar: ['الصوت والاهتزاز في تنبيه "طلبك جاهز" بيعتمدوا على جهاز الزبون والمتصفح وإعداداته، فمش مضمونين على كل الأجهزة.'],
        en: ['Sound and vibration in order-ready alerts depend on the guest’s device, browser, and settings, so they are not guaranteed on every device.'],
      },
    },
    {
      id: 'acceptable-use',
      title: { ar: 'الاستخدام المقبول', en: 'Acceptable use' },
      body: {
        ar: ['ممنوع استخدام بالهنا في أي محتوى مخالف للقانون، أو مضلل، أو بينتهك حقوق حد، أو في محاولة الوصول لبيانات مطاعم تانية أو تعطيل الخدمة. ومن حقنا نوقف أي حساب بيخالف ده.'],
        en: ['You may not use Bilhanah for unlawful, misleading, or infringing content, or to access other restaurants’ data or disrupt the service. We may suspend accounts that do.'],
      },
    },
    {
      id: 'changes',
      title: { ar: 'التعديلات على الشروط', en: 'Changes to these terms' },
      body: {
        ar: ['لو عدّلنا الشروط تعديل مهم، هنبلّغك بالإيميل قبلها. واستمرارك في استخدام الخدمة بعد التعديل معناه إنك موافق عليه.'],
        en: ['If we make a significant change, we will email you beforehand. Continuing to use the service afterwards means you accept the change.'],
      },
    },
  ],
};

export const legalDocuments: Record<LegalDocumentId, LegalDocument> = { privacy, terms };
