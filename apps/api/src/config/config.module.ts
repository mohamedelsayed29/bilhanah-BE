import { resolve } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

// Local development reads the repository-root .env; deployed environments
// provide real variables and have no .env file.
const repositoryEnvFile = resolve(import.meta.dirname, '../../../../.env');

export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  envFilePath: repositoryEnvFile,
  validate: validateEnv,
});
