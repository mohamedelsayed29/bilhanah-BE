import type { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../src/config/env.schema.js';
import type { EmailMessage, MailerService } from '../src/infrastructure/email/mailer.service.js';
import { EMAIL_QUEUE, type EmailJob, queueConnection } from '../src/infrastructure/queues/queues.js';
import { EmailProcessor } from '../src/worker/email.processor.js';
import { MaintenanceService } from '../src/worker/maintenance.service.js';
import { createTestApp, type TestApp } from './test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const config = { get: () => process.env['REDIS_URL'] } as unknown as ConfigService<Env, true>;

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('email worker', () => {
  const message: EmailMessage = { to: 'owner@koshary.test', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' };
  let queue: Queue<EmailJob>;
  let processor: EmailProcessor | undefined;

  beforeEach(() => {
    queue = new Queue<EmailJob>(EMAIL_QUEUE, { connection: queueConnection(process.env['REDIS_URL']!) });
  });

  afterEach(async () => {
    await processor?.onApplicationShutdown();
    await queue.close();
  });

  it('delivers queued email', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    processor = new EmailProcessor({ send } as unknown as MailerService, config);
    processor.onApplicationBootstrap();

    await queue.add('email-verification', { message, purpose: 'email-verification' });

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(message), { timeout: 5_000 });
  });

  it('retries a failed delivery', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('SMTP unavailable')).mockResolvedValue(undefined);
    processor = new EmailProcessor({ send } as unknown as MailerService, config);
    processor.onApplicationBootstrap();

    await queue.add(
      'password-reset',
      { message, purpose: 'password-reset' },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  });
});

describe('maintenance', () => {
  it('purges spent tokens, old sessions and abandoned sign-ups only', async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const later = new Date(now.getTime() + DAY_MS);
    const hash = (n: number) => n.toString(16).padStart(64, '0');

    const owner = await t.prisma.user.create({
      data: { email: 'owner@koshary.test', passwordHash: 'x', fullName: 'Owner', emailVerifiedAt: ago(60), createdAt: ago(60) },
    });
    await t.prisma.user.create({ data: { email: 'recent@koshary.test', passwordHash: 'x', fullName: 'Recent', createdAt: ago(2) } });
    await t.prisma.user.create({ data: { email: 'abandoned@koshary.test', passwordHash: 'x', fullName: 'Gone', createdAt: ago(31) } });

    const session = (data: { expiresAt: Date; revokedAt?: Date }) =>
      t.prisma.session.create({ data: { userId: owner.id, tokenHash: hash(0), ...data } });
    const active = await session({ expiresAt: later });
    const recentlyRevoked = await session({ expiresAt: later, revokedAt: ago(5) });
    await session({ expiresAt: later, revokedAt: ago(31) });
    await session({ expiresAt: ago(31) });

    const token = (n: number, data: { expiresAt: Date; usedAt?: Date }) =>
      t.prisma.passwordResetToken.create({ data: { userId: owner.id, tokenHash: hash(n), ...data } });
    const usable = await token(1, { expiresAt: later });
    await token(2, { expiresAt: ago(1) });
    await token(3, { expiresAt: later, usedAt: ago(1) });
    await t.prisma.emailVerificationToken.create({ data: { userId: owner.id, tokenHash: hash(4), expiresAt: ago(1) } });

    const result = await new MaintenanceService(t.prisma).purgeExpired(now);

    expect(result).toEqual({ sessions: 2, verificationTokens: 1, resetTokens: 2, unverifiedAccounts: 1 });
    expect((await t.prisma.session.findMany()).map((s) => s.id).sort()).toEqual([active.id, recentlyRevoked.id].sort());
    expect((await t.prisma.passwordResetToken.findMany()).map((r) => r.id)).toEqual([usable.id]);
    expect((await t.prisma.user.findMany({ orderBy: { email: 'asc' } })).map((u) => u.email)).toEqual([
      'owner@koshary.test',
      'recent@koshary.test',
    ]);
  });
});
