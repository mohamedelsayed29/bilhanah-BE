import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AGENT_TICKET_TRANSITIONS,
  AGENT_TICKET_VIEWS,
  type AgentTicket,
  type AgentTicketRow,
  type agentTicketsQuerySchema,
  type AgentTicketView,
  canMoveTicket,
  type createTicketSchema,
  CUSTOMER_TICKET_TRANSITIONS,
  type CustomerTicket,
  type LiveChat,
  type Paginated,
  type SupportAgent,
  type SupportCounts,
  SUPPORT_ERROR_CODES,
  type SupportTopic,
  type TicketActivity,
  type TicketAttachment,
  type TicketMessage,
  type TicketPriority,
  ticketReference,
  type ticketsQuerySchema,
  type TicketStatus,
  type TicketSummary,
  type updateTicketSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { RealtimeService } from '../../realtime/realtime.service.js';
import { SupportNotificationsService } from '../notifications/support-notifications.service.js';
import { SupportAttachmentsService } from './support-attachments.service.js';

export const RESTAURANT_ATTACHMENT_URL = '/v1/support/attachments';
export const AGENT_ATTACHMENT_URL = '/v1/admin/support/attachments';
const PAGE_SIZE = 25;

export const ticketNotFound = () => new NotFoundException({ code: SUPPORT_ERROR_CODES.TICKET_NOT_FOUND, message: 'Ticket not found.' });
const invalidTransition = (from: TicketStatus, to: TicketStatus, allowed: readonly TicketStatus[]) =>
  new ConflictException({ code: SUPPORT_ERROR_CODES.INVALID_TICKET_TRANSITION, message: `A ${from} ticket cannot become ${to}.`, details: { from, to, allowed } });
const ticketClosed = () => new ConflictException({ code: SUPPORT_ERROR_CODES.TICKET_CLOSED, message: 'This ticket is closed. Reopen it or open a new one.' });

/** A restaurant user: owners see every ticket of their restaurant, other staff their own. */
export type TicketCustomer = { userId: string; restaurantId: string; owner: boolean };

const ticketInclude = {
  restaurant: { select: { id: true, name: true, subdomain: true, phone: true, city: true, status: true, owner: { select: { fullName: true, email: true } } } },
  requester: { select: { id: true, fullName: true, email: true, role: true } },
  assignee: { select: { id: true, fullName: true, email: true } },
  faqArticle: { select: { question: true } },
  attachments: { where: { messageId: null }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SupportTicketInclude;
type TicketRow = Prisma.SupportTicketGetPayload<{ include: typeof ticketInclude }>;

/**
 * Support tickets: a restaurant's issue for Bilhanah's support team, with its status, priority,
 * assignment, replies, internal notes and history. Independent of the assistant (it only keeps the
 * id of the conversation a ticket came from).
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: SupportAttachmentsService,
    private readonly notifications: SupportNotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  // --- Restaurants --------------------------------------------------------------------------------

  async create(customer: TicketCustomer, input: z.output<typeof createTicketSchema>, channel: 'FORM' | 'CHAT' = 'FORM'): Promise<CustomerTicket> {
    if (input.faqArticleId) {
      const article = await this.prisma.faqArticle.findFirst({ where: { id: input.faqArticleId, status: 'PUBLISHED' }, select: { id: true } });
      if (!article) throw new BadRequestException({ code: SUPPORT_ERROR_CODES.FAQ_NOT_FOUND, message: 'This question was not found.' });
    }
    const session = input.assistantSessionId
      ? await this.prisma.assistantSession.findFirst({ where: { id: input.assistantSessionId, userId: customer.userId, restaurantId: customer.restaurantId }, select: { id: true } })
      : null;
    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          restaurantId: customer.restaurantId, requesterId: customer.userId, subject: input.subject, description: input.description,
          topic: input.topic, priority: input.priority, module: input.module ?? null, faqArticleId: input.faqArticleId ?? null,
          assistantSessionId: session?.id ?? null, customerSeenAt: new Date(), channel,
        },
      });
      await this.attachments.claim(tx, customer.userId, input.attachmentIds, created.id, null);
      await tx.supportTicketActivity.create({ data: { ticketId: created.id, actorId: customer.userId, kind: 'CREATED', to: 'OPEN' } });
      return created;
    });
    const agents = await this.notifications.agentIds();
    await this.notifications.notify({ kind: 'TICKET_CREATED', ticketId: ticket.id, restaurantId: customer.restaurantId, recipients: agents });
    // A live chat has a customer waiting right now.
    if (input.priority === 'URGENT' || channel === 'CHAT') await this.notifications.notify({ kind: 'NEEDS_ATTENTION', ticketId: ticket.id, restaurantId: customer.restaurantId, recipients: agents });
    this.realtime.emitSupportUpdated(ticket.id);
    return this.customerTicket(customer, ticket.id);
  }

  async customerTickets(customer: TicketCustomer, query: z.output<typeof ticketsQuerySchema>): Promise<Paginated<TicketSummary>> {
    const where: Prisma.SupportTicketWhereInput = {
      restaurantId: customer.restaurantId,
      ...(customer.owner ? {} : { requesterId: customer.userId }),
      ...(query.status === 'ACTIVE' ? { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'] } } : query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supportTicket.findMany({ where, orderBy: { lastActivityAt: 'desc' }, skip: (query.page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { items: rows.map((row) => this.summary(row, 'customer')), page: query.page, pageSize: PAGE_SIZE, total };
  }

  /** The ticket as the restaurant sees it (no internal notes); opening it marks it and its notifications read. */
  async customerTicket(customer: TicketCustomer, id: string): Promise<CustomerTicket> {
    const row = await this.ownTicket(customer, id);
    await this.prisma.supportTicket.update({ where: { id }, data: { customerSeenAt: new Date() } });
    await this.notifications.markRead(customer.userId, { ticketId: id });
    const messages = await this.messages(id, false, RESTAURANT_ATTACHMENT_URL);
    return {
      ...this.summary({ ...row, customerSeenAt: new Date() }, 'customer'),
      description: row.description,
      module: row.module,
      faqQuestion: row.faqArticle?.question ?? null,
      requesterName: row.requester.fullName,
      messages,
      attachments: row.attachments.map((attachment) => this.attachments.toAttachment(attachment, RESTAURANT_ATTACHMENT_URL)),
      allowedStatuses: [...CUSTOMER_TICKET_TRANSITIONS[row.status]],
    };
  }

  /** A reply from the restaurant. It moves a ticket waiting on them back to the team, and reopens a resolved one. */
  async customerReply(customer: TicketCustomer, id: string, input: { body: string; attachmentIds: string[] }): Promise<CustomerTicket> {
    const ticket = await this.ownTicket(customer, id);
    if (ticket.status === 'CLOSED') throw ticketClosed();
    const next: TicketStatus | null = ticket.status === 'WAITING_FOR_CUSTOMER' ? (ticket.assigneeId ? 'IN_PROGRESS' : 'OPEN') : ticket.status === 'RESOLVED' ? 'OPEN' : null;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.supportMessage.create({ data: { ticketId: id, authorId: customer.userId, side: 'CUSTOMER', body: input.body } });
      await this.attachments.claim(tx, customer.userId, input.attachmentIds, id, message.id);
      await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: customer.userId, kind: 'REPLIED' } });
      if (next) {
        await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: customer.userId, kind: ticket.status === 'RESOLVED' ? 'REOPENED' : 'STATUS', from: ticket.status, to: next } });
      }
      await tx.supportTicket.update({
        where: { id },
        data: { lastActivityAt: now, lastCustomerAt: now, customerSeenAt: now, ...(next && { status: next, ...(ticket.status === 'RESOLVED' && { resolvedAt: null }) }) },
      });
    });
    await this.notifications.notify({
      kind: 'CUSTOMER_REPLIED', ticketId: id, restaurantId: ticket.restaurantId, actorId: customer.userId,
      recipients: ticket.assigneeId ? [ticket.assigneeId] : await this.notifications.agentIds(),
    });
    this.realtime.emitSupportUpdated(id, [customer.userId]);
    return this.customerTicket(customer, id);
  }

  /** The restaurant reopens a resolved ticket or closes one it no longer needs. */
  async customerStatus(customer: TicketCustomer, id: string, status: 'OPEN' | 'CLOSED'): Promise<CustomerTicket> {
    const ticket = await this.ownTicket(customer, id);
    if (!canMoveTicket('customer', ticket.status, status)) throw invalidTransition(ticket.status, status, CUSTOMER_TICKET_TRANSITIONS[ticket.status]);
    await this.move(ticket, status, customer.userId);
    this.realtime.emitSupportUpdated(id, [customer.userId]);
    if (status === 'OPEN') {
      await this.notifications.notify({
        kind: 'NEEDS_ATTENTION', ticketId: id, restaurantId: ticket.restaurantId, actorId: customer.userId,
        recipients: ticket.assigneeId ? [ticket.assigneeId] : await this.notifications.agentIds(),
      });
    }
    return this.customerTicket(customer, id);
  }

  private async ownTicket(customer: TicketCustomer, id: string): Promise<TicketRow> {
    const row = await this.prisma.supportTicket.findFirst({
      where: { id, restaurantId: customer.restaurantId, ...(customer.owner ? {} : { requesterId: customer.userId }) },
      include: ticketInclude,
    });
    if (!row) throw ticketNotFound();
    return row;
  }

  // --- Bilhanah support agents ---------------------------------------------------------------------

  async agents(): Promise<SupportAgent[]> {
    return this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, email: true } });
  }

  async agentTickets(agentId: string, query: z.output<typeof agentTicketsQuerySchema>): Promise<Paginated<AgentTicketRow> & { counts: SupportCounts }> {
    const search: Prisma.SupportTicketWhereInput = {
      ...(query.priority && { priority: query.priority }),
      ...(query.q && {
        OR: [
          { subject: { contains: query.q, mode: 'insensitive' } },
          { restaurant: { name: { contains: query.q, mode: 'insensitive' } } },
          { restaurant: { subdomain: { contains: query.q, mode: 'insensitive' } } },
          { requester: { email: { contains: query.q, mode: 'insensitive' } } },
          ...(/^(bil-)?\d+$/i.test(query.q) ? [{ number: Number(query.q.replace(/\D/g, '')) }] : []),
        ],
      }),
    };
    const where = { ...search, ...this.view(query.view, agentId) };
    const [rows, total, counts] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ lastActivityAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { restaurant: { select: { id: true, name: true, subdomain: true } }, requester: { select: { id: true, fullName: true, email: true } }, assignee: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
      Promise.all(AGENT_TICKET_VIEWS.map((view) => this.prisma.supportTicket.count({ where: { ...search, ...this.view(view, agentId) } }))),
    ]);
    return {
      items: rows.map((row) => ({ ...this.summary(row, 'agent'), restaurant: row.restaurant, requester: row.requester, assignee: row.assignee })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      counts: Object.fromEntries(AGENT_TICKET_VIEWS.map((view, index) => [view, counts[index]!])) as SupportCounts,
    };
  }

  async agentTicket(agentId: string, id: string): Promise<AgentTicket> {
    const row = await this.prisma.supportTicket.findUnique({ where: { id }, include: ticketInclude });
    if (!row) throw ticketNotFound();
    await this.prisma.supportTicket.update({ where: { id }, data: { agentSeenAt: new Date() } });
    await this.notifications.markRead(agentId, { ticketId: id });
    const [messages, activity, entitlement] = await Promise.all([
      this.messages(id, true, AGENT_ATTACHMENT_URL),
      this.prisma.supportTicketActivity.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' }, include: { actor: { select: { fullName: true } } } }),
      this.prisma.entitlement.findFirst({ where: { restaurantId: row.restaurantId }, orderBy: { endsAt: 'desc' }, select: { planCode: true } }).catch(() => null),
    ]);
    return {
      ...this.summary({ ...row, agentSeenAt: new Date() }, 'agent'),
      restaurant: { id: row.restaurant.id, name: row.restaurant.name, subdomain: row.restaurant.subdomain },
      requester: { id: row.requester.id, fullName: row.requester.fullName, email: row.requester.email },
      assignee: row.assignee,
      description: row.description,
      module: row.module,
      faqQuestion: row.faqArticle?.question ?? null,
      restaurantInfo: {
        phone: row.restaurant.phone, city: row.restaurant.city, status: row.restaurant.status, plan: entitlement?.planCode ?? null,
        ownerName: row.restaurant.owner.fullName, ownerEmail: row.restaurant.owner.email,
      },
      requesterRole: row.requester.role,
      firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      messages,
      attachments: row.attachments.map((attachment) => this.attachments.toAttachment(attachment, AGENT_ATTACHMENT_URL)),
      activity: activity.map((entry): TicketActivity => ({
        id: entry.id, kind: entry.kind, actorName: entry.actor?.fullName ?? null, from: entry.from, to: entry.to, createdAt: entry.createdAt.toISOString(),
      })),
      allowedStatuses: [...AGENT_TICKET_TRANSITIONS[row.status]],
    };
  }

  /** A public reply (sent to the restaurant) or an internal note (agents only). */
  async agentReply(agentId: string, id: string, input: { body: string; internal: boolean; attachmentIds: string[] }): Promise<AgentTicket> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw ticketNotFound();
    if (ticket.status === 'CLOSED' && !input.internal) throw ticketClosed();
    const now = new Date();
    const takeOn = !input.internal && ticket.status === 'OPEN';
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.supportMessage.create({ data: { ticketId: id, authorId: agentId, side: 'AGENT', internal: input.internal, body: input.body } });
      await this.attachments.claim(tx, agentId, input.attachmentIds, id, message.id);
      await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: agentId, kind: input.internal ? 'NOTE' : 'REPLIED' } });
      if (takeOn) await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: agentId, kind: 'STATUS', from: 'OPEN', to: 'IN_PROGRESS' } });
      await tx.supportTicket.update({
        where: { id },
        data: {
          lastActivityAt: now,
          agentSeenAt: now,
          ...(!input.internal && { lastAgentAt: now, ...(ticket.firstResponseAt === null && { firstResponseAt: now }) }),
          ...(takeOn && { status: 'IN_PROGRESS' }),
        },
      });
    });
    const customers = await this.customerRecipients(ticket);
    if (!input.internal) {
      await this.notifications.notify({ kind: 'AGENT_REPLIED', ticketId: id, restaurantId: ticket.restaurantId, recipients: customers, actorId: agentId });
    }
    // Notes stay with the agents; a reply (or taking a waiting chat) reaches the restaurant at once.
    this.realtime.emitSupportUpdated(id, input.internal ? [] : customers);
    return this.agentTicket(agentId, id);
  }

  async update(agentId: string, id: string, input: z.output<typeof updateTicketSchema>): Promise<AgentTicket> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw ticketNotFound();
    if (input.status && input.status !== ticket.status && !canMoveTicket('agent', ticket.status, input.status)) {
      throw invalidTransition(ticket.status, input.status, AGENT_TICKET_TRANSITIONS[ticket.status]);
    }
    if (input.assigneeId) {
      const assignee = await this.prisma.user.findFirst({ where: { id: input.assigneeId, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
      if (!assignee) throw new BadRequestException({ code: SUPPORT_ERROR_CODES.TICKET_ASSIGNEE_INVALID, message: 'Assign tickets to Bilhanah support agents only.' });
    }
    const assigning = input.assigneeId !== undefined && input.assigneeId !== ticket.assigneeId;
    const prioritizing = input.priority !== undefined && input.priority !== ticket.priority;
    if (assigning || prioritizing) {
      await this.prisma.$transaction(async (tx) => {
        if (assigning) {
          await tx.supportAssignment.create({ data: { ticketId: id, assigneeId: input.assigneeId ?? null, assignedById: agentId } });
          await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: agentId, kind: 'ASSIGNED', from: ticket.assigneeId, to: input.assigneeId ?? null } });
        }
        if (prioritizing) await tx.supportTicketActivity.create({ data: { ticketId: id, actorId: agentId, kind: 'PRIORITY', from: ticket.priority, to: input.priority! } });
        await tx.supportTicket.update({
          where: { id },
          data: { lastActivityAt: new Date(), ...(assigning && { assigneeId: input.assigneeId ?? null }), ...(prioritizing && { priority: input.priority }) },
        });
      });
    }
    if (input.status && input.status !== ticket.status) await this.move({ ...ticket, ...(assigning && { assigneeId: input.assigneeId ?? null }) }, input.status, agentId);

    if (assigning && input.assigneeId) {
      await this.notifications.notify({ kind: 'TICKET_ASSIGNED', ticketId: id, restaurantId: ticket.restaurantId, recipients: [input.assigneeId], actorId: agentId });
    }
    if (prioritizing && input.priority === 'URGENT') {
      const assignee = assigning ? input.assigneeId : ticket.assigneeId;
      await this.notifications.notify({ kind: 'NEEDS_ATTENTION', ticketId: id, restaurantId: ticket.restaurantId, recipients: assignee ? [assignee] : await this.notifications.agentIds(), actorId: agentId });
    }
    this.realtime.emitSupportUpdated(id, await this.customerRecipients(ticket));
    if (input.status && input.status !== ticket.status) {
      await this.notifications.notify({
        kind: input.status === 'RESOLVED' ? 'TICKET_RESOLVED' : 'STATUS_CHANGED', ticketId: id, restaurantId: ticket.restaurantId,
        recipients: await this.customerRecipients(ticket), actorId: agentId,
      });
    }
    return this.agentTicket(agentId, id);
  }

  /**
   * The live chat a conversation handed to support (its latest CHAT ticket), as the restaurant sees it.
   * Reading it marks the agent's replies seen, as the chat is on screen.
   */
  async liveChat(customer: { userId: string; restaurantId: string }, sessionId: string): Promise<LiveChat | null> {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { assistantSessionId: sessionId, restaurantId: customer.restaurantId, channel: 'CHAT' },
      orderBy: { createdAt: 'desc' },
      include: { assignee: { select: { fullName: true } } },
    });
    if (!ticket) return null;
    const ended = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';
    if (!ended && ticket.lastAgentAt && (!ticket.customerSeenAt || ticket.lastAgentAt > ticket.customerSeenAt)) {
      await this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { customerSeenAt: new Date() } });
      await this.notifications.markRead(customer.userId, { ticketId: ticket.id });
    }
    const messages = await this.messages(ticket.id, false, RESTAURANT_ATTACHMENT_URL);
    const agentName = ticket.assignee?.fullName.split(/\s+/)[0] ?? (ticket.firstResponseAt ? 'Bilhanah' : null);
    return {
      ticketId: ticket.id,
      reference: ticketReference(ticket.number),
      state: ended ? 'ENDED' : ticket.assigneeId || ticket.firstResponseAt ? 'LIVE' : 'WAITING',
      agentName,
      problem: ticket.description,
      // In a live chat the restaurant talks with a person: show the agent's first name.
      messages: messages.map((message) => (message.side === 'AGENT' && agentName ? { ...message, authorName: agentName } : message)),
      createdAt: ticket.createdAt.toISOString(),
    };
  }

  // --- Shared -----------------------------------------------------------------------------------------

  private async move(ticket: { id: string; status: TicketStatus; assigneeId: string | null }, to: TicketStatus, actorId: string) {
    const reopening = (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') && to !== 'CLOSED';
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportTicketActivity.create({ data: { ticketId: ticket.id, actorId, kind: reopening ? 'REOPENED' : 'STATUS', from: ticket.status, to } }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: to,
          lastActivityAt: now,
          ...(to === 'RESOLVED' && { resolvedAt: now }),
          ...(to === 'CLOSED' && { closedAt: now }),
          ...(reopening && { resolvedAt: null, closedAt: null }),
        },
      }),
    ]);
  }

  /** The requester and the restaurant's owner, while they are still active. */
  private async customerRecipients(ticket: { requesterId: string; restaurantId: string }): Promise<string[]> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: ticket.restaurantId }, select: { ownerId: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [ticket.requesterId, restaurant?.ownerId ?? ticket.requesterId] }, status: 'ACTIVE' }, select: { id: true } });
    return users.map((user) => user.id);
  }

  private view(view: AgentTicketView, agentId: string): Prisma.SupportTicketWhereInput {
    if (view === 'ALL') return {};
    if (view === 'MINE') return { assigneeId: agentId, status: { notIn: ['CLOSED'] } };
    if (view === 'UNASSIGNED') return { assigneeId: null, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] } };
    return { status: view };
  }

  private async messages(ticketId: string, internal: boolean, urlBase: string): Promise<TicketMessage[]> {
    const rows = await this.prisma.supportMessage.findMany({
      where: { ticketId, ...(internal ? {} : { internal: false }) },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { fullName: true } }, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.map((row) => ({
      id: row.id,
      side: row.side,
      internal: row.internal,
      // Restaurants see the team's name, not which agent answered.
      authorName: row.side === 'AGENT' && !internal ? 'Bilhanah' : row.author?.fullName ?? '',
      body: row.body,
      attachments: row.attachments.map((attachment): TicketAttachment => this.attachments.toAttachment(attachment, urlBase)),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private summary(
    row: Pick<Prisma.SupportTicketGetPayload<object>, 'id' | 'number' | 'subject' | 'topic' | 'channel' | 'priority' | 'status' | 'createdAt' | 'lastActivityAt' | 'customerSeenAt' | 'agentSeenAt' | 'lastAgentAt' | 'lastCustomerAt'>,
    side: 'customer' | 'agent',
  ): TicketSummary {
    const unread = side === 'customer'
      ? row.lastAgentAt !== null && (row.customerSeenAt === null || row.lastAgentAt > row.customerSeenAt)
      : row.agentSeenAt === null || row.lastCustomerAt > row.agentSeenAt;
    return {
      id: row.id,
      reference: ticketReference(row.number),
      subject: row.subject,
      topic: row.topic as SupportTopic,
      channel: row.channel,
      priority: row.priority as TicketPriority,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      lastActivityAt: row.lastActivityAt.toISOString(),
      unread,
    };
  }
}
