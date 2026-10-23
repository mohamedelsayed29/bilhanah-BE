import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../infrastructure/database/database.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { PasswordService } from '../modules/auth/password.service.js';
import { CryptoModule } from '../common/crypto/crypto.module.js';
import { SecretBox } from '../common/crypto/secret-box.js';
import { otpauthUri } from '../common/crypto/totp.js';
import { authenticatorInstructions, createAdmin, CreateAdminError } from './create-admin.js';

const USAGE = `Usage: npm run admin:create -- --email <email> --name "<full name>"

The password is read from an interactive prompt, or from the first line of
standard input when piped. It is never accepted as an argument.`;

@Module({
  imports: [AppConfigModule, DatabaseModule, CryptoModule],
  providers: [PasswordService],
})
class CreateAdminCommandModule {}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new CreateAdminError('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    let input = '';
    for await (const chunk of stdin) input += chunk;
    return input.split(/\r?\n/)[0] ?? '';
  }
  const password = await readHidden('Password (min 12 characters): ');
  const confirmation = await readHidden('Confirm password: ');
  if (password !== confirmation) throw new CreateAdminError('Passwords do not match.');
  return password;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help || !values.email || !values.name) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const password = await readPassword();
  const app = await NestFactory.createApplicationContext(CreateAdminCommandModule, { logger: ['error'] });
  try {
    const passwords = app.get(PasswordService);
    const admin = await createAdmin(
      app.get(PrismaService),
      (value) => passwords.hash(value),
      { email: values.email, fullName: values.name, password },
      app.get(SecretBox),
    );
    console.log(`Administrator created: ${admin.email} (${admin.id})\n`);
    console.log(authenticatorInstructions(admin.email, admin.totpSecret!, otpauthUri(admin.totpSecret!, admin.email)));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof CreateAdminError ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
