import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import type { Env } from '../../config/env.schema.js';

/** A browser's push subscription, as stored. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export type PushOptions = {
  /** A newer message with the same topic replaces one the service still holds (32 URL-safe characters at most). */
  topic: string;
  /** How long the push service keeps trying a phone that is offline. */
  ttlSeconds: number;
};

/**
 * delivered: the push service accepted it. gone: the subscription no longer
 * works (unsubscribed, expired, or our keys changed); delete it. rejected: the
 * service refused this message for good; retrying will not help.
 */
export type PushOutcome = 'delivered' | 'gone' | 'rejected';

const GONE = new Set([403, 404, 410]);
const REJECTED = new Set([400, 413]);

/** Sends Web Push messages (encrypted per RFC 8291, signed with our VAPID keys per RFC 8292). */
@Injectable()
export class PushService {
  private readonly vapid: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(config: ConfigService<Env, true>) {
    const publicKey = config.get('VAPID_PUBLIC_KEY', { infer: true });
    const privateKey = config.get('VAPID_PRIVATE_KEY', { infer: true });
    this.vapid = publicKey && privateKey ? { subject: config.get('VAPID_SUBJECT', { infer: true }), publicKey, privateKey } : null;
  }

  /** The application server key browsers subscribe with, or null when push is not configured. */
  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  /** Throws on failures worth retrying (network errors, 429, 5xx). */
  async send(target: PushTarget, payload: string, options: PushOptions): Promise<PushOutcome> {
    try {
      await webpush.sendNotification(toSubscription(target), payload, this.requestOptions(options));
      return 'delivered';
    } catch (error) {
      if (error instanceof webpush.WebPushError) {
        if (GONE.has(error.statusCode)) return 'gone';
        if (REJECTED.has(error.statusCode)) return 'rejected';
      }
      throw error;
    }
  }

  /** The HTTP request send() would make; for tests. */
  requestDetails(target: PushTarget, payload: string, options: PushOptions) {
    return webpush.generateRequestDetails(toSubscription(target), payload, this.requestOptions(options));
  }

  private requestOptions(options: PushOptions): webpush.RequestOptions {
    if (!this.vapid) throw new Error('Web Push is not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).');
    return { vapidDetails: this.vapid, TTL: options.ttlSeconds, urgency: 'high', topic: options.topic, timeout: 10_000 };
  }
}

function toSubscription(target: PushTarget): webpush.PushSubscription {
  return { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } };
}
