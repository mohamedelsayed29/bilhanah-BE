import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  RESTAURANT_ROLES,
  type RestaurantRole,
  rolesWith,
  type createServiceRequestSchema,
  type CreateServiceRequestResponse,
  type listServiceRequestsQuerySchema,
  normalizeSubdomain,
  OPEN_SERVICE_REQUEST_STATUSES,
  type OwnerServiceRequest,
  type Paginated,
  type PublicServiceRequest,
  SERVICE_REQUEST_ERROR_CODES,
  SERVICE_REQUEST_TRANSITIONS,
  type ServiceRequestStaff,
  type ServiceRequestStats,
  type serviceRequestStatsQuerySchema,
  type ServiceRequestStatus,
  type TableServiceSession,
  type updateServiceRequestSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import type { TrackingTokens } from '../orders/tracking-token.js';
import { liveSessionWhere, openSessionFor } from '../table-sessions/session-lifecycle.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { hasAccess } from '../subscriptions/access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { TABLE_SESSION_TOKENS } from './session-token.js';

const { SERVICE_REQUESTS_UNAVAILABLE, TABLE_SESSION_INVALID, SERVICE_REQUEST_NOT_FOUND, SERVICE_REQUEST_THROTTLED, INVALID_SERVICE_REQUEST_TRANSITION, SERVICE_REQUEST_ASSIGNEE_INVALID } =
  SERVICE_REQUEST_ERROR_CODES;
const OPEN: ServiceRequestStatus[] = [...OPEN_SERVICE_REQUEST_STATUSES];

const staffSelect = { select: { id: true, fullName: true, role: true } } as const;
const requestInclude = {
  assignedTo: staffSelect,
  handledBy: staffSelect,
  table: { select: { areaId: true } },
} as const;
type RequestRow = Prisma.ServiceRequestGetPayload<{ include: typeof requestInclude }>;

const notFound = () => new NotFoundException({ code: SERVICE_REQUEST_NOT_FOUND, message: 'Service request not found.' });
const invalidSession = () =>
  new NotFoundException({ code: TABLE_SESSION_INVALID, message: 'Your table session has ended. Scan the table’s QR code again.' });

/**
 * Table service requests. Diners send them from the menu with a table session token (from
 * scanning the table's QR code); the staff (owners, and managers of the branch) handle them on the
 * dashboard. A table session lasts until the bill is settled or it idles for a few hours.
 */
@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly subscriptions: SubscriptionsService,
    private readonly realtime: RealtimeService,
    @Inject(TABLE_SESSION_TOKENS) private readonly tokens: TrackingTokens,
  ) {}

  // --- Diners ---------------------------------------------------------------

  /** Joins the table's current session (or the one the phone already holds), else starts one. */
  async joinSession(rawSubdomain: string, code: string, sessionToken: string | undefined, now = new Date()): Promise<TableServiceSession> {
    const table = await this.prisma.table.findFirst({
      where: { publicCode: code, isActive: true, branch: { isActive: true }, restaurant: { subdomain: normalizeSubdomain(rawSubdomain) } },
      select: { id: true, label: true, branchId: true, restaurantId: true, restaurant: true },
    });
    if (!table) throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'This table was not found. Scan the QR code again.' });
    await this.ensureAvailable(table.restaurant, now);
    const held = sessionToken ? this.tokens.verify(sessionToken) : null;
    // The table's one open session (shared with its guests' shared order), never a second one.
    const session = (held ? await this.prisma.tableSession.findFirst({ where: { id: held, tableId: table.id, ...liveSessionWhere(now) } }) : null)
      ?? (await openSessionFor(this.prisma, table, now));
    const requests = await this.prisma.serviceRequest.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, include: requestInclude });
    return { sessionToken: this.tokens.issue(session.id), table: { label: table.label }, requests: requests.map(toPublic) };
  }

  async sessionRequests(sessionToken: string, now = new Date()): Promise<TableServiceSession> {
    const session = await this.liveSession(sessionToken, now);
    const requests = await this.prisma.serviceRequest.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, include: requestInclude });
    return { sessionToken, table: { label: session.table.label }, requests: requests.map(toPublic) };
  }

  /**
   * A new request from the table. An open request of the same type is returned instead of a
   * second one; a closed one cannot be repeated within the restaurant's cooldown, and a table
   * sends at most its hourly limit.
   */
  async create(input: z.output<typeof createServiceRequestSchema>, now = new Date()): Promise<CreateServiceRequestResponse> {
    const session = await this.liveSession(input.sessionToken, now);
    const restaurant = session.restaurant;
    await this.ensureAvailable(restaurant, now);
    const table = session.table;

    if (input.type !== 'CUSTOM') {
      const open = await this.prisma.serviceRequest.findFirst({
        where: { tableId: table.id, type: input.type, status: { in: OPEN } }, orderBy: { createdAt: 'desc' }, include: requestInclude,
      });
      if (open) return { request: toPublic(open), duplicate: true };
      const cooldownMs = restaurant.serviceRequestCooldownSeconds * 1000;
      if (cooldownMs > 0) {
        const recent = await this.prisma.serviceRequest.findFirst({
          where: { tableId: table.id, type: input.type, createdAt: { gt: new Date(now.getTime() - cooldownMs) } },
          orderBy: { createdAt: 'desc' }, select: { createdAt: true },
        });
        if (recent) throw throttled(Math.ceil((recent.createdAt.getTime() + cooldownMs - now.getTime()) / 1000), 'COOLDOWN');
      }
    }
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const lastHour = await this.prisma.serviceRequest.findMany({ where: { tableId: table.id, createdAt: { gt: hourAgo } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    if (lastHour.length >= restaurant.serviceRequestHourlyLimit) {
      throw throttled(Math.ceil((lastHour[0]!.createdAt.getTime() + 60 * 60 * 1000 - now.getTime()) / 1000), 'HOURLY_LIMIT');
    }

    const [request] = await this.prisma.$transaction([
      this.prisma.serviceRequest.create({
        data: {
          restaurantId: restaurant.id, branchId: session.branchId, tableId: table.id, tableLabel: table.label, sessionId: session.id,
          type: input.type, note: input.note ?? null, createdAt: now,
        },
        include: requestInclude,
      }),
      // Asking for the bill puts the shared order in CLOSING: no new dishes until the staff reopen it.
      this.prisma.tableSession.update({
        where: { id: session.id },
        data: { lastActivityAt: now, ...(input.type === 'REQUEST_BILL' && session.status === 'ACTIVE' && { status: 'CLOSING', version: { increment: 1 } }) },
      }),
    ]);
    if (input.type === 'REQUEST_BILL' && session.status === 'ACTIVE') this.realtime.emitTableSession(session.id, { reason: 'status', status: 'CLOSING' });
    this.realtime.emitServiceRequest('created', restaurant.id, session.id, toOwner(request), toPublic(request));
    return { request: toPublic(request), duplicate: false };
  }

  /** The guests withdraw a request the staff have not taken yet. */
  async cancelByGuest(requestId: string, sessionToken: string, now = new Date()): Promise<PublicServiceRequest> {
    const session = await this.liveSession(sessionToken, now);
    const request = await this.prisma.serviceRequest.findFirst({ where: { id: requestId, sessionId: session.id }, include: requestInclude });
    if (!request) throw notFound();
    // Once the staff have it, only they can close it.
    if (request.status !== 'PENDING') throw transitionError(request.status, 'CANCELLED', []);
    return toPublic(await this.save(request, { status: 'CANCELLED', cancelledAt: now, cancelledByGuest: true }, session.restaurantId));
  }

  // --- Staff ----------------------------------------------------------------

  async list(userId: string, query: z.output<typeof listServiceRequestsQuerySchema>): Promise<Paginated<OwnerServiceRequest>> {
    const scope = await this.scopes.resolve(userId);
    const own = await this.scopes.branchWhere(scope, query.branchId);
    const active = query.view === 'active';
    const where: Prisma.ServiceRequestWhereInput = {
      ...own,
      status: query.status ? query.status : { in: active ? OPEN : ['COMPLETED', 'CANCELLED'] },
      ...(query.type && { type: query.type }),
      ...(query.areaId && { table: query.areaId === 'none' ? { areaId: null } : { areaId: query.areaId } }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.serviceRequest.count({ where }),
      this.prisma.serviceRequest.findMany({
        where, include: requestInclude, orderBy: { createdAt: active ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toOwner), total, page: query.page, pageSize: query.pageSize };
  }

  /** A permitted status change (see SERVICE_REQUEST_TRANSITIONS) and/or a new assignee. */
  async update(userId: string, requestId: string, input: z.output<typeof updateServiceRequestSchema>, now = new Date()): Promise<OwnerServiceRequest> {
    const scope = await this.scopes.resolve(userId);
    const own = await this.scopes.branchWhere(scope);
    const request = await this.prisma.serviceRequest.findFirst({ where: { id: requestId, ...own }, include: requestInclude });
    if (!request) throw notFound();
    const data: Prisma.ServiceRequestUncheckedUpdateInput = { handledById: userId };
    if (input.status !== undefined && input.status !== request.status) {
      const allowed = SERVICE_REQUEST_TRANSITIONS[request.status];
      if (!allowed.includes(input.status)) throw transitionError(request.status, input.status, allowed);
      data.status = input.status;
      // The first staff action is the response; later steps keep earlier timestamps.
      if (!request.acknowledgedAt) data.acknowledgedAt = now;
      if (input.status === 'IN_PROGRESS' || (input.status === 'COMPLETED' && !request.startedAt)) data.startedAt = request.startedAt ?? now;
      if (input.status === 'COMPLETED') data.completedAt = now;
      if (input.status === 'CANCELLED') data.cancelledAt = now;
    } else if (input.status !== undefined && !OPEN.includes(request.status)) {
      throw transitionError(request.status, input.status, []);
    }
    if (input.assigneeId !== undefined) {
      if (!OPEN.includes(request.status)) throw transitionError(request.status, request.status, []);
      if (input.assigneeId !== null) {
        const staff = await this.assignees(userId, request.branchId);
        if (!staff.some((member) => member.id === input.assigneeId)) {
          throw new BadRequestException({ code: SERVICE_REQUEST_ASSIGNEE_INVALID, message: 'Assign the request to staff of its branch.' });
        }
      }
      data.assignedToId = input.assigneeId;
      data.assignedAt = input.assigneeId ? now : null;
      // Taking it on counts as a response.
      if (!request.acknowledgedAt && input.assigneeId) {
        data.acknowledgedAt = now;
        if (request.status === 'PENDING' && input.status === undefined) data.status = 'ACKNOWLEDGED';
      }
    }
    return toOwner(await this.save(request, data, request.restaurantId));
  }

  /** Who can take a branch's requests: the owner, and staff who handle requests at that branch (or at every branch). */
  async assignees(userId: string, branchId?: string): Promise<ServiceRequestStaff[]> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, branchId);
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: scope.restaurant.id }, select: { owner: { select: { id: true, fullName: true, status: true } } } });
    const managers = await this.prisma.user.findMany({
      where: {
        role: { in: rolesWith('service.manage').filter((role) => role !== 'OWNER') },
        status: 'ACTIVE',
        staffRestaurantId: scope.restaurant.id,
        OR: [{ staffBranchId: null }, { staffBranchId: branch.id }],
      },
      select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' },
    });
    return [
      ...(restaurant.owner.status === 'ACTIVE' ? [{ id: restaurant.owner.id, name: restaurant.owner.fullName, role: 'OWNER' as const }] : []),
      ...managers.map((member) => ({ id: member.id, name: member.fullName, role: member.role as RestaurantRole })),
    ];
  }

  /** Average response and completion times, and what is still open (success metrics). */
  async stats(userId: string, query: z.output<typeof serviceRequestStatsQuerySchema>, now = new Date()): Promise<ServiceRequestStats> {
    const scope = await this.scopes.resolve(userId);
    const own = await this.scopes.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 24 * 60 * 60 * 1000);
    const [rows, unresolved] = await Promise.all([
      this.prisma.serviceRequest.findMany({ where: { ...own, createdAt: { gte: since } }, select: { status: true, createdAt: true, acknowledgedAt: true, completedAt: true } }),
      this.prisma.serviceRequest.count({ where: { ...own, status: { in: OPEN } } }),
    ]);
    const average = (spans: number[]) => (spans.length ? Math.round(spans.reduce((sum, span) => sum + span, 0) / spans.length / 1000) : null);
    return {
      days: query.days,
      total: rows.length,
      completed: rows.filter((row) => row.status === 'COMPLETED').length,
      cancelled: rows.filter((row) => row.status === 'CANCELLED').length,
      unresolved,
      averageResponseSeconds: average(rows.filter((row) => row.acknowledgedAt).map((row) => row.acknowledgedAt!.getTime() - row.createdAt.getTime())),
      averageCompletionSeconds: average(rows.filter((row) => row.completedAt).map((row) => row.completedAt!.getTime() - row.createdAt.getTime())),
    };
  }

  // --- Helpers ----------------------------------------------------------------

  /** The table session behind a token, while it lasts. */
  private async liveSession(token: string, now: Date) {
    const id = this.tokens.verify(token);
    const session = id
      ? await this.prisma.tableSession.findFirst({
        where: { id, ...liveSessionWhere(now), table: { isActive: true }, branch: { isActive: true } },
        include: { table: { select: { id: true, label: true } }, restaurant: true },
      })
      : null;
    if (!session) throw invalidSession();
    return session;
  }

  /** Requests need the restaurant to take them and a plan with table ordering. */
  private async ensureAvailable(restaurant: Parameters<SubscriptionsService['accessFor']>[0] & { serviceRequestsEnabled: boolean }, now: Date) {
    const access = await this.subscriptions.accessFor(restaurant, now);
    if (!restaurant.serviceRequestsEnabled || !hasAccess(access) || !access.features.ordering) {
      throw new ConflictException({ code: SERVICE_REQUESTS_UNAVAILABLE, message: 'This restaurant is not taking table requests right now.' });
    }
  }

  private async save(request: RequestRow, data: Prisma.ServiceRequestUncheckedUpdateInput, restaurantId: string): Promise<RequestRow> {
    const saved = await this.prisma.serviceRequest.update({ where: { id: request.id }, data, include: requestInclude });
    this.realtime.emitServiceRequest('updated', restaurantId, saved.sessionId, toOwner(saved), toPublic(saved));
    return saved;
  }
}

function throttled(retryAfterSeconds: number, reason: 'COOLDOWN' | 'HOURLY_LIMIT') {
  return new HttpException(
    { code: SERVICE_REQUEST_THROTTLED, message: 'You just asked for this. The staff will be with you shortly.', details: { retryAfterSeconds: Math.max(1, retryAfterSeconds), reason } },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function transitionError(from: ServiceRequestStatus, to: ServiceRequestStatus, allowed: readonly ServiceRequestStatus[]) {
  return new ConflictException({ code: INVALID_SERVICE_REQUEST_TRANSITION, message: `A ${from.toLowerCase()} request cannot become ${to.toLowerCase()}.`, details: { from, to, allowed } });
}

const iso = (date: Date | null) => date?.toISOString() ?? null;
const staff = (user: { id: string; fullName: string; role: string } | null): ServiceRequestStaff | null =>
  user ? { id: user.id, name: user.fullName, role: (RESTAURANT_ROLES as readonly string[]).includes(user.role) ? (user.role as RestaurantRole) : 'MANAGER' } : null;

function toPublic(row: RequestRow): PublicServiceRequest {
  return {
    id: row.id, type: row.type, status: row.status, note: row.note,
    createdAt: row.createdAt.toISOString(), acknowledgedAt: iso(row.acknowledgedAt), completedAt: iso(row.completedAt), cancelledAt: iso(row.cancelledAt),
  };
}

function toOwner(row: RequestRow): OwnerServiceRequest {
  return {
    id: row.id, branchId: row.branchId, tableId: row.tableId, tableLabel: row.tableLabel, areaId: row.table?.areaId ?? null,
    type: row.type, status: row.status, note: row.note,
    assignee: staff(row.assignedTo), handledBy: staff(row.handledBy),
    createdAt: row.createdAt.toISOString(), assignedAt: iso(row.assignedAt), acknowledgedAt: iso(row.acknowledgedAt),
    startedAt: iso(row.startedAt), completedAt: iso(row.completedAt), cancelledAt: iso(row.cancelledAt), cancelledByGuest: row.cancelledByGuest,
  };
}
