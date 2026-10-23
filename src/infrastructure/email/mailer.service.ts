import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.schema.js';
import { EMAIL_JOBS, type EmailJobs } from '../queues/queues.module.js';

// How long to wait for Redis before sending directly instead.
const ENQUEUE_TIMEOUT_MS = 2_000;

export type EmailMessage = {
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(EMAIL_JOBS) private readonly emailJobs: EmailJobs,
  ) {
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
   * Queues the message for the worker, which retries failed deliveries.
   * Returns immediately, so response timing does not reveal whether an
   * account exists. If Redis is unreachable the message is sent directly,
   * without retries, rather than dropped.
   */
  sendInBackground(message: EmailMessage, purpose: string): void {
    void this.enqueue(message, purpose).catch((error: unknown) => {
      // Never log the message body: it contains single-use tokens.
      this.logger.warn({ err: error, purpose }, 'Email queue unavailable; sending directly');
      this.send(message).catch((sendError: unknown) => {
        this.logger.error({ err: sendError, purpose }, 'Email delivery failed');
      });
    });
  }

  private async enqueue(message: EmailMessage, purpose: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out queueing email')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.emailJobs.add(purpose, { message, purpose }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
