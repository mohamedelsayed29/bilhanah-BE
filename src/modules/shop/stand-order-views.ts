import type { AdminStandOrder, ProductShape, PublicStandOrder, ShopProduct, StandDesign, StandOrderLine, StandPurpose } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';

export const standOrderInclude = {
  lines: { orderBy: { sortOrder: 'asc' } },
  events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { fullName: true } } } },
} satisfies Prisma.StandOrderInclude;

export type StandOrderRow = Prisma.StandOrderGetPayload<{ include: typeof standOrderInclude }>;

export const standOrderReference = (number: number) => `S-${number}`;

function toLine(line: StandOrderRow['lines'][number]): StandOrderLine {
  return {
    id: line.id,
    product: line.product as ShopProduct,
    shape: line.shape as ProductShape,
    nfc: line.nfc,
    design: line.design as StandDesign,
    customColors: line.customBackground && line.customInk ? { background: line.customBackground, ink: line.customInk } : null,
    purpose: line.purpose as StandPurpose,
    brand: line.brand,
    caption: line.caption,
    url: line.url,
    hasLogo: line.logoId !== null,
    numbered: line.numbered,
    startNumber: line.startNumber,
    quantity: line.quantity,
    notes: line.notes,
    unitPricePiastres: line.unitPricePiastres,
    lineTotalPiastres: line.unitPricePiastres * line.quantity,
  };
}

export function toPublicStandOrder(order: StandOrderRow): PublicStandOrder {
  return {
    reference: standOrderReference(order.number),
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    lines: order.lines.map(toLine),
    subtotalPiastres: order.subtotalPiastres,
    deliveryFeePiastres: order.deliveryFeePiastres,
    totalPiastres: order.totalPiastres,
    customerName: order.customerName,
    city: order.city,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toAdminStandOrder(order: StandOrderRow): AdminStandOrder {
  return {
    ...toPublicStandOrder(order),
    id: order.id,
    phone: order.phone,
    email: order.email,
    address: order.address,
    customerNotes: order.customerNotes,
    adminNote: order.adminNote,
    language: order.language,
    paidAt: order.paidAt?.toISOString() ?? null,
    statusHistory: order.events.map((event) => ({
      status: event.status,
      at: event.createdAt.toISOString(),
      by: event.actor?.fullName ?? null,
      note: event.note,
    })),
  };
}
