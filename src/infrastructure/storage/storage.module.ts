import { resolve } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { LocalStorageService } from './local-storage.service.js';
import { S3StorageService } from './s3-storage.service.js';
import { StorageService } from './storage.service.js';

/** var/media at the repository root (same depth from src/ and dist/). */
export const DEFAULT_LOCAL_STORAGE_DIR = resolve(import.meta.dirname, '../../../var/media');

@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StorageService => {
        const publicBaseUrl = config.get('MEDIA_PUBLIC_URL', { infer: true });
        if (config.get('STORAGE_DRIVER', { infer: true }) === 'local') {
          return new LocalStorageService(config.get('STORAGE_LOCAL_DIR', { infer: true }) ?? DEFAULT_LOCAL_STORAGE_DIR, publicBaseUrl);
        }
        return new S3StorageService({
          endpoint: config.get('S3_ENDPOINT', { infer: true }),
          region: config.get('S3_REGION', { infer: true }),
          bucket: config.get('S3_BUCKET', { infer: true })!,
          accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true })!,
          secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true })!,
          publicBaseUrl,
        });
      },
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
