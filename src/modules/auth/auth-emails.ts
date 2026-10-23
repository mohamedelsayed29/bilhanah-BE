import type { Language } from '@bilhanah/contracts';
import { type EmailTemplate as Template, renderEmail } from '../../infrastructure/email/template.js';

const copy = {
  verify: {
    ar: (name: string): Template => ({
      subject: 'فعّل حسابك في بالهنا',
      greeting: `أهلًا ${name}،`,
      body: 'شكرًا لتسجيلك في بالهنا. اضغط على الزر علشان تأكد إيميلك وتبدأ تجهز منيو مطعمك. اللينك صالح لمدة ٢٤ ساعة.',
      action: 'تأكيد الإيميل',
      footer: 'لو مش إنت اللي سجلت، تجاهل الرسالة دي.',
    }),
    en: (name: string): Template => ({
      subject: 'Confirm your Bilhanah account',
      greeting: `Hi ${name},`,
      body: 'Thanks for signing up for Bilhanah. Confirm your email to start building your restaurant menu. This link is valid for 24 hours.',
      action: 'Confirm email',
      footer: "If you didn't sign up, you can ignore this email.",
    }),
  },
  reset: {
    ar: (name: string): Template => ({
      subject: 'إعادة تعيين كلمة المرور',
      greeting: `أهلًا ${name}،`,
      body: 'وصلنا طلب لتغيير كلمة المرور بتاعة حسابك. اللينك صالح لمدة ساعة واحدة، وبعد التغيير هيتم تسجيل خروجك من كل الأجهزة.',
      action: 'تعيين كلمة مرور جديدة',
      footer: 'لو مش إنت اللي طلبت، تجاهل الرسالة دي وكلمة المرور هتفضل زي ما هي.',
    }),
    en: (name: string): Template => ({
      subject: 'Reset your Bilhanah password',
      greeting: `Hi ${name},`,
      body: 'We received a request to reset your password. This link is valid for one hour, and you will be signed out of all devices after the change.',
      action: 'Set a new password',
      footer: "If you didn't request this, ignore this email and your password will stay the same.",
    }),
  },
  existing: {
    ar: (name: string): Template => ({
      subject: 'حسابك في بالهنا موجود بالفعل',
      greeting: `أهلًا ${name}،`,
      body: 'حد حاول يسجل حساب جديد بالإيميل ده، بس عندك حساب بالفعل. تقدر تسجل دخول، ولو ناسي كلمة المرور اختار "نسيت كلمة المرور".',
      action: 'تسجيل الدخول',
      footer: 'لو مش إنت، مفيش حاجة مطلوبة منك.',
    }),
    en: (name: string): Template => ({
      subject: 'You already have a Bilhanah account',
      greeting: `Hi ${name},`,
      body: 'Someone tried to sign up with this email, but an account already exists. You can sign in, or choose "Forgot password" if you need to reset it.',
      action: 'Sign in',
      footer: "If this wasn't you, no action is needed.",
    }),
  },
};

// Tokens travel in the URL fragment so they never reach server access logs.
export function verificationEmail(to: string, name: string, language: Language, dashboardUrl: string, token: string) {
  return renderEmail(to, language, copy.verify[language](name), `${dashboardUrl}/verify-email#token=${token}`);
}

export function passwordResetEmail(to: string, name: string, language: Language, dashboardUrl: string, token: string) {
  return renderEmail(to, language, copy.reset[language](name), `${dashboardUrl}/reset-password#token=${token}`);
}

export function existingAccountEmail(to: string, name: string, language: Language, dashboardUrl: string) {
  return renderEmail(to, language, copy.existing[language](name), `${dashboardUrl}/login`);
}
