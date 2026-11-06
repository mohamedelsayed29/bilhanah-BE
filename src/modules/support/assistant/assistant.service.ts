import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AssistantBlock,
  type AssistantInput,
  type AssistantMessage,
  type AssistantSession,
  SUPPORT_ERROR_CODES,
  SUPPORT_LIMITS,
  type SupportLanguage,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { Env } from '../../../config/env.schema.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { ASSISTANT_PROVIDERS, type AssistantContext, type AssistantProvider } from './assistant-provider.js';

const sessionNotFound = () =>
  new NotFoundException({ code: SUPPORT_ERROR_CODES.ASSISTANT_SESSION_NOT_FOUND, message: 'This conversation was not found.' });

/** The restaurant user talking to the assistant. */
export type AssistantUser = { userId: string; restaurantId: string };

/** Messages a provider sees as context. */
const HISTORY = 20;

/**
 * Conversations with the support assistant: sessions, stored messages and which provider answers. It
 * knows nothing about FAQs (the provider does) or tickets (it only records that one was opened).
 */
@Injectable()
export class AssistantService implements OnModuleInit {
  private provider!: AssistantProvider;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ASSISTANT_PROVIDERS) private readonly providers: AssistantProvider[],
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    const name = this.config.get('SUPPORT_ASSISTANT_PROVIDER', { infer: true });
    const provider = this.providers.find((candidate) => candidate.name === name);
    if (!provider) throw new Error(`No support assistant provider named "${name}" is registered.`);
    this.provider = provider;
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** The user's latest conversation in this language, or a new one that starts with the welcome. */
  async start(user: AssistantUser, language: SupportLanguage, restart: boolean): Promise<AssistantSession> {
    if (!restart) {
      const latest = await this.prisma.assistantSession.findFirst({
        where: { userId: user.userId, restaurantId: user.restaurantId, language },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (latest) return this.session(user, latest.id);
    }
    const session = await this.prisma.assistantSession.create({ data: { userId: user.userId, restaurantId: user.restaurantId, provider: this.provider.name, language } });
    const blocks = await this.provider.welcome(this.context(user, session.id, language, []));
    await this.prisma.assistantMessage.create({ data: { sessionId: session.id, role: 'ASSISTANT', provider: this.provider.name, blocks: blocks as Prisma.InputJsonValue } });
    return this.session(user, session.id);
  }

  async session(user: AssistantUser, id: string): Promise<AssistantSession> {
    const session = await this.owned(user, id);
    const messages = await this.prisma.assistantMessage.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'desc' }, take: SUPPORT_LIMITS.sessionMessages });
    const ticket = await this.prisma.supportTicket.findFirst({ where: { assistantSessionId: id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return {
      id: session.id,
      provider: session.provider,
      language: session.language,
      ticketId: ticket?.id ?? null,
      handoff: session.handoff,
      // Filled in by LiveChatService, which knows about tickets.
      live: null,
      messages: messages.reverse().map((message) => this.toMessage(message)),
    };
  }

  /** The session's language and hand-off step, checking it is this user's. */
  async state(user: AssistantUser, id: string) {
    const session = await this.owned(user, id);
    return { language: session.language, handoff: session.handoff };
  }

  async setHandoff(id: string, handoff: 'NONE' | 'COLLECTING'): Promise<void> {
    await this.prisma.assistantSession.update({ where: { id }, data: { handoff } });
  }

  /**
   * Adds messages written outside the provider (the user's own words, and the hand-off to a person),
   * in the same format; returns them.
   */
  async append(user: AssistantUser, id: string, messages: { role: 'USER' | 'ASSISTANT' | 'SYSTEM'; provider: string; blocks: AssistantBlock[] }[]): Promise<AssistantMessage[]> {
    await this.owned(user, id);
    const now = Date.now();
    const rows = await this.prisma.$transaction([
      ...messages.map((message, index) => this.prisma.assistantMessage.create({
        data: { sessionId: id, role: message.role, provider: message.provider, blocks: message.blocks as Prisma.InputJsonValue, createdAt: new Date(now + index) },
      })),
      this.prisma.assistantSession.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);
    return rows.slice(0, messages.length).map((row) => this.toMessage(row as Prisma.AssistantMessageGetPayload<object>));
  }

  /** Records the user's step and the provider's answer; returns both. */
  async send(user: AssistantUser, id: string, input: AssistantInput): Promise<AssistantMessage[]> {
    const session = await this.owned(user, id);
    const recent = await this.prisma.assistantMessage.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'desc' }, take: HISTORY });
    const reply = await this.provider.respond(this.context(user, id, session.language, recent.reverse().map((message) => this.toMessage(message))), input);
    const created: Prisma.AssistantMessageCreateManyInput[] = [];
    const now = Date.now();
    if (reply.echo) created.push({ sessionId: id, role: 'USER', provider: 'user', blocks: [{ type: 'text', text: reply.echo }], createdAt: new Date(now) });
    created.push({ sessionId: id, role: 'ASSISTANT', provider: this.provider.name, blocks: reply.blocks as Prisma.InputJsonValue, createdAt: new Date(now + 1) });
    const rows = await this.prisma.$transaction([
      ...created.map((data) => this.prisma.assistantMessage.create({ data })),
      this.prisma.assistantSession.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);
    return rows.slice(0, created.length).map((row) => this.toMessage(row as Prisma.AssistantMessageGetPayload<object>));
  }

  /** Notes in the conversation that a ticket was opened from it (the hand-off to human support). */
  async noteTicket(user: AssistantUser, id: string, ticket: { id: string; reference: string }): Promise<void> {
    const session = await this.prisma.assistantSession.findFirst({ where: { id, userId: user.userId, restaurantId: user.restaurantId }, select: { id: true } });
    if (!session) return;
    const blocks: AssistantBlock[] = [{ type: 'ticket', ticketId: ticket.id, reference: ticket.reference }];
    await this.prisma.assistantMessage.create({ data: { sessionId: id, role: 'SYSTEM', provider: 'human', blocks: blocks as Prisma.InputJsonValue } });
  }

  /** The session if it is this user's, in their restaurant. */
  private async owned(user: AssistantUser, id: string) {
    const session = await this.prisma.assistantSession.findFirst({ where: { id, userId: user.userId, restaurantId: user.restaurantId } });
    if (!session) throw sessionNotFound();
    return session;
  }

  private context(user: AssistantUser, sessionId: string, language: SupportLanguage, history: AssistantMessage[]): AssistantContext {
    return { sessionId, language, userId: user.userId, restaurantId: user.restaurantId, history };
  }

  private toMessage(row: Prisma.AssistantMessageGetPayload<object>): AssistantMessage {
    return {
      id: row.id,
      role: row.role === 'USER' ? 'user' : row.role === 'SYSTEM' ? 'system' : 'assistant',
      provider: row.provider,
      blocks: row.blocks as AssistantBlock[],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
