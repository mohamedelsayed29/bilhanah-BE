import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../../config/env.schema.js';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE, type EmailJob, PUSH_JOB_OPTIONS, PUSH_QUEUE, type PushJob, queueConnection } from './queues.js';

export const EMAIL_JOBS = Symbol('EMAIL_JOBS');
export type EmailJobs = Queue<EmailJob>;
export const PUSH_JOBS = Symbol('PUSH_JOBS');
export type PushJobs = Queue<PushJob>;

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
    {
      provide: PUSH_JOBS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PushJobs =>
        new Queue<PushJob>(PUSH_QUEUE, {
          connection: queueConnection(config.get('REDIS_URL', { infer: true })),
          defaultJobOptions: PUSH_JOB_OPTIONS,
        }),
    },
  ],
  exports: [EMAIL_JOBS, PUSH_JOBS],
})
export class QueuesModule implements OnApplicationShutdown {
  constructor(
    @Inject(EMAIL_JOBS) private readonly emailJobs: EmailJobs,
    @Inject(PUSH_JOBS) private readonly pushJobs: PushJobs,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.emailJobs.close(), this.pushJobs.close()]);
  }
}
