import type { ConnectionOptions, DefaultJobOptions } from 'bullmq';
import type { EmailMessage } from '../email/mailer.service.js';

export const EMAIL_QUEUE = 'email';
export const MAINTENANCE_QUEUE = 'maintenance';

export type EmailJob = { message: EmailMessage; purpose: string };

/**
 * BullMQ opens its own Redis connections: workers block on them, and queue
 * commands must wait for Redis to come back rather than fail fast.
 */
export function queueConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/** Roughly 10 s, 20 s, 40 s, 80 s and 160 s between attempts. */
export const EMAIL_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  // Failed jobs hold single-use tokens, which expire within a day anyway.
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};
