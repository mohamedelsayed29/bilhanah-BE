import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Query, UnauthorizedException } from '@nestjs/common';
import { COMMON_ERROR_CODES } from '@bilhanah/contracts';
import { PaymobService } from '../../infrastructure/paymob/paymob.service.js';
import { BillingService, idFromPaymobReference, SUBSCRIPTION_REFERENCE_PREFIX } from '../billing/billing.service.js';
import { ShopService, STAND_REFERENCE_PREFIX } from '../shop/shop.service.js';

/**
 * Paymob's "transaction processed" callback (the notification_url of each
 * checkout). Only signed callbacks are trusted; each is routed to the
 * subscription payment or stand order named in its merchant reference.
 */
@Controller('webhooks/paymob')
export class PaymobWebhookController {
  private readonly logger = new Logger(PaymobWebhookController.name);

  constructor(
    private readonly paymob: PaymobService,
    private readonly billing: BillingService,
    private readonly shop: ShopService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async transaction(@Query('hmac') hmac: unknown, @Body() body: unknown): Promise<{ received: true }> {
    const transaction = this.paymob.readTransactionCallback(body, hmac);
    if (!transaction) {
      this.logger.warn('Refused a Paymob callback without a valid signature');
      throw new UnauthorizedException({ code: COMMON_ERROR_CODES.FORBIDDEN, message: 'Invalid signature.' });
    }
    const paymentId = idFromPaymobReference(SUBSCRIPTION_REFERENCE_PREFIX, transaction.reference);
    const standOrderId = idFromPaymobReference(STAND_REFERENCE_PREFIX, transaction.reference);
    if (paymentId) await this.billing.settleOnline(paymentId, transaction);
    else if (standOrderId) await this.shop.settleOnline(standOrderId, transaction);
    // Anything else was paid through another integration on the account: acknowledge and ignore.
    else this.logger.warn({ transactionId: transaction.id, reference: transaction.reference }, 'Paymob callback with an unknown reference');
    return { received: true };
  }
}
