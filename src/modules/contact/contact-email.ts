import type { contactMessageSchema } from '@bilhanah/contracts';
import type { z } from 'zod';
import type { EmailMessage } from '../../infrastructure/email/mailer.service.js';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function contactEmail(inbox: string, message: z.output<typeof contactMessageSchema>): EmailMessage {
  const lines = [
    `From: ${message.name} <${message.email}>`,
    ...(message.restaurant ? [`Restaurant: ${message.restaurant}`] : []),
    ...(message.phone ? [`Phone: ${message.phone}`] : []),
    `Topic: ${message.topic}`,
    '',
    message.message,
  ];
  return {
    to: inbox,
    replyTo: message.email,
    // Newlines in a subject could inject headers; the name is single-line after trimming, but be explicit.
    subject: `[Contact · ${message.topic}] ${message.name.replace(/[\r\n]+/g, ' ')}`,
    text: lines.join('\n'),
    html: `<div dir="auto" style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(lines.join('\n'))}</div>`,
  };
}
