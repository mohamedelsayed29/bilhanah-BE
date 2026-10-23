import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  type OwnerOrder,
  type OwnerOrderEvent,
  type PublicOrder,
  REALTIME_EVENTS,
  REALTIME_PATH,
  type TrackedOrderEvent,
} from '@bilhanah/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { type Namespace, Server, type Socket } from 'socket.io';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { AccessTokenService } from '../auth/access-token.service.js';
import { TrackingTokens } from '../orders/tracking-token.js';

const restaurantRoom = (restaurantId: string) => `restaurant:${restaurantId}`;
const orderRoom = (orderId: string) => `order:${orderId}`;

/**
 * Live order updates over Socket.IO (WebSocket only, so no sticky sessions
 * are needed). The Redis adapter relays events between API replicas.
 *
 * - /owner: auth { token: accessToken }. Joins the owner's restaurant room;
 *   disconnected when the token expires, so the client reconnects with a
 *   fresh one and revoked sessions stop receiving events.
 * - /track: auth { token: trackingToken }. Joins that one order's room.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private io?: Server;
  private owners?: Namespace;
  private trackers?: Namespace;
  private adapterClients: Redis[] = [];

  constructor(
    private readonly http: HttpAdapterHost,
    private readonly accessTokens: AccessTokenService,
    private readonly trackingTokens: TrackingTokens,
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
  }

  emitOrderCreated(restaurantId: string, order: OwnerOrder): void {
    this.owners?.to(restaurantRoom(restaurantId)).emit(REALTIME_EVENTS.ORDER_CREATED, { order } satisfies OwnerOrderEvent);
  }

  emitOrderUpdated(restaurantId: string, ownerView: OwnerOrder, publicView: PublicOrder): void {
    this.owners?.to(restaurantRoom(restaurantId)).emit(REALTIME_EVENTS.ORDER_UPDATED, { order: ownerView } satisfies OwnerOrderEvent);
    this.trackers?.to(orderRoom(ownerView.id)).emit(REALTIME_EVENTS.ORDER_UPDATED, { order: publicView } satisfies TrackedOrderEvent);
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => (this.io ? this.io.close(() => resolve()) : resolve()));
    for (const client of this.adapterClients) await client.quit().catch(() => client.disconnect());
  }

  private async authenticateOwner(socket: Socket): Promise<void> {
    const token = socket.handshake.auth['token'];
    const claims = typeof token === 'string' ? await this.accessTokens.verify(token) : null;
    if (!claims || claims.role !== 'OWNER') throw new Error('UNAUTHENTICATED');
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { status: true, restaurant: { select: { id: true } } } } },
    });
    const restaurantId = session?.user.restaurant?.id;
    if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE' || !restaurantId) {
      throw new Error('UNAUTHENTICATED');
    }
    await socket.join(restaurantRoom(restaurantId));
    // End the connection when the access token expires; the client reconnects with a fresh one.
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
    socket.on('disconnect', () => clearTimeout(timer));
  }
}
