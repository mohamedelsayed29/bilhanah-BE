import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BILLING_ERROR_CODES,
  type placeStandOrderSchema,
  type PlaceStandOrderResponse,
  type PublicStandOrder,
  SHOP_ERROR_CODES,
  type ShopInfo,
  STAND_LIMITS,
  STAND_PRICES,
  type StandOrderCheckout,
  type StandPaymentMethod,
  standUnitPricePiastres,
  type UploadedLogo,
} from '@bilhanah/contracts';
import type { ShopSettings } from '@bilhanah/database';
import sharp from 'sharp';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { PaymobError, PaymobService, type PaymobTransaction } from '../../infrastructure/paymob/paymob.service.js';
import { PRIVATE_PREFIX, StorageService } from '../../infrastructure/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { paymobReference } from '../billing/billing.service.js';
import { sniffImageType } from '../media/image-processing.js';
import { STAND_ORDER_TOKENS, TrackingTokens } from '../orders/tracking-token.js';
import { newStandOrderAdminEmail, standOrderPlacedEmail } from './shop-emails.js';
import { standOrderInclude, type StandOrderRow, standOrderReference, toPublicStandOrder } from './stand-order-views.js';

/** Paymob's merchant_order_id prefix for stand orders. */
export const STAND_REFERENCE_PREFIX = 'stand-';
/** Logos are stored as PNGs no larger than this on either side. */
const LOGO_MAX_SIDE = 2000;

const orderNotFound = () => new NotFoundException({ code: SHOP_ERROR_CODES.STAND_ORDER_NOT_FOUND, message: 'Order not found.' });
const invalidLogo = () =>
  new BadRequestException({ code: SHOP_ERROR_CODES.LOGO_INVALID, message: 'Upload a PNG, JPEG or WebP image up to 3 MB.' });

/** The QR/NFC stand shop: checkout for customers without an account. */
@Injectable()
export class ShopService {
  private readonly logger = new Logger(ShopService.name);
  private readonly websiteUrl: string;
  private readonly dashboardUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly paymob: PaymobService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    @Inject(STAND_ORDER_TOKENS) private readonly tokens: TrackingTokens,
    config: ConfigService<Env, true>,
  ) {
    this.websiteUrl = config.get('WEBSITE_URL', { infer: true }).replace(/\/+$/, '');
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/+$/, '');
  }

  async info(): Promise<ShopInfo> {
    const settings = await this.settings();
    return { prices: STAND_PRICES, deliveryFeePiastres: settings.deliveryFeePiastres, paymentMethods: this.paymentMethods(settings) };
  }

  /** Stores a logo for a later order line, re-encoded as PNG (which also drops metadata and anything hidden in the file). */
  async uploadLogo(file: Buffer | undefined): Promise<UploadedLogo> {
    if (!file?.length || file.length > STAND_LIMITS.logoBytes || !sniffImageType(file)) throw invalidLogo();
    let png: Buffer;
    try {
      png = await sharp(file).rotate().resize(LOGO_MAX_SIDE, LOGO_MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch {
      throw invalidLogo();
    }
    const id = randomUUID();
    const storageKey = `${PRIVATE_PREFIX}/stand-logos/${id}`;
    await this.storage.put(`${storageKey}/logo.png`, png, 'image/png');
    await this.prisma.standLogo.create({ data: { id, storageKey } });
    return { logoId: id };
  }

  /**
   * Places an order. Prices come from STAND_PRICES and the shop settings, never
   * from the client; a total that differs from the one the customer saw is
   * refused (409 PRICE_CHANGED). Online orders get a Paymob checkout.
   */
  async place(idempotencyKey: string, input: z.output<typeof placeStandOrderSchema>): Promise<PlaceStandOrderResponse> {
    const existing = await this.prisma.standOrder.findUnique({ where: { idempotencyKey }, include: standOrderInclude });
    if (existing) return this.placed(existing, existing.status === 'AWAITING_PAYMENT' ? await this.checkoutFor(existing) : null);

    const settings = await this.settings();
    const methods = this.paymentMethods(settings);
    if (!methods.includes(input.paymentMethod)) {
      throw new BadRequestException({
        code: SHOP_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE,
        message: 'This way of paying is not available right now.',
        details: { methods },
      });
    }

    const logoIds = [...new Set(input.lines.flatMap((line) => (line.logoId ? [line.logoId] : [])))];
    const logos = logoIds.length
      ? await this.prisma.standLogo.findMany({ where: { id: { in: logoIds.filter(isUuid) } }, select: { id: true } })
      : [];
    const missing = input.lines.findIndex((line) => line.logoId && !logos.some((logo) => logo.id === line.logoId));
    if (missing !== -1) {
      throw new NotFoundException({
        code: SHOP_ERROR_CODES.LOGO_NOT_FOUND,
        message: 'A logo was not found. Upload it again.',
        details: { line: missing },
      });
    }

    const subtotalPiastres = input.lines.reduce((sum, line) => sum + standUnitPricePiastres(line.nfc) * line.quantity, 0);
    const deliveryFeePiastres = settings.deliveryFeePiastres;
    const totalPiastres = subtotalPiastres + (deliveryFeePiastres ?? 0);
    if (input.expectedTotalPiastres !== totalPiastres) {
      throw new ConflictException({
        code: SHOP_ERROR_CODES.PRICE_CHANGED,
        message: 'The total changed. Check the new total and confirm again.',
        details: { totalPiastres, deliveryFeePiastres },
      });
    }

    const id = randomUUID();
    const online = input.paymentMethod === 'PAYMOB';
    let checkout: { checkoutUrl: string; paymobOrderId: string | null } | null = null;
    if (online) {
      // Before saving: if Paymob cannot open a checkout, no order is left behind.
      checkout = await this.createCheckout({ id, totalPiastres, customerName: input.customer.name, email: input.customer.email, phone: input.customer.phone, city: input.customer.city, address: input.customer.address });
    }

    let order: StandOrderRow;
    try {
      order = await this.prisma.standOrder.create({
        data: {
          id,
          status: online ? 'AWAITING_PAYMENT' : 'NEW',
          paymentMethod: input.paymentMethod,
          customerName: input.customer.name,
          phone: input.customer.phone,
          email: input.customer.email,
          city: input.customer.city,
          address: input.customer.address,
          customerNotes: input.customer.notes,
          language: input.language,
          subtotalPiastres,
          deliveryFeePiastres,
          totalPiastres,
          idempotencyKey,
          paymobOrderId: checkout?.paymobOrderId ?? null,
          lines: {
            create: input.lines.map((line, index) => ({
              sortOrder: index,
              shape: line.shape,
              nfc: line.nfc,
              design: line.design,
              customBackground: line.customColors?.background ?? null,
              customInk: line.customColors?.ink ?? null,
              purpose: line.purpose,
              brand: line.brand,
              caption: line.caption,
              url: line.url,
              logoId: line.logoId,
              numbered: line.numbered,
              startNumber: line.startNumber,
              quantity: line.quantity,
              notes: line.notes,
              unitPricePiastres: standUnitPricePiastres(line.nfc),
            })),
          },
          events: { create: { status: online ? 'AWAITING_PAYMENT' : 'NEW' } },
        },
        include: standOrderInclude,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same checkout submitted twice at once: answer with the order that won.
      const winner = await this.prisma.standOrder.findUnique({ where: { idempotencyKey }, include: standOrderInclude });
      if (!winner) throw error;
      return this.placed(winner, winner.status === 'AWAITING_PAYMENT' ? await this.checkoutFor(winner) : null);
    }

    if (!online) await this.announce(order);
    return this.placed(order, checkout?.checkoutUrl ?? null);
  }

  async track(token: string): Promise<PublicStandOrder> {
    return toPublicStandOrder(await this.orderFor(token));
  }

  /** A fresh Paymob checkout for an online order whose payment is not finished. */
  async pay(token: string): Promise<StandOrderCheckout> {
    const order = await this.orderFor(token);
    if (order.status !== 'AWAITING_PAYMENT') {
      throw new ConflictException({ code: SHOP_ERROR_CODES.NOT_AWAITING_PAYMENT, message: 'This order is not waiting for a payment.' });
    }
    return { checkoutUrl: await this.checkoutFor(order) };
  }

  /**
   * Applies a signed Paymob transaction to its stand order. A payment for an
   * order that was meanwhile cancelled (unpaid for two days) revives it: the
   * money is real. Safe to receive twice.
   */
  async settleOnline(orderId: string, transaction: PaymobTransaction): Promise<void> {
    const order = await this.prisma.standOrder.findUnique({ where: { id: orderId }, include: standOrderInclude });
    if (!order || order.paymentMethod !== 'PAYMOB') {
      this.logger.warn({ orderId, transactionId: transaction.id }, 'Paymob callback for an unknown stand order');
      return;
    }
    if (transaction.pending || !transaction.success) return;
    if (transaction.refunded || transaction.voided) {
      await this.audit.record({
        actorId: null,
        action: transaction.refunded ? 'stand-order.paymob.refunded' : 'stand-order.paymob.voided',
        targetType: 'stand-order',
        targetId: orderId,
        metadata: { transactionId: transaction.id, amountPiastres: transaction.amountPiastres },
      });
      return;
    }
    if (transaction.amountPiastres !== order.totalPiastres || transaction.currency !== 'EGP') {
      this.logger.error({ orderId, transactionId: transaction.id, paid: transaction.amountPiastres, expected: order.totalPiastres }, 'Paymob amount mismatch');
      await this.audit.record({
        actorId: null,
        action: 'stand-order.paymob.mismatch',
        targetType: 'stand-order',
        targetId: orderId,
        metadata: { transactionId: transaction.id, paid: transaction.amountPiastres, currency: transaction.currency, expected: order.totalPiastres },
      });
      return;
    }
    if (order.paymobTransactionId === transaction.id) return;
    if (order.paymentStatus === 'PAID') {
      await this.audit.record({
        actorId: null,
        action: 'stand-order.paymob.duplicate',
        targetType: 'stand-order',
        targetId: orderId,
        metadata: { transactionId: transaction.id, amountPiastres: transaction.amountPiastres },
      });
      return;
    }

    const revived = order.status === 'CANCELLED';
    const claimed = await this.prisma.standOrder.updateMany({
      where: { id: orderId, paymentStatus: 'UNPAID', status: { in: ['AWAITING_PAYMENT', 'CANCELLED'] } },
      data: {
        status: 'NEW',
        paymentStatus: 'PAID',
        paidAt: new Date(),
        paymobTransactionId: transaction.id,
        paymobOrderId: transaction.paymobOrderId || undefined,
      },
    });
    if (claimed.count !== 1) return;
    await this.prisma.standOrderEvent.create({
      data: { orderId, status: 'NEW', note: revived ? 'Paid online after it was cancelled for non-payment.' : 'Paid online.' },
    });
    await this.announce(await this.prisma.standOrder.findUniqueOrThrow({ where: { id: orderId }, include: standOrderInclude }));
  }

  // --- Helpers -------------------------------------------------------------

  /** Cash needs the setting; online also needs Paymob and a known delivery fee (Paymob charges a fixed amount). */
  paymentMethods(settings: ShopSettings): StandPaymentMethod[] {
    const methods: StandPaymentMethod[] = [];
    if (settings.cashOnDelivery) methods.push('CASH_ON_DELIVERY');
    if (settings.onlinePayment && this.paymob.configured && settings.deliveryFeePiastres !== null) methods.push('PAYMOB');
    return methods;
  }

  async settings(): Promise<ShopSettings> {
    return this.prisma.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
  }

  /** The customer's order page on the website. */
  orderUrl(orderId: string): string {
    return `${this.websiteUrl}/shop/orders/${this.tokens.issue(orderId)}`;
  }

  private placed(order: StandOrderRow, checkoutUrl: string | null): PlaceStandOrderResponse {
    return { trackingToken: this.tokens.issue(order.id), order: toPublicStandOrder(order), checkoutUrl };
  }

  private async orderFor(token: string): Promise<StandOrderRow> {
    const orderId = this.tokens.verify(token);
    const order = orderId ? await this.prisma.standOrder.findUnique({ where: { id: orderId }, include: standOrderInclude }) : null;
    if (!order) throw orderNotFound();
    return order;
  }

  private async checkoutFor(order: StandOrderRow): Promise<string> {
    const checkout = await this.createCheckout({
      id: order.id,
      totalPiastres: order.totalPiastres,
      customerName: order.customerName,
      email: order.email,
      phone: order.phone,
      city: order.city,
      address: order.address,
    });
    await this.prisma.standOrder.update({ where: { id: order.id }, data: { paymobOrderId: checkout.paymobOrderId } });
    return checkout.checkoutUrl;
  }

  private async createCheckout(order: { id: string; totalPiastres: number; customerName: string; email: string | null; phone: string; city: string; address: string }) {
    if (!this.paymob.configured) {
      throw new ConflictException({ code: BILLING_ERROR_CODES.ONLINE_PAYMENT_UNAVAILABLE, message: 'Online payment is not available right now.', details: { reason: 'NOT_CONFIGURED' } });
    }
    const [firstName, ...rest] = order.customerName.trim().split(/\s+/);
    try {
      return await this.paymob.createCheckout({
        reference: paymobReference(STAND_REFERENCE_PREFIX, order.id),
        amountPiastres: order.totalPiastres,
        description: 'Bilhanah QR/NFC table stands',
        billing: { firstName: firstName ?? '', lastName: rest.join(' '), email: order.email ?? '', phone: order.phone, city: order.city, street: order.address },
        redirectionUrl: this.orderUrl(order.id),
      });
    } catch (error) {
      if (!(error instanceof PaymobError)) throw error;
      this.logger.warn({ err: error, orderId: order.id }, 'Could not start a Paymob checkout for a stand order');
      throw new ConflictException({
        code: BILLING_ERROR_CODES.ONLINE_PAYMENT_UNAVAILABLE,
        message: 'The payment page could not be opened. Try again in a moment, or choose cash on delivery.',
        details: { reason: 'PROVIDER_ERROR' },
      });
    }
  }

  /** Emails the customer and administrators about an order that now needs handling. */
  private async announce(order: StandOrderRow): Promise<void> {
    const facts = {
      reference: standOrderReference(order.number),
      customerName: order.customerName,
      email: order.email,
      language: order.language,
      totalPiastres: order.totalPiastres,
      deliveryFeePiastres: order.deliveryFeePiastres,
      paymentMethod: order.paymentMethod,
      stands: order.lines.reduce((sum, line) => sum + line.quantity, 0),
      city: order.city,
    };
    const customerEmail = standOrderPlacedEmail(facts, this.orderUrl(order.id));
    if (customerEmail) this.mailer.sendInBackground(customerEmail, 'stand-order-placed');
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { email: true, fullName: true, preferredLanguage: true },
    });
    for (const admin of admins) {
      this.mailer.sendInBackground(newStandOrderAdminEmail(admin, facts, `${this.dashboardUrl}/admin/stand-orders/${order.id}`), 'stand-order-admin');
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
