import type { Language } from '@bilhanah/contracts';
import type { EmailMessage } from './mailer.service.js';

export type EmailTemplate = {
  subject: string;
  greeting: string;
  /** Paragraphs. */
  body: string | string[];
  /** Button label; omitted for emails without a link. */
  action?: string;
  footer: string;
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The shared Bilhanah email layout, right-to-left for Arabic. */
export function renderEmail(to: string, language: Language, template: EmailTemplate, link?: string): EmailMessage {
  const dir = language === 'ar' ? 'rtl' : 'ltr';
  const paragraphs = Array.isArray(template.body) ? template.body : [template.body];
  const button = template.action && link;
  return {
    to,
    subject: template.subject,
    text: [template.greeting, ...paragraphs, ...(button ? [`${template.action}: ${link}`] : []), template.footer].join('\n\n'),
    html: `<!doctype html><html lang="${language}" dir="${dir}"><body style="margin:0;background:#fff8ef;font-family:Arial,sans-serif;color:#242b29">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="font-size:20px;font-weight:bold;color:#075e54;margin:0 0 24px">Bilhanah · بالهنا</p>
<p>${escapeHtml(template.greeting)}</p>
${paragraphs.map((paragraph) => `<p style="line-height:1.7">${escapeHtml(paragraph)}</p>`).join('\n')}
${button ? `<p style="margin:28px 0"><a href="${escapeHtml(link)}" style="background:#075e54;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">${escapeHtml(template.action!)}</a></p>` : ''}
<p style="color:#606c65;font-size:13px;line-height:1.6">${escapeHtml(template.footer)}</p>
</div></body></html>`,
  };
}
