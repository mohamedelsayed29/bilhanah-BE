import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Env } from './config/env.schema.js';

/** HTTP configuration shared by the server bootstrap and e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Requests arrive through Nginx on the same host.
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use(cookieParser());
  const dashboardOrigins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors((request: { url?: string }, callback) => {
    // Public restaurant data is read from every restaurant subdomain and never uses cookies.
    if (request.url?.startsWith('/v1/public/')) {
      callback(null, { origin: '*', methods: ['GET'], credentials: false });
      return;
    }
    callback(null, { origin: dashboardOrigins, credentials: true });
  });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });
}
