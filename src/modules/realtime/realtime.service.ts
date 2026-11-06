import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  TABLE_SESSION_EVENTS,
  type TableSessionUpdatedEvent,
  STAFF_ROLES,
  effectivePermissions,
  type OwnerOrder,
  type OwnerServiceRequest,
  type PublicServiceRequest,
  SERVICE_REQUEST_EVENTS,
  type ServiceRequestEvent,
  type TableServiceEvent,
  type OwnerOrderEvent,
  type OrderingSettings,
  type PublicOrder,
  REALTIME_EVENTS,
  type RestaurantUpdatedEvent,
  type TableUpdatedEvent,
  REALTIME_PATH,
  SUPPORT_EVENTS,
  SUPPORT_NAMESPACE,
  type SupportTypingEvent,
  type SupportUpdatedEvent,
  type TrackedOrderEvent,
  type OwnerReviewListItem,
  REVIEW_EVENTS,
  type ReviewRealtimeEvent,
} from '@bilhanah/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { type Namespace, Server, type Socket } from 'socket.io';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { AccessTokenService } from '../auth/access-token.service.js';
import { TrackingTokens } from '../orders/tracking-token.js';
import { TABLE_SESSION_TOKENS } from '../service-requests/session-token.js';

const restaurantRoom = (restaurantId: string) => `restaurant:${restaurantId}`;
const branchRoom = (branchId: string) => `branch:${branchId}`;
const orderRoom = (orderId: string) => `order:${orderId}`;
const tableSessionRoom = (sessionId: string) => `table-session:${sessionId}`;
/** Reviews go only to sockets whose account holds reviews.view, so they have rooms of their own. */
const reviewsRestaurantRoom = (restaurantId: string) => `reviews:restaurant:${restaurantId}`;
const reviewsBranchRoom = (branchId: string) => `reviews:branch:${branchId}`;
const SUPPORT_AGENTS = 'support:agents';
const supportUserRoom = (userId: string) => `support:user:${userId}`;

/**
 * Live order updates over Socket.IO (WebSocket only, so no sticky sessions
 * are needed). The Redis adapter relays events between API replicas.
 *
 * - /owner: auth { token: accessToken }. Owners and all-branch staff join the
 *   restaurant room (every branch); staff tied to a branch join that branch's room;
 *   disconnected when the token expires, so the client reconnects with a
 *   fresh one and revoked sessions stop receiving events. Accounts holding
 *   reviews.view also join the matching reviews room (review events).
 * - /track: auth { token: trackingToken }. Joins that one order's room.
 * - /table: auth { token: tableSessionToken }. Joins that table session's room, for the
 *   status of the guests' service requests.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private io?: Server;
  private owners?: Namespace;
  private trackers?: Namespace;
  private tables?: Namespace;
  private support?: Namespace;
  private adapterClients: Redis[] = [];

  constructor(
    private readonly http: HttpAdapterHost,
    private readonly accessTokens: AccessTokenService,
    private readonly trackingTokens: TrackingTokens,
    @Inject(TABLE_SESSION_TOKENS) private readonly sessionTokens: TrackingTokens,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.http.httpAdapter.getHttpServer();
    const pub = this.redis.duplicate();
    const sub = this.redis.duplicate();
    this.adapterClients = [pub, sub];
    this.io = new Server(httpServer, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      serveClient: false,
      // Tokens, not cookies, authenticate sockets, so any origin may connect.
      cors: { origin: true, credentials: false },
      adapter: createAdapter(pub, sub),
    });

    this.owners = this.io.of('/owner');
    this.owners.use((socket, next) => {
      this.authenticateOwner(socket).then(
        () => next(),
        () => next(new Error('UNAUTHENTICATED')),
      );
    });

    this.trackers = this.io.of('/track');
    this.trackers.use((socket, next) => {
      const orderId = typeof socket.handshake.auth['token'] === 'string' ? this.trackingTokens.verify(socket.handshake.auth['token']) : null;
      if (!orderId) return next(new Error('ORDER_NOT_FOUND'));
      void socket.join(orderRoom(orderId));
      next();
    });

    // Support: administrators join the agents' room; restaurant users their own room.
    this.support = this.io.of(SUPPORT_NAMESPACE);
    this.support.use((socket, next) => {
      this.authenticateSupport(socket).then(
        () => next(),
        () => next(new Error('UNAUTHENTICATED')),
      );
    });
    this.support.on('connection', (socket) => {
      socket.on(SUPPORT_EVENTS.TYPING, (payload: unknown) => {
        const ticketId = typeof payload === 'object' && payload !== null ? (payload as { ticketId?: unknown }).ticketId : null;
        if (typeof ticketId === 'string' && /^[0-9a-f-]{36}$/i.test(ticketId)) void this.relayTyping(socket, ticketId).catch(() => undefined);
      });
    });

    this.tables = this.io.of('/table');
    this.tables.use((socket, next) => {
      const sessionId = typeof socket.handshake.auth['token'] === 'string' ? this.sessionTokens.verify(socket.handshake.auth['token']) : null;
      if (!sessionId) return next(new Error('TABLE_SESSION_INVALID'));
      void socket.join(tableSessionRoom(sessionId));
      next();
    });
  }

  /** A new or changed service request: to the staff of its branch, and to the guests of its table session. */
  emitServiceRequest(kind: 'created' | 'updated', restaurantId: string, sessionId: string, ownerView: OwnerServiceRequest, publicView: PublicServiceRequest): void {
    const event = kind === 'created' ? SERVICE_REQUEST_EVENTS.CREATED : SERVICE_REQUEST_EVENTS.UPDATED;
    this.owners?.to([restaurantRoom(restaurantId), branchRoom(ownerView.branchId)]).emit(event, { request: ownerView } satisfies ServiceRequestEvent);
    this.tables?.to(tableSessionRoom(sessionId)).emit(event, { request: publicView } satisfies TableServiceEvent);
  }

  /** Something changed in a shared table session (dishes, guests, status): its guests fetch it again. */
  emitTableSession(sessionId: string, event: TableSessionUpdatedEvent): void {
    this.tables?.to(tableSessionRoom(sessionId)).emit(TABLE_SESSION_EVENTS.UPDATED, event);
  }

  emitOrderCreated(restaurantId: string, order: OwnerOrder): void {
    this.owners?.to([restaurantRoom(restaurantId), branchRoom(order.branchId)]).emit(REALTIME_EVENTS.ORDER_CREATED, { order } satisfies OwnerOrderEvent);
  }

  emitOrderUpdated(restaurantId: string, ownerView: OwnerOrder, publicView: PublicOrder): void {
    this.owners
      ?.to([restaurantRoom(restaurantId), branchRoom(ownerView.branchId)])
      .emit(REALTIME_EVENTS.ORDER_UPDATED, { order: ownerView } satisfies OwnerOrderEvent);
    this.trackers?.to(orderRoom(ownerView.id)).emit(REALTIME_EVENTS.ORDER_UPDATED, { order: publicView } satisfies TrackedOrderEvent);
  }

  /** A table's status changed (by hand, or its bill was settled): every dashboard of its branch fetches the floor again. */
  emitTableUpdated(restaurantId: string, event: TableUpdatedEvent): void {
    this.owners?.to([restaurantRoom(restaurantId), branchRoom(event.branchId)]).emit(REALTIME_EVENTS.TABLE_UPDATED, event satisfies TableUpdatedEvent);
  }

  /** A new or changed review: to the dashboards that may read reviews (reviews.view), restaurant-wide and at its branch. */
  emitReview(kind: 'created' | 'updated', restaurantId: string, review: OwnerReviewListItem): void {
    const event = kind === 'created' ? REVIEW_EVENTS.CREATED : REVIEW_EVENTS.UPDATED;
    this.owners?.to([reviewsRestaurantRoom(restaurantId), reviewsBranchRoom(review.branchId)]).emit(event, { review } satisfies ReviewRealtimeEvent);
  }

  /** Tells the other devices that a branch's ordering settings changed (e.g. orders paused). */
  emitRestaurantUpdated(restaurantId: string, branchId: string, ordering: OrderingSettings): void {
    this.owners
      ?.to([restaurantRoom(restaurantId), branchRoom(branchId)])
      .emit(REALTIME_EVENTS.RESTAURANT_UPDATED, { branchId, ordering } satisfies RestaurantUpdatedEvent);
  }

  /** A ticket changed: every agent's console, and (when it concerns them) the restaurant users given. */
  emitSupportUpdated(ticketId: string, customerIds: string[] = []): void {
    const event = { ticketId } satisfies SupportUpdatedEvent;
    this.support?.to(SUPPORT_AGENTS).emit(SUPPORT_EVENTS.UPDATED, event);
    if (customerIds.length) this.support?.to(customerIds.map(supportUserRoom)).emit(SUPPORT_EVENTS.UPDATED, event);
  }

  /** "Is typing": from the restaurant to the agents, or from an agent to the ticket's requester and owner. */
  private async relayTyping(socket: Socket, ticketId: string): Promise<void> {
    const data = socket.data as { userId: string; agent: boolean; name: string | null };
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { requesterId: true, status: true, restaurant: { select: { ownerId: true } } },
    });
    if (!ticket || ticket.status === 'CLOSED') return;
    if (data.agent) {
      const event = { ticketId, side: 'AGENT', name: data.name } satisfies SupportTypingEvent;
      this.support?.to([supportUserRoom(ticket.requesterId), supportUserRoom(ticket.restaurant.ownerId)]).emit(SUPPORT_EVENTS.TYPING, event);
    } else if (data.userId === ticket.requesterId || data.userId === ticket.restaurant.ownerId) {
      const event = { ticketId, side: 'CUSTOMER', name: null } satisfies SupportTypingEvent;
      this.support?.to(SUPPORT_AGENTS).emit(SUPPORT_EVENTS.TYPING, event);
    }
  }

  private async authenticateSupport(socket: Socket): Promise<void> {
    const token = socket.handshake.auth['token'];
    const claims = typeof token === 'string' ? await this.accessTokens.verify(token) : null;
    if (!claims) throw new Error('UNAUTHENTICATED');
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { role: true, status: true, fullName: true, permissionGrants: true } } },
    });
    if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
      throw new Error('UNAUTHENTICATED');
    }
    const agent = session.user.role === 'ADMIN';
    // Restaurant users need the support permission, as for the support API.
    if (!agent && !effectivePermissions(session.user.role, session.user.permissionGrants).includes('support.use')) throw new Error('UNAUTHENTICATED');
    socket.data = { userId: session.userId, agent, name: agent ? session.user.fullName.split(/\s+/)[0] ?? null : null };
    await socket.join(agent ? SUPPORT_AGENTS : supportUserRoom(session.userId));
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
    socket.on('disconnect', () => clearTimeout(timer));
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => (this.io ? this.io.close(() => resolve()) : resolve()));
    for (const client of this.adapterClients) await client.quit().catch(() => client.disconnect());
  }

  private async authenticateOwner(socket: Socket): Promise<void> {
    const token = socket.handshake.auth['token'];
    const claims = typeof token === 'string' ? await this.accessTokens.verify(token) : null;
    if (!claims || claims.role === 'ADMIN') throw new Error('UNAUTHENTICATED');
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { role: true, status: true, staffRestaurantId: true, staffBranchId: true, permissionGrants: true, restaurant: { select: { id: true } } } },
      },
    });
    // Staff follow their restaurant (and only their branch when tied to one); owners their own restaurant.
    const staff = session !== null && (STAFF_ROLES as readonly string[]).includes(session.user.role);
    const restaurantId = staff ? session.user.staffRestaurantId : session?.user.restaurant?.id;
    if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE' || !restaurantId) {
      throw new Error('UNAUTHENTICATED');
    }
    const branchId = staff ? session.user.staffBranchId : null;
    const rooms = [branchId ? branchRoom(branchId) : restaurantRoom(restaurantId)];
    // Permissions as of connecting; the socket reconnects (and is checked again) when its token expires.
    if (effectivePermissions(session.user.role, session.user.permissionGrants).includes('reviews.view')) {
      rooms.push(branchId ? reviewsBranchRoom(branchId) : reviewsRestaurantRoom(restaurantId));
    }
    await socket.join(rooms);
    // End the connection when the access token expires; the client reconnects with a fresh one.
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
    socket.on('disconnect', () => clearTimeout(timer));
  }
}
