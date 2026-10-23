import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { StorageService } from '../infrastructure/storage/storage.service.js';

const HOUR_MS = 60 * 60 * 1000;
/** An online subscription checkout not finished within a day is abandoned. */
const CHECKOUT_HOURS = 24;
/** An online stand order not paid within two days is cancelled. */
const STAND_PAYMENT_HOURS = 48;
/** Logos uploaded at checkout but never ordered. */
const UNUSED_LOGO_HOURS = 48;

export type ShopPurgeResult = { abandonedCheckouts: number; unpaidStandOrders: number; unusedLogos: number };

/** Housekeeping for online payments and the stand shop. A late Paymob payment still counts (see settleOnline). */
@Injectable()
export class ShopMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async run(now = new Date()): Promise<ShopPurgeResult> {
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);

    const abandonedCheckouts = await this.prisma.subscriptionPayment.updateMany({
      where: { status: 'AWAITING_PAYMENT', createdAt: { lte: ago(CHECKOUT_HOURS) } },
      data: { status: 'CANCELLED' },
    });

    const unpaid = await this.prisma.standOrder.findMany({
      where: { status: 'AWAITING_PAYMENT', createdAt: { lte: ago(STAND_PAYMENT_HOURS) } },
      select: { id: true },
    });
    let unpaidStandOrders = 0;
    for (const { id } of unpaid) {
      const cancelled = await this.prisma.standOrder.updateMany({ where: { id, status: 'AWAITING_PAYMENT' }, data: { status: 'CANCELLED' } });
      if (!cancelled.count) continue;
      await this.prisma.standOrderEvent.create({ data: { orderId: id, status: 'CANCELLED', note: 'ما اتدفعش خلال يومين · Not paid within two days.' } });
      unpaidStandOrders += 1;
    }

    const logos = await this.prisma.standLogo.findMany({
      where: { createdAt: { lte: ago(UNUSED_LOGO_HOURS) }, lines: { none: {} } },
      select: { id: true, storageKey: true },
    });
    for (const logo of logos) {
      await this.storage.deletePrefix(logo.storageKey);
      await this.prisma.standLogo.deleteMany({ where: { id: logo.id, lines: { none: {} } } });
    }
    return { abandonedCheckouts: abandonedCheckouts.count, unpaidStandOrders, unusedLogos: logos.length };
  }
}
