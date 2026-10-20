import { formatRefreshToken, generateToken, hashesEqual, hashToken, parseRefreshToken } from './tokens.js';

describe('auth tokens', () => {
  it('round-trips a refresh token', () => {
    const sessionId = '0199f0e2-1b2c-7d3e-8f40-123456789abc';
    const secret = generateToken();
    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toEqual({ sessionId, secret });
  });

  it.each([undefined, '', 'abc', 'not-a-uuid.secret', `0199f0e2-1b2c-7d3e-8f40-123456789abc.short`])(
    'rejects malformed refresh token %j',
    (value) => {
      expect(parseRefreshToken(value)).toBeNull();
    },
  );

  it('compares hashes', () => {
    const token = generateToken();
    expect(hashesEqual(hashToken(token), hashToken(token))).toBe(true);
    expect(hashesEqual(hashToken(token), hashToken(generateToken()))).toBe(false);
  });
});
