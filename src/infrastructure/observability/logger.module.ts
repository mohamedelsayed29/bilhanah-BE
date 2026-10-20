import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema.js';

// Accept an upstream request ID (for example from Nginx) only when it is
// well-formed; otherwise generate one. It is echoed in the response header
// and included in error bodies.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const AppLoggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    pinoHttp: {
      level: config.get('LOG_LEVEL', { infer: true }),
      genReqId: (request, response) => {
        const header = request.headers['x-request-id'];
        const id = typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
        response.setHeader('x-request-id', id);
        return id;
      },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      autoLogging: { ignore: (request) => request.url?.startsWith('/health') ?? false },
      transport:
        config.get('NODE_ENV', { infer: true }) === 'development'
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
    },
  }),
});
