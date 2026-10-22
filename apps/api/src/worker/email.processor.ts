import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, Worker } from 'bullmq';
import type { Env } from '../config/env.schema.js';
import { MailerService } from '../infrastructure/email/mailer.service.js';
import { EMAIL_QUEUE, type EmailJob, queueConnection } from '../infrastructure/queues/queues.js';

/** Delivers queued email over SMTP; BullMQ retries failures with backoff. */
@Injectable()
export class EmailProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EmailProcessor.name);
  private worker?: Worker<EmailJob>;

  constructor(
    private readonly mailer: MailerService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<EmailJob>(EMAIL_QUEUE, (job) => this.process(job), {
      connection: queueConnection(this.config.get('REDIS_URL', { infer: true })),
      concurrency: 5,
    });
    this.worker.on('failed', (job, error) => {
      // Never log the message: it contains single-use tokens.
      this.logger.warn(
        { err: error, purpose: job?.data.purpose, attempt: job?.attemptsMade },
        'Email delivery attempt failed',
      );
    });
  }

  async process(job: Job<EmailJob>): Promise<void> {
    await this.mailer.send(job.data.message);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
