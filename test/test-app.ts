import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { type EmailMessage, MailerService } from '../src/infrastructure/email/mailer.service.js';
import { REDIS } from '../src/infrastructure/redis/redis.module.js';
import { SecretBox } from '../src/common/crypto/secret-box.js';
import { base32Decode, totpCode, totpStep } from '../src/common/crypto/totp.js';
import { createAdmin } from '../src/commands/create-admin.js';
import { PasswordService } from '../src/modules/auth/password.service.js';

export const DASHBOARD_ORIGIN = 'http://dashboard.test';

/** Records outgoing email instead of sending it. */
export class FakeMailer {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  sendInBackground(message: EmailMessage): void {
    this.sent.push(message);
  }

  lastTo(to: string): EmailMessage | undefined {
    return this.sent.filter((message) => message.to === to).at(-1);
  }

  /** Extracts the single-use token from the latest email to `to`. */
  tokenFor(to: string): string {
    const token = /#token=([A-Za-z0-9_-]+)/.exec(this.lastTo(to)?.text ?? '')?.[1];
    if (!token) throw new Error(`No token email sent to ${to}`);
    return token;
  }
}

export type TestApp = {
  app: NestExpressApplication;
  mailer: FakeMailer;
  prisma: PrismaService;
  reset: () => Promise<void>;
};

export async function createTestApp(): Promise<TestApp> {
  const mailer = new FakeMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailerService)
    .useValue(mailer)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get<Redis>(REDIS);
  return {
    app,
    mailer,
    prisma,
    reset: async () => {
      // Cascades to sessions, tokens, restaurants and entitlements; the stand shop has no owner.
      await prisma.$executeRawUnsafe('TRUNCATE TABLE users, audit_logs, stand_orders, stand_logos CASCADE');
      await prisma.shopSettings.update({ where: { id: 1 }, data: { deliveryFeePiastres: null, cashOnDelivery: true, onlinePayment: true } });
      await prisma.paymentSettings.update({
        where: { id: 1 },
        data: { instapayAddress: null, vodafoneCashNumber: null, bankName: null, bankAccountName: null, bankAccountNumber: null, notesAr: null, notesEn: null },
      });
      for (const [code, priceMonthlyPiastres] of [['MENU', 20000], ['ORDERS', 35000], ['ADVANCED', 50000]] as const) {
        await prisma.plan.update({ where: { code }, data: { priceMonthlyPiastres } });
      }
      await prisma.trialSettings.update({
        where: { id: 1 },
        data: { enabled: true, durationDays: 30, planCode: 'ADVANCED' },
      });
      await redis.flushdb();
      mailer.sent.length = 0;
    },
  };
}

/** Registers, verifies and signs in an owner; returns the access token. */
export async function signUpOwner(t: TestApp, email: string, password = 'correct-horse-battery'): Promise<string> {
  const http = request(t.app.getHttpServer());
  await http.post('/v1/auth/register').send({ email, password, fullName: 'Test Owner' }).expect(202);
  await request(t.app.getHttpServer())
    .post('/v1/auth/verify-email')
    .send({ token: t.mailer.tokenFor(email) })
    .expect(200);
  const response = await request(t.app.getHttpServer())
    .post('/v1/auth/login')
    .set('Origin', DASHBOARD_ORIGIN)
    .send({ email, password })
    .expect(200);
  return response.body.accessToken as string;
}

/** Creates an administrator with an authenticator secret and signs in; returns the access token and secret. */
export async function signInAdmin(t: TestApp, email = 'admin@bilhanah.test'): Promise<{ token: string; secret: string }> {
  const passwords = t.app.get(PasswordService);
  const admin = await createAdmin(
    t.prisma,
    (value) => passwords.hash(value),
    { email, fullName: 'Platform Admin', password: ADMIN_PASSWORD },
    t.app.get(SecretBox),
  );
  const secret = admin.totpSecret!;
  const response = await request(t.app.getHttpServer())
    .post('/v1/auth/admin/login')
    .set('Origin', DASHBOARD_ORIGIN)
    .send({ email, password: ADMIN_PASSWORD, code: currentCode(secret) })
    .expect(200);
  return { token: response.body.accessToken as string, secret };
}

export const ADMIN_PASSWORD = 'admin-password-long-enough';

/** The authenticator code for `secret`, `offset` steps from now. */
export function currentCode(secret: string, offset = 0): string {
  return totpCode(base32Decode(secret), totpStep(new Date()) + offset);
}
