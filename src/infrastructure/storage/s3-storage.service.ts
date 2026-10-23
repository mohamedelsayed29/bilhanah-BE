import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertSafeKey, StorageService } from './storage.service.js';

export type S3StorageOptions = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
};

/** S3-compatible object storage (Cloudflare R2 in production). Keys never change, so objects cache forever. */
export class S3StorageService extends StorageService {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    super();
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix);
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: `${prefix}/`, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: keys } }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  publicUrl(key: string): string {
    return `${this.options.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}
