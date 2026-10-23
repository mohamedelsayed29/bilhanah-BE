import { rateLimitIdentity } from './rate-limit.guard.js';

describe('rateLimitIdentity', () => {
  const request = (path: string, body: unknown = {}) => ({ ip: '10.0.0.7', path, body }) as Parameters<typeof rateLimitIdentity>[0];

  it('keys order limits per restaurant, so diners sharing Wi-Fi at one restaurant do not affect another', () => {
    const a = rateLimitIdentity(request('/v1/public/restaurants/koshary/orders'), 'ip+path');
    const b = rateLimitIdentity(request('/v1/public/restaurants/felfela/orders'), 'ip+path');
    expect(a).toBe('10.0.0.7|/v1/public/restaurants/koshary/orders');
    expect(a).not.toBe(b);
  });

  it('keys by email when there is one', () => {
    expect(rateLimitIdentity(request('/v1/auth/login', { email: ' A@B.test ' }), 'ip+email')).toBe('10.0.0.7|a@b.test');
    expect(rateLimitIdentity(request('/v1/auth/login'), 'email')).toBeNull();
    expect(rateLimitIdentity(request('/v1/auth/login'), 'ip')).toBe('10.0.0.7');
  });
});
