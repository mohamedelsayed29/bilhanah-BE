import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CryptoModule } from '../common/crypto/crypto.module.js';
import { SecretBox } from '../common/crypto/secret-box.js';
import { otpauthUri } from '../common/crypto/totp.js';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../infrastructure/database/database.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { authenticatorInstructions, CreateAdminError, resetAdminMfa } from './create-admin.js';

const USAGE = `Usage: npm run admin:reset-mfa -- --email <email>

Issues a new authenticator key for an administrator (for example after a
lost phone) and signs them out of every device.`;

@Module({ imports: [AppConfigModule, DatabaseModule, CryptoModule] })
class ResetAdminMfaCommandModule {}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.email) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const app = await NestFactory.createApplicationContext(ResetAdminMfaCommandModule, { logger: ['error'] });
  try {
    const secret = await resetAdminMfa(app.get(PrismaService), app.get(SecretBox), values.email);
    console.log(authenticatorInstructions(values.email, secret, otpauthUri(secret, values.email)));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof CreateAdminError ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
