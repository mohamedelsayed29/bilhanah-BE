import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertSafeKey, StorageService } from './storage.service.js';

/** Files on local disk, served by the API at /media (development, or a single server with a volume). */
export class LocalStorageService extends StorageService {
  constructor(
    readonly root: string,
    private readonly publicBaseUrl: string,
  ) {
    super();
  }

  async put(key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix);
    await rm(join(this.root, prefix), { recursive: true, force: true });
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}
