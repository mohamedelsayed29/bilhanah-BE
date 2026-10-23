import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { contactMessageSchema } from '@bilhanah/contracts';
import type { z } from 'zod';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { Env } from '../../config/env.schema.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { contactEmail } from './contact-email.js';

/** The website's contact form. Messages go to CONTACT_INBOX with the sender as Reply-To. */
@Controller('public/contact')
@UseGuards(RateLimitGuard)
export class ContactController {
  private readonly inbox: string;

  constructor(
    private readonly mailer: MailerService,
    config: ConfigService<Env, true>,
  ) {
    this.inbox = config.get('CONTACT_INBOX', { infer: true });
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(
    { name: 'contact:ip', limit: 5, windowSeconds: 60 * 60, by: 'ip' },
    { name: 'contact:email', limit: 3, windowSeconds: 60 * 60, by: 'email' },
  )
  send(@Body(new ZodValidationPipe(contactMessageSchema)) body: z.output<typeof contactMessageSchema>): void {
    // Bots fill the hidden field; accept silently so they learn nothing.
    if (body.website) return;
    this.mailer.sendInBackground(contactEmail(this.inbox, body), 'contact');
  }
}
