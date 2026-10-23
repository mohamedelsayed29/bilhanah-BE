import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { type BillingSummary, type OnlineCheckout, type OwnerPayment, paymentIdParamSchema, startOnlinePaymentSchema, submitPaymentSchema } from '@bilhanah/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { BillingService } from './billing.service.js';

const idParam = new ZodValidationPipe(paymentIdParamSchema);

/** Receipt images: never cached, shown inline. */
export function sendReceipt(response: Response, image: Buffer): StreamableFile {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Disposition', 'inline; filename="receipt.webp"');
  return new StreamableFile(image, { type: 'image/webp' });
}

/** The owner's subscription: plans, how to pay, and transfers sent for review. */
@Controller('billing')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('OWNER')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  summary(@CurrentAuth() auth: AuthContext): Promise<BillingSummary> {
    return this.billing.summary(auth.userId);
  }

  @Post('payments')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'billing-submit:ip', limit: 20, windowSeconds: 60 * 60, by: 'ip' })
  submit(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(submitPaymentSchema)) body: z.output<typeof submitPaymentSchema>,
  ): Promise<OwnerPayment> {
    return this.billing.submit(auth.userId, body);
  }

  /** Opens a Paymob checkout (card or wallet) for a plan; the owner is sent to checkoutUrl. */
  @Post('online')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'billing-online:ip', limit: 20, windowSeconds: 60 * 60, by: 'ip' })
  startOnline(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(startOnlinePaymentSchema)) body: z.output<typeof startOnlinePaymentSchema>,
  ): Promise<OnlineCheckout> {
    return this.billing.startOnline(auth.userId, body);
  }

  /** Withdraws a payment that has not been reviewed yet. */
  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    await this.billing.cancel(auth.userId, id);
  }

  @Get('payments/:id/proof')
  async proof(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return sendReceipt(response, await this.billing.ownerProof(auth.userId, id));
  }
}
