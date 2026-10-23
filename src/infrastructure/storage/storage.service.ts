/** Object storage for uploaded files. Keys are relative paths such as restaurants/{id}/media/{id}/640.webp. */
export abstract class StorageService {
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix/`. */
  abstract deletePrefix(prefix: string): Promise<void>;
  abstract publicUrl(key: string): string;
}

/** Rejects keys that could escape their prefix. */
export function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
