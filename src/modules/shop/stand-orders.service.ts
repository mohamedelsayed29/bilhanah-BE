import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AdminStandOrder,
  type Paginated,
  SHOP_ERROR_CODES,
  type ShopSettings,
  type shopSettingsSchema,
  STAND_ORDER_TRANSITIONS,
  type standOrdersQuerySchema,
  type updateStandOrderSchema,
  type updateStandOrderStatusSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MailerService } from '../../infrastructure/email/mailer.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { standOrderStatusEmail } from './shop-emails.js';
import { ShopService } from './shop.service.js';
import { standOrderInclude, standOrderReference, toAdminStandOrder } from './stand-order-views.js';

const orderNotFound = () => new NotFoundException({ code: SHOP_ERROR_CODES.STAND_ORDER_NOT_FOUND, message: 'Order not found.' });

/** Stand orders being made, shipped and delivered: the administrators' fulfilment queue. */
@Injectable()
export class StandOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly shop: ShopService,
  ) {}

  async list(query: z.output<typeof standOrdersQuerySchema>): Promise<Paginated<AdminStandOrder>> {
    const where: Prisma.StandOrderWhereInput = {};
    if (query.status === 'open') where.status = { in: ['NEW', 'CONFIRMED', 'IN_PRODUCTION', 'SHIPPED'] };
    else if (query.status) where.status = query.status;
    const text = query.query?.trim();
    if (text) {
      const number = /^s?-?(\d{1,9})$/i.exec(text)?.[1];
      const digits = text.replace(/[\s().+-]/g, '');
      where.OR = [
        ...(number ? [{ number: Number(number) }] : []),
        { customerName: { contains: text, mode: 'insensitive' } },
        { email: { contains: text, mode: 'insensitive' } },
        ...(/^\d{4,}$/.test(digits) ? [{ phone: { contains: digits } }] : []),
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.standOrder.findMany({
        where,
        include: standOrderInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.standOrder.count({ where }),
    ]);
    return { items: items.map(toAdminStandOrder), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<AdminStandOrder> {
    const order = await this.prisma.standOrder.findUnique({ where: { id }, include: standOrderInclude });
    if (!order) throw orderNotFound();
    return toAdminStandOrder(order);
  }

  /** Moves an order along STAND_ORDER_TRANSITIONS, records it, and tells the customer. */
  async updateStatus(adminId: string, id: string, input: z.output<typeof updateStandOrderStatusSchema>, ipAddress?: string): Promise<AdminStandOrder> {
    const current = await this.prisma.standOrder.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw orderNotFound();
    const allowed = STAND_ORDER_TRANSITIONS[current.status];
    if (!allowed.includes(input.status)) {
      throw new ConflictException({
        code: SHOP_ERROR_CODES.INVALID_STATUS_CHANGE,
        message: `An order that is ${current.status.toLowerCase()} cannot become ${input.status.toLowerCase()}.`,
        details: { from: current.status, to: input.status, allowed },
      });
    }
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-swap, so two administrators cannot both move the same order.
      const changed = await tx.standOrder.updateMany({ where: { id, status: current.status }, data: { status: input.status } });
      if (changed.count !== 1) {
        throw new ConflictException({
          code: SHOP_ERROR_CODES.INVALID_STATUS_CHANGE,
          message: 'This order was just updated by someone else.',
          details: { from: current.status, to: input.status, allowed },
        });
      }
      await tx.standOrderEvent.create({ data: { orderId: id, status: input.status, note: input.note ?? null, actorId: adminId } });
      await this.audit.record(
        { actorId: adminId, action: 'stand-order.status', targetType: 'stand-order', targetId: id, metadata: { from: current.status, to: input.status, note: input.note ?? null }, ipAddress },
        tx,
      );
    });

    const order = await this.prisma.standOrder.findUniqueOrThrow({ where: { id }, include: standOrderInclude });
    const email = standOrderStatusEmail(
      {
        reference: standOrderReference(order.number),
        customerName: order.customerName,
        email: order.email,
        language: order.language,
        totalPiastres: order.totalPiastres,
        deliveryFeePiastres: order.deliveryFeePiastres,
        paymentMethod: order.paymentMethod,
        stands: order.lines.reduce((sum, line) => sum + line.quantity, 0),
      },
      input.status,
      input.note ?? null,
      this.shop.orderUrl(order.id),
    );
    if (email) this.mailer.sendInBackground(email, 'stand-order-status');
    return toAdminStandOrder(order);
  }

  /** Internal notes, and cash collected on delivery. */
  async update(adminId: string, id: string, input: z.output<typeof updateStandOrderSchema>, ipAddress?: string): Promise<AdminStandOrder> {
    const order = await this.prisma.standOrder.findUnique({ where: { id }, select: { paymentStatus: true, paymentMethod: true } });
    if (!order) throw orderNotFound();
    const data: Prisma.StandOrderUpdateInput = {};
    if (input.adminNote !== undefined) data.adminNote = input.adminNote || null;
    if (input.paymentStatus && input.paymentStatus !== order.paymentStatus) {
      // Online payments are recorded by Paymob, not by hand.
      if (order.paymentMethod !== 'CASH_ON_DELIVERY') {
        throw new ConflictException({ code: SHOP_ERROR_CODES.INVALID_STATUS_CHANGE, message: 'Online payments are recorded by Paymob.' });
      }
      data.paymentStatus = input.paymentStatus;
      data.paidAt = input.paymentStatus === 'PAID' ? new Date() : null;
    }
    await this.prisma.standOrder.update({ where: { id }, data });
    if (data.paymentStatus) {
      await this.audit.record({ actorId: adminId, action: 'stand-order.payment', targetType: 'stand-order', targetId: id, metadata: { paymentStatus: data.paymentStatus }, ipAddress });
    }
    return this.get(id);
  }

  /** A line's uploaded logo, as PNG. */
  async logo(id: string, lineId: string): Promise<Buffer> {
    const line = await this.prisma.standOrderLine.findFirst({ where: { id: lineId, orderId: id }, include: { logo: true } });
    const image = line?.logo ? await this.storage.get(`${line.logo.storageKey}/logo.png`) : null;
    if (!image) throw new NotFoundException({ code: SHOP_ERROR_CODES.LOGO_NOT_FOUND, message: 'This line has no logo.' });
    return image;
  }

  async settings(): Promise<ShopSettings> {
    const settings = await this.shop.settings();
    return { deliveryFeePiastres: settings.deliveryFeePiastres, cashOnDelivery: settings.cashOnDelivery, onlinePayment: settings.onlinePayment };
  }

  async updateSettings(adminId: string, input: z.output<typeof shopSettingsSchema>, ipAddress?: string): Promise<ShopSettings> {
    const before = await this.settings();
    await this.prisma.$transaction(async (tx) => {
      await tx.shopSettings.update({ where: { id: 1 }, data: input });
      await this.audit.record({ actorId: adminId, action: 'settings.shop', targetType: 'settings', targetId: 'shop', metadata: { from: before, to: input }, ipAddress }, tx);
    });
    return this.settings();
  }
}
