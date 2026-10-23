import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint, pushSubscriptionSchema } from '../src/index.js';

describe('isPushServiceEndpoint', () => {
  it('accepts the browsers’ push services', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/dXk2',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGuNfZ',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://FCM.googleapis.com/fcm/send/upper',
    ]) {
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://notify.windows.com/x',
      'https://evil-notify.windows.com.example/x',
      'https://fcm.googleapis.com:444/x',
      'https://a:b@fcm.googleapis.com/x',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
      '',
    ]) {
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});

describe('pushSubscriptionSchema', () => {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    expirationTime: null,
    keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
  };

  it('takes PushSubscription.toJSON() and defaults to Arabic', () => {
    expect(pushSubscriptionSchema.parse(subscription)).toEqual({ ...subscription, language: 'ar' });
    expect(pushSubscriptionSchema.parse({ ...subscription, language: 'en', extra: 1 })).toEqual({ ...subscription, language: 'en' });
  });

  it('refuses other hosts and malformed keys', () => {
    expect(pushSubscriptionSchema.safeParse({ ...subscription, endpoint: 'https://example.com/push' }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, keys: { ...subscription.keys, auth: 'short' } }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, keys: { ...subscription.keys, p256dh: `${'A'.repeat(86)}!` } }).success).toBe(false);
  });
});
