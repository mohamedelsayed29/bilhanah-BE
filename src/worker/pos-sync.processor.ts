import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type { Env } from '../config/env.schema.js';
import { queueConnection } from '../infrastructure/queues/queues.js';
import { PosSyncService } from '../modules/pos-sync/pos-sync.service.js';

const QUEUE = 'pos-sync';
const RUN = 'run-due';

/** Runs due POS sync jobs every 15 seconds (docs/POS.md, task 6); one scheduler for every worker. */
@Injectable()
export class PosSyncProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PosSyncProcessor.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly sync: PosSyncService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const connection = queueConnection(this.config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue(QUEUE, { connection });
    await this.queue.upsertJobScheduler(RUN, { every: 15_000 }, { name: RUN, opts: { removeOnComplete: true, removeOnFail: 50 } });
    this.worker = new Worker(QUEUE, async () => {
      // Drain in batches while there is work.
      for (let round = 0; round < 10; round += 1) if ((await this.sync.runDue()) === 0) break;
    }, { connection, concurrency: 1 });
    this.worker.on('failed', (_job, error) => this.logger.error({ err: error }, 'POS sync run failed'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
