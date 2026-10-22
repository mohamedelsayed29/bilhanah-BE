import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import type { EmailJobs } from '../queues/queues.module.js';
import { type EmailMessage, MailerService } from './mailer.service.js';

const message: EmailMessage = { to: 'owner@koshary.test', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' };

const config = {
  get: (key: string) =>
    ({ SMTP_HOST: '127.0.0.1', SMTP_PORT: 1025, SMTP_SECURE: false, MAIL_FROM: 'test@bilhanah.test' })[key],
} as unknown as ConfigService<Env, true>;

function mailerWithQueue(add: EmailJobs['add']) {
  const mailer = new MailerService(config, { add } as EmailJobs);
  const send = vi.spyOn(mailer, 'send').mockResolvedValue();
  return { mailer, send };
}

describe('MailerService.sendInBackground', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues the message for the worker', async () => {
    const add = vi.fn().mockResolvedValue({});
    const { mailer, send } = mailerWithQueue(add);

    mailer.sendInBackground(message, 'email-verification');
    await vi.waitFor(() => expect(add).toHaveBeenCalled());

    expect(add).toHaveBeenCalledWith('email-verification', { message, purpose: 'email-verification' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends directly when the queue rejects', async () => {
    const { mailer, send } = mailerWithQueue(vi.fn().mockRejectedValue(new Error('Redis down')));

    mailer.sendInBackground(message, 'password-reset');

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(message));
  });

  it('sends directly when the queue does not answer in time', async () => {
    vi.useFakeTimers();
    const { mailer, send } = mailerWithQueue(vi.fn(() => new Promise<never>(() => {})));

    mailer.sendInBackground(message, 'password-reset');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(send).toHaveBeenCalledWith(message);
  });
});
