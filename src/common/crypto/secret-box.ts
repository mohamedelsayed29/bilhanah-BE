import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets at rest (AES-256-GCM). The stored form is
 * "v1.<iv>.<tag>.<ciphertext>" in base64url, so a database dump alone does not
 * reveal administrators' authenticator secrets.
 */
export class SecretBox {
  private readonly key: Buffer;

  /** `keyMaterial`: DATA_ENCRYPTION_KEY, or another secret the key is derived from. */
  constructor(keyMaterial: string) {
    this.key = Buffer.from(hkdfSync('sha256', keyMaterial, 'bilhanah', 'secret-box:v1', 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
  }

  /** Throws if the value was tampered with or sealed with another key. */
  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unrecognized sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}
