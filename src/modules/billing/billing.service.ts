import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AdminEntitlement,
  BILLING_ERROR_CODES,
  BILLING_MONTHS,
  type BillingSummary,
  type grantEntitlementSchema,
  type OwnerPayment,
  PAYMENT_METHODS,
  type PaymentInstructions,
  type PaymentMethod,
  PLAN_FEATURES,
  RESTAURANT_ERROR_CODES,
  type submitPaymentSchema,
} from '@bilhanah/contracts';
import type { Entitlement, PaymentSettings, Prisma, SubscriptionPayment } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MediaService } from '../media/media.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import {
  newPaymentAdminEmail,
  paymentApprovedEmail,
  paymentReceivedEmail,
  paymentRejectedEmail,
} from './billing-emails.js';
import { addMonths, nextPeriodStart } from './periods.js';

type Tx = Prisma.TransactionClient;
type PaymentRow = SubscriptionPayment & { entitlement: Pick<Entitlement, 'startsAt' | 'endsAt'> | null };

const paymentNotFound = () =>
  new NotFoundException({ code: BILLING_ERROR_CODES.PAYMENT_NOT_FOUND, message: 'Payment not found.' });
const notPending = () =>
  new ConflictException({ code: BILLING_ERROR_CODES.PAYMENT_NOT_PENDING, message: 'This payment has already been handled.' });

/** Which details make a payment method usable. */
const METHOD_DETAILS: Record<PaymentMethod, (settings: PaymentSettings) => boolean> = {
  INSTAPAY: (settings) => !!settings.instapayAddress,
  VODAFONE_CASH: (settings) => !!settings.vodafoneCashNumber,
  BANK_TRANSFER: (settings) => !!settings.bankAccountNumber && !!settings.bankName,
};

export function toInstructions(settings: PaymentSettings): PaymentInstructions {
  return {
    instapayAddress: settings.instapayAddress,
    vodafoneCashNumber: settings.vodafoneCashNumber,
    bankName: settings.bankName,
    bankAccountName: settings.bankAccountName,
    bankAccountNumber: settings.bankAccountNumber,
    notesAr: settings.notesAr,
    notesEn: settings.notesEn,
  };
}

export function toOwnerPayment(payment: PaymentRow): OwnerPayment {
  return {
    id: payment.id,
    planCode: payment.planCode,
    months: payment.months,
    amountPiastres: payment.amountPiastres,
    method: payment.method,
    reference: payment.reference,
    payerName: payment.payerName,
    status: payment.status,
    hasProof: payment.proofId !== null,
    rejectionReason: payment.rejectionReason,
    createdAt: payment.createdAt.toISOString(),
    reviewedAt: payment.reviewedAt?.toISOString() ?? null,
    period: payment.entitlement
      ? { startsAt: payment.entitlement.startsAt.toISOString(), endsAt: payment.entitlement.endsAt.toISOString() }
      : null,
  };
}

/**
 * Subscriptions paid by manual transfer: owners submit the transfer details,
 * an administrator approves (creating a paid period) or rejects them.
 */
@Injectable()
export class BillingService {
  private readonly dashboardUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    config: ConfigService<Env, true>,
  ) {
    this.dashboardUrl = config.get('DASHBOARD_URL', { infer: true }).replace(/\/$/, '');
  }

  // --- Owners --------------------------------------------------------------

  async summary(ownerId: string, now = new Date()): Promise<BillingSummary> {
    const restaurant = await this.restaurantFor(ownerId);
    const [plans, settings, entitlements, payments] = await Promise.all([
      this.prisma.plan.findMany({ orderBy: { priceMonthlyPiastres: 'asc' } }),
      this.paymentSettings(),
      this.prisma.entitlement.findMany({ where: { restaurantId: restaurant.id }, select: { endsAt: true } }),
      this.prisma.subscriptionPayment.findMany({
        where: { restaurantId: restaurant.id },
        orderBy: { createdAt: 'desc' },
        take: 24,
        include: { entitlement: { select: { startsAt: true, endsAt: true } } },
      }),
    ]);
    const ownerPayments = payments.map(toOwnerPayment);
    return {
      access: await this.subscriptions.accessFor(restaurant, now),
      plans: plans.map((plan) => ({ code: plan.code, priceMonthlyPiastres: plan.priceMonthlyPiastres, features: PLAN_FEATURES[plan.code] })),
      months: BILLING_MONTHS,
      instructions: toInstructions(settings),
      availableMethods: PAYMENT_METHODS.filter((method) => METHOD_DETAILS[method](settings)),
      nextPeriodStartsAt: nextPeriodStart(entitlements, now).toISOString(),
      pendingPayment: ownerPayments.find((payment) => payment.status === 'PENDING') ?? null,
      payments: ownerPayments,
    };
  }

  /** Records a transfer for review. The amount is computed here from the current plan price. */
  async submit(ownerId: string, input: z.output<typeof submitPaymentSchema>): Promise<OwnerPayment> {
    const restaurant = await this.restaurantFor(ownerId, { forWrite: true });
    const settings = await this.paymentSettings();
    if (!METHOD_DETAILS[input.method](settings)) {
      throw new BadRequestException({
        code: BILLING_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE,
        message: 'This payment method is not available right now.',
      });
    }
    if (input.proofId) await this.media.assertUsable(restaurant.id, input.proofId, 'PAYMENT_PROOF');
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { code: input.planCode } });

    let payment: PaymentRow;
    try {
      payment = await this.prisma.subscriptionPayment.create({
        data: {
          restaurantId: restaurant.id,
          planCode: input.planCode,
          months: input.months,
          amountPiastres: plan.priceMonthlyPiastres * input.months,
          method: input.method,
          reference: input.reference,
          payerName: input.payerName ?? null,
          proofId: input.proofId ?? null,
        },
        include: { entitlement: { select: { startsAt: true, endsAt: true } } },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({
        code: BILLING_ERROR_CODES.PAYMENT_ALREADY_PENDING,
        message: 'A payment is already waiting for review. Cancel it to send different details.',
      });
    }

    this.mailer.sendInBackground(paymentReceivedEmail(restaurant.owner, payment, this.dashboardUrl), 'payment-received');
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { email: true, fullName: true, preferredLanguage: true },
    });
    for (const admin of admins) {
      this.mailer.sendInBackground(newPaymentAdminEmail(admin, restaurant, payment, this.dashboardUrl), 'payment-admin-alert');
    }
    return toOwnerPayment(payment);
  }

  /** Withdraws the owner's own payment while it is still waiting for review. */
  async cancel(ownerId: string, paymentId: string): Promise<void> {
    const restaurant = await this.restaurantFor(ownerId);
    const cancelled = await this.prisma.subscriptionPayment.updateMany({
      where: { id: paymentId, restaurantId: restaurant.id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 1) return;
    const exists = await this.prisma.subscriptionPayment.count({ where: { id: paymentId, restaurantId: restaurant.id } });
    throw exists ? notPending() : paymentNotFound();
  }

  /** The receipt image of one of the owner's payments. */
  async ownerProof(ownerId: string, paymentId: string): Promise<Buffer> {
    const restaurant = await this.restaurantFor(ownerId);
    return this.proofOf({ id: paymentId, restaurantId: restaurant.id });
  }

  // --- Administrators ------------------------------------------------------

  async adminProof(paymentId: string): Promise<Buffer> {
    return this.proofOf({ id: paymentId });
  }

  /** Confirms a transfer and creates the paid period, starting when current coverage ends. */
  async approve(adminId: string, paymentId: string, ipAddress?: string): Promise<OwnerPayment> {
    const now = new Date();
    const { payment, period } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!current) throw paymentNotFound();
      await lockRestaurant(tx, current.restaurantId);
      const claimed = await tx.subscriptionPayment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedById: adminId, reviewedAt: now },
      });
      if (claimed.count !== 1) throw notPending();

      const entitlement = await this.createPaidPeriod(tx, current.restaurantId, current.planCode, current.months, now);
      const payment = await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: { entitlementId: entitlement.id },
        include: { entitlement: { select: { startsAt: true, endsAt: true } } },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'payment.approve',
          targetType: 'payment',
          targetId: paymentId,
          metadata: { restaurantId: current.restaurantId, planCode: current.planCode, months: current.months, endsAt: entitlement.endsAt.toISOString() },
          ipAddress,
        },
        tx,
      );
      return { payment, period: entitlement };
    });

    const owner = await this.ownerOf(payment.restaurantId);
    this.mailer.sendInBackground(paymentApprovedEmail(owner, payment, period, this.dashboardUrl), 'payment-approved');
    return toOwnerPayment(payment);
  }

  async reject(adminId: string, paymentId: string, reason: string, ipAddress?: string): Promise<OwnerPayment> {
    const payment = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.subscriptionPayment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'REJECTED', reviewedById: adminId, reviewedAt: new Date(), rejectionReason: reason },
      });
      if (claimed.count !== 1) {
        throw (await tx.subscriptionPayment.count({ where: { id: paymentId } })) ? notPending() : paymentNotFound();
      }
      const payment = await tx.subscriptionPayment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { entitlement: { select: { startsAt: true, endsAt: true } } },
      });
      await this.audit.record(
        { actorId: adminId, action: 'payment.reject', targetType: 'payment', targetId: paymentId, metadata: { restaurantId: payment.restaurantId, reason }, ipAddress },
        tx,
      );
      return payment;
    });

    const owner = await this.ownerOf(payment.restaurantId);
    this.mailer.sendInBackground(paymentRejectedEmail(owner, payment, reason, this.dashboardUrl), 'payment-rejected');
    return toOwnerPayment(payment);
  }

  /** A paid period granted by hand (cash, corrections, goodwill), after current coverage. */
  async grant(
    adminId: string,
    restaurantId: string,
    input: z.output<typeof grantEntitlementSchema>,
    ipAddress?: string,
  ): Promise<AdminEntitlement> {
    const admin = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { fullName: true } });
    const entitlement = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.restaurant.count({ where: { id: restaurantId } }))) {
        throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
      }
      await lockRestaurant(tx, restaurantId);
      const entitlement = await this.createPaidPeriod(tx, restaurantId, input.planCode, input.months, new Date(), {
        grantedById: adminId,
        note: input.note,
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'entitlement.grant',
          targetType: 'restaurant',
          targetId: restaurantId,
          metadata: { planCode: input.planCode, months: input.months, note: input.note, endsAt: entitlement.endsAt.toISOString() },
          ipAddress,
        },
        tx,
      );
      return entitlement;
    });
    return {
      id: entitlement.id,
      kind: 'PAID',
      planCode: entitlement.planCode,
      startsAt: entitlement.startsAt.toISOString(),
      endsAt: entitlement.endsAt.toISOString(),
      note: entitlement.note,
      grantedBy: admin.fullName,
      paymentId: null,
    };
  }

  // --- Helpers -------------------------------------------------------------

  private async createPaidPeriod(
    tx: Tx,
    restaurantId: string,
    planCode: Entitlement['planCode'],
    months: number,
    now: Date,
    extra: { grantedById?: string; note?: string } = {},
  ): Promise<Entitlement> {
    const periods = await tx.entitlement.findMany({ where: { restaurantId }, select: { endsAt: true } });
    const startsAt = nextPeriodStart(periods, now);
    return tx.entitlement.create({
      data: { restaurantId, kind: 'PAID', planCode, startsAt, endsAt: addMonths(startsAt, months), ...extra },
    });
  }

  private async proofOf(where: { id: string; restaurantId?: string }): Promise<Buffer> {
    const payment = await this.prisma.subscriptionPayment.findFirst({ where, include: { proof: true } });
    if (!payment) throw paymentNotFound();
    const image = payment.proof ? await this.media.readImage(payment.proof) : null;
    if (!image) throw new NotFoundException({ code: BILLING_ERROR_CODES.PAYMENT_NOT_FOUND, message: 'This payment has no receipt.' });
    return image;
  }

  private async paymentSettings(): Promise<PaymentSettings> {
    return this.prisma.paymentSettings.findUniqueOrThrow({ where: { id: 1 } });
  }

  private async restaurantFor(ownerId: string, { forWrite = false } = {}) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      include: { owner: { select: { email: true, fullName: true, preferredLanguage: true } } },
    });
    if (!restaurant) {
      throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    }
    if (forWrite && restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED,
        message: 'This restaurant is suspended. Please contact Bilhanah support.',
      });
    }
    return restaurant;
  }

  private async ownerOf(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { owner: { select: { email: true, fullName: true, preferredLanguage: true } } },
    });
    return restaurant.owner;
  }
}

/** Serializes period changes for one restaurant, so concurrent approvals and grants cannot overlap. */
async function lockRestaurant(tx: Tx, restaurantId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM restaurants WHERE id = ${restaurantId}::uuid FOR UPDATE`;
}
