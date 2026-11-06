import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { jsonBody } from './common/http/json-body.js';
import type { Env } from './config/env.schema.js';
import { LocalStorageService } from './infrastructure/storage/local-storage.service.js';
import { PRIVATE_PREFIX, StorageService } from './infrastructure/storage/storage.service.js';

/** HTTP configuration shared by the server bootstrap and e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Which hops may set X-Forwarded-For; the client IP drives rate limiting.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  app.use(helmet());
  // Images stored on local disk. Keys are never reused, so they cache forever;
  // restaurant pages on other origins must be allowed to embed them.
  const storage = app.get(StorageService);
  if (storage instanceof LocalStorageService) {
    // Payment receipts are only streamed by the API to their owner and administrators.
    app.use(`/media/${PRIVATE_PREFIX}`, (_request: express.Request, response: express.Response) => {
      response.status(404).end();
    });
    app.use(
      '/media',
      express.static(storage.root, {
        immutable: true,
        maxAge: '365d',
        index: false,
        setHeaders: (response) => response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
      }),
    );
  }
  app.use(cookieParser());
  // Runs before Nest's parser (registered at init), so body errors get standard codes.
  app.use(jsonBody());
  const dashboardOrigins = [...new Set([...config.get('CORS_ORIGINS', { infer: true }), ...config.get('ADMIN_ORIGINS', { infer: true })])];
  app.enableCors((request: { url?: string }, callback) => {
    // Public routes serve every restaurant subdomain and the website, and never use cookies.
    if (request.url?.startsWith('/v1/public/')) {
      callback(null, { origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], credentials: false });
      return;
    }
    callback(null, { origin: dashboardOrigins, credentials: true });
  });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });
}
