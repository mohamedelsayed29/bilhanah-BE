import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from './totp.js';
import { SecretBox } from './secret-box.js';

// RFC 6238 appendix B, SHA1 key "12345678901234567890" (8-digit codes there; the last 6 digits are the 6-digit codes).
const rfcSecret = Buffer.from('12345678901234567890');
const rfcVectors: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, code] of rfcVectors) {
      expect(totpCode(rfcSecret, totpStep(new Date(seconds * 1000)))).toBe(code);
    }
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(rfcSecret)).toBe(true);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('accepts one step of drift and refuses replays', () => {
    const secret = base32Encode(rfcSecret);
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    const code = totpCode(rfcSecret, step);

    expect(verifyTotp(secret, code, now, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(rfcSecret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(rfcSecret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(rfcSecret, step - 2), now, null)).toBeNull();
    // Already used: same or earlier step.
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    expect(otpauthUri('ABC', 'admin@bilhanah.com')).toBe(
      'otpauth://totp/Bilhanah%3Aadmin%40bilhanah.com?secret=ABC&issuer=Bilhanah&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('SecretBox', () => {
  it('encrypts, decrypts and detects tampering or a wrong key', () => {
    const box = new SecretBox('key-material-of-sufficient-length-123456');
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.seal('JBSWY3DPEHPK3PXP')).not.toBe(sealed);
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');

    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox('another-key-material-entirely-000000000').open(sealed)).toThrow();
  });
});
