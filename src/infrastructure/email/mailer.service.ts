import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.schema.js';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASSWORD', { infer: true });
    this.transporter = createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
    this.from = config.get('MAIL_FROM', { infer: true });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  /**
   * Sends without delaying the HTTP response, so response timing does not
   * reveal whether an account exists. Interim until the outbox/worker
   * pipeline delivers email with retries.
   */
  sendInBackground(message: EmailMessage, purpose: string): void {
    this.send(message).catch((error: unknown) => {
      // Never log the message body: it contains single-use tokens.
      this.logger.error({ err: error, purpose }, 'Email delivery failed');
    });
  }
}
