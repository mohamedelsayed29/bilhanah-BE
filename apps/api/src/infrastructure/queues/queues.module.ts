import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../../config/env.schema.js';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE, type EmailJob, queueConnection } from './queues.js';

export const EMAIL_JOBS = Symbol('EMAIL_JOBS');
export type EmailJobs = Queue<EmailJob>;

/** Producers for background jobs. Workers run in the separate worker process. */
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_JOBS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): EmailJobs =>
        new Queue<EmailJob>(EMAIL_QUEUE, {
          connection: queueConnection(config.get('REDIS_URL', { infer: true })),
          defaultJobOptions: EMAIL_JOB_OPTIONS,
        }),
    },
  ],
  exports: [EMAIL_JOBS],
})
export class QueuesModule implements OnApplicationShutdown {
  constructor(@Inject(EMAIL_JOBS) private readonly emailJobs: EmailJobs) {}

  async onApplicationShutdown(): Promise<void> {
    await this.emailJobs.close();
  }
}
