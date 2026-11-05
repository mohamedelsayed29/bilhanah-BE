import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  type addTableItemSchema,
  type joinSharedTableSchema,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  ORDER_LIMITS,
  type OwnerTableSession,
  type submitTableSessionSchema,
  type SubmitTableSessionResponse,
  TABLE_SESSION_ERROR_CODES as CODES,
  TABLE_SESSION_LIMITS,
  type TableSessionCloseReason,
  type TableSessionItem,
  type tableSessionStatsQuerySchema,
  type TableSessionStats,
  type TableSessionStatus,
  type TableSessionUpdatedEvent,
  type TableSessionView,
  type updateTableItemSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { OrdersService, SharedCartChanged } from '../orders/orders.service.js';
import { TrackingTokens } from '../orders/tracking-token.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { TABLE_SESSION_TOKENS } from '../service-requests/session-token.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { TABLE_GUEST_TOKENS } from './guest-token.js';
import { expireIdle, liveSessionWhere, openSessionFor } from './session-lifecycle.js';

type Tx = Prisma.TransactionClient;

const fail = (kind: 'bad' | 'forbidden' | 'conflict' | 'notFound' | 'unauthorized', code: string, message: string, details?: Record<string, unknown>) => {
  const body = { code, message, ...(details && { details }) };
  switch (kind) {
    case 'bad': return new BadRequestException(body);
    case 'forbidden': return new ForbiddenException(body);
    case 'conflict': return new ConflictException(body);
    case 'notFound': return new NotFoundException(body);
    default: return new UnauthorizedException(body);
  }
};
const guestInvalid = () => fail('unauthorized', CODES.GUEST_INVALID, 'Scan the table’s code again to join its order.');
const itemNotFound = () => fail('notFound', CODES.ITEM_NOT_FOUND, 'This dish is not in the table’s order.');

const sessionInclude = {
  table: { select: { id: true, label: true, publicCode: true, isActive: true } },
  branch: true,
  restaurant: true,
} satisfies Prisma.TableSessionInclude;
type SessionRow = Prisma.TableSessionGetPayload<{ include: typeof sessionInclude }>;
type GuestContext = { guestId: string; session: SessionRow };

/** A guest as staff screens and orders show them: their name, or "ضيف 2". */
export const guestLabel = (guest: { number: number; displayName: string | null }) => guest.displayName ?? `ضيف ${guest.number}`;

/**
 * Shared table sessions: every phone at a table joins the table's one open session as a guest,
 * adds its own dishes to the shared order, and sends them (its own, or the whole table's) as a
 * restaurant order. Prices and availability are checked when a dish is added and again when sent;
 * dishes change through compare-and-swap on their version, and leave the cart only together with
 * the order that contains them.
 */
@Injectable()
export class TableSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly subscriptions: SubscriptionsService,
    private readonly realtime: RealtimeService,
    private readonly orders: OrdersService,
    private readonly trackingTokens: TrackingTokens,
    @Inject(TABLE_GUEST_TOKENS) private readonly guestTokens: TrackingTokens,
    @Inject(TABLE_SESSION_TOKENS) private readonly sessionTokens: TrackingTokens,
  ) {}

  // --- Guests ------------------------------------------------------------------------------------

  /** Joins the table's open session (starting it if needed); a phone that was already a guest there rejoins as itself. */
  async join(rawSubdomain: string, code: string, input: z.output<typeof joinSharedTableSchema>, now = new Date()): Promise<TableSessionView> {
    const table = await this.prisma.table.findFirst({
      where: { publicCode: code, isActive: true, branch: { isActive: true }, restaurant: { subdomain: normalizeSubdomain(rawSubdomain) } },
      include: { branch: true, restaurant: true },
    });
    if (!table) throw fail('notFound', ORDER_ERROR_CODES.TABLE_NOT_FOUND, 'This table was not found. Scan the QR code again.');
    await this.ensureAvailable(table.restaurant, table.branch, now);

    const heldId = input.guestToken ? this.guestTokens.verify(input.guestToken) : null;
    const held = heldId
      ? await this.prisma.tableGuest.findFirst({ where: { id: heldId, session: { tableId: table.id, ...liveSessionWhere(now) } } })
      : null;
    if (held) {
      await this.prisma.$transaction([
        this.prisma.tableGuest.update({ where: { id: held.id }, data: { lastSeenAt: now, ...(input.displayName && { displayName: input.displayName }) } }),
        this.prisma.tableSession.update({ where: { id: held.sessionId }, data: { lastActivityAt: now, ...(input.displayName && { version: { increment: 1 } }) } }),
      ]);
      if (input.displayName) this.emit(held.sessionId, 'guests', 'ACTIVE');
      return this.view(held.id, now);
    }

    const session = await openSessionFor(this.prisma, table, now);
    const guest = await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, session.id);
      if (status === 'CLOSED') throw fail('conflict', CODES.SESSION_CLOSED, 'This table’s session just closed. Scan again.', { reason: 'SETTLED' });
      const guests = await tx.tableGuest.aggregate({ where: { sessionId: session.id }, _count: { _all: true }, _max: { number: true } });
      if (guests._count._all >= TABLE_SESSION_LIMITS.guests) throw fail('conflict', CODES.GUESTS_FULL, 'This table has the most guests allowed.');
      const created = await tx.tableGuest.create({
        data: { sessionId: session.id, number: (guests._max.number ?? 0) + 1, displayName: input.displayName ?? null, joinedAt: now, lastSeenAt: now },
      });
      await tx.tableSession.update({ where: { id: session.id }, data: { lastActivityAt: now, version: { increment: 1 } } });
      return created;
    });
    this.emit(session.id, 'guests', session.status);
    return this.view(guest.id, now);
  }

  async get(guestToken: string | undefined, now = new Date()): Promise<TableSessionView> {
    const { guestId } = await this.resolve(guestToken, now);
    await this.prisma.tableGuest.update({ where: { id: guestId }, data: { lastSeenAt: now } });
    return this.view(guestId, now);
  }

  async rename(guestToken: string | undefined, displayName: string, now = new Date()): Promise<TableSessionView> {
    const { guestId, session } = await this.resolve(guestToken, now);
    this.requireOpen(session);
    await this.prisma.$transaction([
      this.prisma.tableGuest.update({ where: { id: guestId }, data: { displayName, lastSeenAt: now } }),
      this.prisma.tableSession.update({ where: { id: session.id }, data: { lastActivityAt: now, version: { increment: 1 } } }),
    ]);
    this.emit(session.id, 'guests', session.status);
    return this.view(guestId, now);
  }

  /** Adds a dish for the caller; the same size with the same note joins their unsent line. */
  async addItem(guestToken: string | undefined, input: z.output<typeof addTableItemSchema>, now = new Date()): Promise<TableSessionView> {
    const { guestId, session } = await this.resolve(guestToken, now);
    this.requireActive(session);
    // Checked against the branch's menu now (sold out, hidden, price); checked again when sent.
    const [line] = await this.orders.priceLines(session.restaurantId, session.branchId, [{ menuItemId: input.menuItemId, variantId: input.variantId, quantity: input.quantity, note: input.note }]);
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, session.id);
      this.requireActive({ ...session, status });
      const same = await tx.tableCartItem.findFirst({ where: { sessionId: session.id, guestId, status: 'DRAFT', variantId: input.variantId, note: input.note } });
      if (same) {
        await tx.tableCartItem.update({
          where: { id: same.id },
          data: { quantity: Math.min(TABLE_SESSION_LIMITS.quantity, same.quantity + input.quantity), unitPricePiastres: line!.unitPricePiastres, version: { increment: 1 } },
        });
      } else {
        const count = await tx.tableCartItem.count({ where: { sessionId: session.id } });
        if (count >= TABLE_SESSION_LIMITS.items) throw fail('conflict', CODES.ITEMS_FULL, 'The table’s order has the most dishes allowed.');
        await tx.tableCartItem.create({
          data: {
            sessionId: session.id, guestId, menuItemId: input.menuItemId, variantId: input.variantId,
            nameAr: line!.nameAr, nameEn: line!.nameEn, variantNameAr: line!.variantNameAr, variantNameEn: line!.variantNameEn,
            unitPricePiastres: line!.unitPricePiastres, quantity: input.quantity, note: input.note, createdAt: now,
          },
        });
      }
      await tx.tableSession.update({ where: { id: session.id }, data: { lastActivityAt: now, version: { increment: 1 } } });
    });
    this.emit(session.id, 'items', 'ACTIVE');
    return this.view(guestId, now);
  }

  async updateItem(guestToken: string | undefined, itemId: string, input: z.output<typeof updateTableItemSchema>, now = new Date()): Promise<TableSessionView> {
    const { guestId, session } = await this.resolve(guestToken, now);
    this.requireActive(session);
    await this.editable(session, guestId, itemId);
    const { count } = await this.prisma.tableCartItem.updateMany({
      where: { id: itemId, sessionId: session.id, status: 'DRAFT', version: input.version },
      data: { ...(input.quantity !== undefined && { quantity: input.quantity }), ...(input.note !== undefined && { note: input.note }), version: { increment: 1 } },
    });
    if (!count) await this.refuseChange(session.id, itemId);
    await this.touch(session.id, now);
    this.emit(session.id, 'items', 'ACTIVE');
    return this.view(guestId, now);
  }

  async removeItem(guestToken: string | undefined, itemId: string, version: number | undefined, now = new Date()): Promise<TableSessionView> {
    const { guestId, session } = await this.resolve(guestToken, now);
    this.requireActive(session);
    await this.editable(session, guestId, itemId);
    const { count } = await this.prisma.tableCartItem.deleteMany({ where: { id: itemId, sessionId: session.id, status: 'DRAFT', ...(version !== undefined && { version }) } });
    if (!count) await this.refuseChange(session.id, itemId);
    await this.touch(session.id, now);
    this.emit(session.id, 'items', 'ACTIVE');
    return this.view(guestId, now);
  }

  /**
   * Sends unsent dishes (the caller's, or the whole table's) as one dine-in order. Prices and
   * availability are checked again first: a changed price updates the dishes and asks the guest to
   * confirm again (PRICES_CHANGED). The same Idempotency-Key returns the order already created.
   */
  async submit(guestToken: string | undefined, idempotencyKey: string, input: z.output<typeof submitTableSessionSchema>, now = new Date()): Promise<SubmitTableSessionResponse> {
    const { guestId, session } = await this.resolve(guestToken, now);
    const subdomain = session.restaurant.subdomain;
    const retried = await this.prisma.order.findUnique({ where: { restaurantId_idempotencyKey: { restaurantId: session.restaurantId, idempotencyKey } }, select: { tableSessionId: true } });
    if (retried?.tableSessionId === session.id) {
      const placed = await this.orders.place(subdomain, idempotencyKey, { type: 'DINE_IN', customerName: '-', items: [] });
      return { ...placed, session: await this.view(guestId, now) };
    }
    this.requireActive(session);
    const drafts = await this.prisma.tableCartItem.findMany({
      where: { sessionId: session.id, status: 'DRAFT', ...(input.scope === 'MINE' && { guestId }) },
      include: { guest: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!drafts.length) throw fail('conflict', CODES.NOTHING_TO_SUBMIT, 'There are no unsent dishes.');
    if (drafts.length > ORDER_LIMITS.lines) throw fail('conflict', CODES.ITEMS_FULL, `Send at most ${ORDER_LIMITS.lines} dishes at once.`);
    const lines = drafts.map((item) => ({ menuItemId: item.menuItemId, variantId: item.variantId, quantity: item.quantity, note: item.note }));
    const priced = await this.orders.priceLines(session.restaurantId, session.branchId, lines);
    const changed = drafts.filter((item, index) => priced[index]!.unitPricePiastres !== item.unitPricePiastres);
    if (changed.length) {
      await this.prisma.$transaction(changed.map((item) => this.prisma.tableCartItem.updateMany({
        where: { id: item.id, status: 'DRAFT' },
        data: { unitPricePiastres: priced[drafts.indexOf(item)]!.unitPricePiastres, version: { increment: 1 } },
      })));
      this.emit(session.id, 'items', 'ACTIVE');
      throw fail('conflict', CODES.PRICES_CHANGED, 'Some prices changed. Check the order and send it again.', {
        itemIds: changed.map((item) => item.id), totalPiastres: priced.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0),
      });
    }
    const total = priced.reduce((sum, line) => sum + line.unitPricePiastres * line.quantity, 0);
    if (input.expectedTotalPiastres !== undefined && input.expectedTotalPiastres !== total) {
      throw fail('conflict', CODES.PRICES_CHANGED, 'The order changed since you checked it. Review it and send again.', { itemIds: [], totalPiastres: total });
    }
    const names = [...new Map(drafts.map((item) => [item.guestId, guestLabel(item.guest)])).values()];
    const customerName = (input.scope === 'MINE' ? names[0]! : names.join('، ')).slice(0, 60).padEnd(2, '.');
    let placed;
    try {
      placed = await this.orders.place(subdomain, idempotencyKey, {
        type: 'DINE_IN', tableCode: session.table.publicCode, customerName, note: input.note, items: lines,
      }, now, {
        sessionId: session.id,
        guests: drafts.map((item) => ({ id: item.guestId, name: guestLabel(item.guest) })),
        cartItems: drafts.map((item) => ({ id: item.id, version: item.version })),
      });
    } catch (error) {
      if (error instanceof SharedCartChanged) {
        throw fail('conflict', CODES.ITEM_STALE, 'Another guest changed or sent some of these dishes just now. Review and send again.');
      }
      throw error;
    }
    this.emit(session.id, 'submitted', 'ACTIVE');
    return { ...placed, session: await this.view(guestId, now) };
  }

  // --- Staff --------------------------------------------------------------------------------------

  async list(userId: string, branchId?: string, now = new Date()): Promise<OwnerTableSession[]> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'tables.view');
    const where = await this.scopes.branchWhere(scope, branchId);
    await expireIdle(this.prisma, where, now);
    const rows = await this.prisma.tableSession.findMany({
      where: { ...where, status: { not: 'CLOSED' } },
      orderBy: { startedAt: 'asc' },
      include: {
        table: { select: { label: true } },
        _count: { select: { guests: true, orders: true, cartItems: { where: { status: 'DRAFT' } } } },
      },
    });
    return rows.map((row) => ({
      id: row.id, tableId: row.tableId, tableLabel: row.table.label, branchId: row.branchId, status: row.status,
      startedAt: row.startedAt.toISOString(), lastActivityAt: row.lastActivityAt.toISOString(),
      guests: row._count.guests, draftItems: row._count.cartItems, orders: row._count.orders,
    }));
  }

  /** Reopen a session that asked for the bill, or close one (the guests left without settling here). */
  async setStatus(userId: string, sessionId: string, status: TableSessionStatus, now = new Date()): Promise<OwnerTableSession> {
    const scope = await this.scopes.resolve(userId);
    if (!scope.permissions.has('service.manage') && !scope.permissions.has('payments.process')) this.scopes.require(scope, 'service.manage');
    const where = await this.scopes.branchWhere(scope);
    const current = await this.prisma.tableSession.findFirst({ where: { id: sessionId, ...where } });
    if (!current) throw fail('notFound', CODES.SESSION_CLOSED, 'Table session not found.');
    if (current.status === 'CLOSED') throw fail('conflict', CODES.SESSION_CLOSED, 'This session is closed; the next scan starts a new one.', { reason: current.closedReason });
    await this.prisma.tableSession.update({
      where: { id: sessionId },
      data: {
        status, version: { increment: 1 }, lastActivityAt: now,
        ...(status === 'CLOSED' && { closedReason: 'STAFF', endedAt: now }),
      },
    });
    this.emit(sessionId, 'status', status);
    const [row] = (await this.list(userId, current.branchId, now)).filter((entry) => entry.id === sessionId);
    return row ?? {
      id: current.id, tableId: current.tableId, tableLabel: '', branchId: current.branchId, status, startedAt: current.startedAt.toISOString(),
      lastActivityAt: now.toISOString(), guests: 0, draftItems: 0, orders: 0,
    };
  }

  async stats(userId: string, query: z.output<typeof tableSessionStatsQuerySchema>, now = new Date()): Promise<TableSessionStats> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'analytics.view');
    const where = await this.scopes.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 86_400_000);
    const sessionWhere: Prisma.TableSessionWhereInput = { ...where, startedAt: { gte: since } };
    const [sessions, joinedSessions, guests, sessionsWithOrders, dineInOrders, sharedOrders, duplicates] = await Promise.all([
      this.prisma.tableSession.count({ where: sessionWhere }),
      this.prisma.tableSession.count({ where: { ...sessionWhere, guests: { some: {} } } }),
      this.prisma.tableGuest.count({ where: { session: sessionWhere } }),
      this.prisma.tableSession.count({ where: { ...sessionWhere, cartItems: { some: { status: 'SUBMITTED' } } } }),
      this.prisma.order.count({ where: { ...where, type: 'DINE_IN', placedAt: { gte: since } } }),
      this.prisma.order.count({ where: { ...where, type: 'DINE_IN', placedAt: { gte: since }, tableCartItems: { some: {} } } }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT a.table_id) AS count FROM table_sessions a
        JOIN table_sessions b ON a.table_id = b.table_id AND a.id < b.id
          AND a.started_at < COALESCE(b.ended_at, ${now}) AND b.started_at < COALESCE(a.ended_at, ${now})
        WHERE a.restaurant_id = ${where.restaurantId}::uuid AND a.started_at >= ${since}
          ${where.branchId ? Prisma.sql`AND a.branch_id = ${where.branchId}::uuid` : Prisma.empty}`,
    ]);
    const rate = (part: number, whole: number) => (whole ? part / whole : null);
    return {
      days: query.days, sessions, joinedSessions, guests,
      averageGuests: joinedSessions ? Math.round((guests / joinedSessions) * 10) / 10 : null,
      sessionsWithOrders, conversionRate: rate(sessionsWithOrders, joinedSessions),
      dineInOrders, sharedOrders, adoptionRate: rate(sharedOrders, dineInOrders),
      duplicateIncidents: Number(duplicates[0]?.count ?? 0),
    };
  }

  // --- Helpers ------------------------------------------------------------------------------------

  private async ensureAvailable(restaurant: SessionRow['restaurant'], branch: SessionRow['branch'], now: Date): Promise<void> {
    const access = await this.subscriptions.accessFor(restaurant, now);
    if (!restaurant.tableSessionsEnabled || !hasAccess(access) || !access.features.ordering || !branch.orderingEnabled || !branch.acceptsDineIn) {
      throw fail('forbidden', CODES.UNAVAILABLE, 'This table is not taking shared orders right now.');
    }
  }

  /** The guest behind a token and their session; an idle session is closed on the way (EXPIRED). */
  private async resolve(guestToken: string | undefined, now: Date): Promise<GuestContext> {
    const guestId = guestToken ? this.guestTokens.verify(guestToken) : null;
    const guest = guestId ? await this.prisma.tableGuest.findUnique({ where: { id: guestId }, select: { id: true, sessionId: true } }) : null;
    if (!guest) throw guestInvalid();
    if (await expireIdle(this.prisma, { id: guest.sessionId }, now)) this.emit(guest.sessionId, 'status', 'CLOSED');
    const session = await this.prisma.tableSession.findUniqueOrThrow({ where: { id: guest.sessionId }, include: sessionInclude });
    return { guestId: guest.id, session };
  }

  private requireOpen(session: Pick<SessionRow, 'status' | 'closedReason'>): void {
    if (session.status === 'CLOSED') {
      throw fail('conflict', CODES.SESSION_CLOSED, 'This table’s session is closed. Scan the table again to start a new one.', { reason: session.closedReason ?? 'SETTLED' });
    }
  }

  private requireActive(session: Pick<SessionRow, 'status' | 'closedReason'>): void {
    this.requireOpen(session);
    if (session.status === 'CLOSING') throw fail('conflict', CODES.SESSION_CLOSING, 'The table asked for the bill. Ask the staff to add more dishes.');
  }

  /** The caller may change this dish: unsent, and theirs (or shared editing is on). */
  private async editable(session: SessionRow, guestId: string, itemId: string): Promise<void> {
    const item = await this.prisma.tableCartItem.findFirst({ where: { id: itemId, sessionId: session.id }, select: { guestId: true, status: true } });
    if (!item) throw itemNotFound();
    if (item.status === 'SUBMITTED') throw fail('conflict', CODES.ITEM_SUBMITTED, 'This dish was already sent to the restaurant.');
    if (item.guestId !== guestId && !session.restaurant.tableSessionSharedEditing) throw fail('forbidden', CODES.ITEM_NOT_YOURS, 'Another guest added this dish.');
  }

  /** Why a compare-and-swap on a dish matched nothing. */
  private async refuseChange(sessionId: string, itemId: string): Promise<never> {
    const item = await this.prisma.tableCartItem.findFirst({ where: { id: itemId, sessionId }, select: { status: true, version: true } });
    if (!item) throw itemNotFound();
    if (item.status === 'SUBMITTED') throw fail('conflict', CODES.ITEM_SUBMITTED, 'This dish was already sent to the restaurant.');
    throw fail('conflict', CODES.ITEM_STALE, 'This dish changed on another phone. Check it and try again.', { version: item.version });
  }

  private async lock(tx: Tx, sessionId: string): Promise<TableSessionStatus> {
    const rows = await tx.$queryRaw<{ status: TableSessionStatus }[]>`SELECT status FROM table_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
    return rows[0]?.status ?? 'CLOSED';
  }

  private touch(sessionId: string, now: Date) {
    return this.prisma.tableSession.update({ where: { id: sessionId }, data: { lastActivityAt: now, version: { increment: 1 } } });
  }

  private emit(sessionId: string, reason: TableSessionUpdatedEvent['reason'], status: TableSessionStatus): void {
    this.realtime.emitTableSession(sessionId, { reason, status });
  }

  private async view(guestId: string, _now: Date): Promise<TableSessionView> {
    const guest = await this.prisma.tableGuest.findUniqueOrThrow({
      where: { id: guestId },
      include: {
        session: {
          include: {
            ...sessionInclude,
            guests: { orderBy: { number: 'asc' } },
            cartItems: { include: { guest: true, order: { select: { id: true, number: true, status: true, placedAt: true } } }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    const { session } = guest;
    const sharedEditing = session.restaurant.tableSessionSharedEditing;
    const open = session.status === 'ACTIVE';
    const items: TableSessionItem[] = session.cartItems.map((item) => ({
      id: item.id,
      guest: { id: item.guest.id, number: item.guest.number, name: item.guest.displayName },
      mine: item.guestId === guest.id,
      editable: open && item.status === 'DRAFT' && (item.guestId === guest.id || sharedEditing),
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      nameAr: item.nameAr,
      nameEn: item.nameEn,
      variantNameAr: item.variantNameAr,
      variantNameEn: item.variantNameEn,
      unitPricePiastres: item.unitPricePiastres,
      quantity: item.quantity,
      note: item.note,
      lineTotalPiastres: item.unitPricePiastres * item.quantity,
      status: item.status,
      order: item.order ? { number: item.order.number, status: item.order.status, trackingToken: this.trackingTokens.issue(item.order.id) } : null,
      version: item.version,
      addedAt: item.createdAt.toISOString(),
    }));
    const placedAt = new Map(session.cartItems.flatMap((item) => (item.order ? [[item.id, item.order.placedAt.getTime()] as const] : [])));
    items.sort((a, b) => (a.status === b.status ? (a.status === 'SUBMITTED' ? placedAt.get(b.id)! - placedAt.get(a.id)! : 0) : a.status === 'DRAFT' ? -1 : 1));
    const drafts = items.filter((item) => item.status === 'DRAFT');
    return {
      status: session.status,
      closedReason: (session.closedReason as TableSessionCloseReason | null) ?? null,
      startedAt: session.startedAt.toISOString(),
      table: { label: session.table.label },
      branch: { slug: session.branch.slug, name: session.branch.name },
      me: { id: guest.id, number: guest.number, name: guest.displayName, me: true },
      guests: session.guests.map((entry) => ({ id: entry.id, number: entry.number, name: entry.displayName, me: entry.id === guest.id })),
      items,
      draftTotalPiastres: drafts.reduce((sum, item) => sum + item.lineTotalPiastres, 0),
      myDraftTotalPiastres: drafts.filter((item) => item.mine).reduce((sum, item) => sum + item.lineTotalPiastres, 0),
      sharedEditing,
      guestToken: this.guestTokens.issue(guest.id),
      sessionToken: this.sessionTokens.issue(session.id),
    };
  }
}
