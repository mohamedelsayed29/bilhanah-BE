import { trackingTokenSchema } from '@bilhanah/contracts';
import { businessDay } from './business-day.js';
import { TrackingTokens } from './tracking-token.js';

describe('TrackingTokens', () => {
  const tokens = new TrackingTokens('key-material-of-sufficient-length-123456');
  const orderId = '0f72445b-78aa-4f84-90de-538527b1fc4d';

  it('round-trips and is stable, so retries get the same link', () => {
    const token = tokens.issue(orderId);
    expect(tokens.issue(orderId)).toBe(token);
    expect(tokens.verify(token)).toBe(orderId);
    expect(trackingTokenSchema.safeParse(token).success).toBe(true);
  });

  it('rejects forged, altered and foreign tokens', () => {
    const token = tokens.issue(orderId);
    const [id, signature] = token.split('.');
    const otherId = tokens.issue('11111111-2222-4333-8444-555555555555').split('.')[0];
    expect(tokens.verify(`${otherId}.${signature}`)).toBeNull();
    expect(tokens.verify(`${id}.${signature!.slice(0, -1)}A`)).toBeNull();
    expect(tokens.verify('garbage')).toBeNull();
    expect(new TrackingTokens('another-key-material-entirely-000000000').verify(token)).toBeNull();
  });
});

describe('businessDay', () => {
  it('uses the restaurant time zone', () => {
    // 23:30 UTC on the 23rd is 02:30 on the 24th in Cairo (UTC+3).
    const late = new Date('2026-10-23T23:30:00Z');
    expect(businessDay(late, 'Africa/Cairo').toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(businessDay(late, 'UTC').toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });
});
