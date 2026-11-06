import {
  type DinerReview,
  type OwnerReview,
  type OwnerReviewListItem,
  type PublicReview,
  reviewDisplayName,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { MediaService } from '../media/media.service.js';
import { isLowRating, ratingsOf, resolveTags, type ReviewRules } from './reviews-rules.js';

/** What the inbox and the realtime events read of a review. */
export const reviewListInclude = {
  branch: { select: { id: true, name: true, slug: true } },
  order: { select: { id: true, number: true } },
  repliedBy: { select: { fullName: true } },
  moderatedBy: { select: { fullName: true } },
  followUpAssignee: { select: { fullName: true } },
  _count: { select: { dishRatings: true, photos: true } },
} satisfies Prisma.ReviewInclude;

export type ReviewListRow = Prisma.ReviewGetPayload<{ include: typeof reviewListInclude }>;

export const reviewDetailInclude = {
  ...reviewListInclude,
  order: {
    select: {
      id: true, number: true, type: true, placedAt: true, subtotalPiastres: true,
      items: { orderBy: { sortOrder: 'asc' }, select: { id: true, nameAr: true, nameEn: true, variantNameAr: true, variantNameEn: true, quantity: true, unitPricePiastres: true } },
    },
  },
  dishRatings: { orderBy: [{ orderItem: { sortOrder: 'asc' } }, { createdAt: 'asc' }] },
  photos: { orderBy: { sortOrder: 'asc' }, include: { media: true } },
  events: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ReviewInclude;

export type ReviewDetailRow = Prisma.ReviewGetPayload<{ include: typeof reviewDetailInclude }>;

/** What the public page reads of a published review. */
export const publicReviewInclude = {
  branch: { select: { slug: true, name: true } },
  dishRatings: { orderBy: [{ orderItem: { sortOrder: 'asc' } }, { createdAt: 'asc' }], select: { nameAr: true, nameEn: true, rating: true } },
  photos: { orderBy: { sortOrder: 'asc' }, include: { media: true } },
} satisfies Prisma.ReviewInclude;

export type PublicReviewRow = Prisma.ReviewGetPayload<{ include: typeof publicReviewInclude }>;

/** An inbox row. The contact phone only when the caller may see it (reviews.respond); never in realtime events. */
export function toListItem(row: ReviewListRow, rules: ReviewRules, showPhone: boolean): OwnerReviewListItem {
  return {
    id: row.id,
    branchId: row.branch.id,
    branchName: row.branch.name,
    orderId: row.order?.id ?? null,
    orderNumber: row.order?.number ?? null,
    verified: row.verified,
    source: row.source,
    tableLabel: row.tableLabel,
    overall: row.overall,
    ratings: ratingsOf(row),
    tags: resolveTags(row.tags, rules.tags),
    comment: row.comment,
    authorName: row.authorName,
    displayName: reviewDisplayName(row.authorName, rules.displayName),
    hasContact: row.contactConsent && row.contactPhone !== null,
    contactPhone: showPhone && row.contactConsent ? row.contactPhone : null,
    language: row.language,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    hidden: row.status === 'HIDDEN' && row.hiddenReason && row.hiddenAt
      ? { reason: row.hiddenReason, at: row.hiddenAt.toISOString(), byName: row.moderatedBy?.fullName ?? null }
      : null,
    reply: row.replyText && row.repliedAt
      ? { text: row.replyText, at: row.repliedAt.toISOString(), updatedAt: (row.replyUpdatedAt ?? row.repliedAt).toISOString(), byName: row.repliedBy?.fullName ?? null }
      : null,
    followUp: row.followUpStatus
      ? { status: row.followUpStatus, assigneeId: row.followUpAssigneeId, assigneeName: row.followUpAssignee?.fullName ?? null, updatedAt: (row.followUpUpdatedAt ?? row.updatedAt).toISOString() }
      : null,
    lowRating: isLowRating(row.overall, rules.alertBelowStars),
    dishCount: row._count.dishRatings,
    photoCount: row._count.photos,
    edited: row.editCount > 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOwnerReview(row: ReviewDetailRow, rules: ReviewRules, showPhone: boolean, media: MediaService): OwnerReview {
  const { order } = row;
  return {
    ...toListItem({ ...row, order: order && { id: order.id, number: order.number } }, rules, showPhone),
    order: order && {
      id: order.id,
      number: order.number,
      type: order.type,
      placedAt: order.placedAt.toISOString(),
      subtotalPiastres: order.subtotalPiastres,
      items: order.items.map((item) => ({
        id: item.id,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        variantNameAr: item.variantNameAr,
        variantNameEn: item.variantNameEn,
        quantity: item.quantity,
        lineTotalPiastres: item.unitPricePiastres * item.quantity,
      })),
    },
    dishes: row.dishRatings.map((dish) => ({ orderItemId: dish.orderItemId, menuItemId: dish.menuItemId, nameAr: dish.nameAr, nameEn: dish.nameEn, rating: dish.rating })),
    photos: row.photos.map(({ media: photo }) => {
      const set = media.toImageSet(photo);
      return { id: photo.id, width: photo.width, height: photo.height, sources: set.sources, privateUrl: `/v1/reviews/${row.id}/photos/${photo.id}` };
    }),
    history: row.events.map((event) => ({
      kind: event.kind,
      at: event.createdAt.toISOString(),
      actorName: event.actorName,
      followUpStatus: event.followUpStatus,
      assigneeName: event.assigneeName,
      note: event.note,
      previousOverall: event.previousOverall,
    })),
  };
}

export function toPublicReview(row: PublicReviewRow, rules: ReviewRules, media: MediaService): PublicReview {
  return {
    id: row.id,
    overall: row.overall,
    ratings: ratingsOf(row),
    tags: resolveTags(row.tags, rules.tags).filter((tag) => rules.tags.some((known) => known.code === tag.code)),
    comment: row.comment,
    displayName: reviewDisplayName(row.authorName, rules.displayName),
    verified: row.verified,
    branch: { slug: row.branch.slug, name: row.branch.name },
    dishes: row.dishRatings.map((dish) => ({ nameAr: dish.nameAr, nameEn: dish.nameEn, rating: dish.rating })),
    photos: row.photos.map(({ media: photo }) => media.toImageSet(photo)).filter((set) => set.sources.length > 0),
    reply: row.replyText && row.repliedAt ? { text: row.replyText, at: (row.replyUpdatedAt ?? row.repliedAt).toISOString() } : null,
    createdAt: row.createdAt.toISOString(),
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
  };
}

/** What the diner's own view reads of their review. */
export const dinerReviewInclude = {
  dishRatings: { orderBy: [{ orderItem: { sortOrder: 'asc' } }, { createdAt: 'asc' }] },
  photos: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ReviewInclude;

type DinerRow = Prisma.ReviewGetPayload<{ include: typeof dinerReviewInclude }>;

export function toDinerReview(row: DinerRow): DinerReview {
  return {
    overall: row.overall,
    ratings: ratingsOf(row),
    dishes: row.dishRatings.flatMap((dish) => (dish.orderItemId ? [{ orderItemId: dish.orderItemId, rating: dish.rating }] : [])),
    tags: row.tags,
    comment: row.comment,
    photoIds: row.photos.map((photo) => photo.mediaId),
    name: row.authorName,
    hasContact: row.contactConsent && row.contactPhone !== null,
    language: row.language,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
