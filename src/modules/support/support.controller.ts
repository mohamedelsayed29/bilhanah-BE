import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AssistantMessage,
  assistantInputSchema,
  type AssistantSession,
  createTicketSchema,
  customerTicketStatusSchema,
  type CustomerTicket,
  type FaqArticle,
  type FaqArticleSummary,
  type FaqCategory,
  faqFeedbackSchema,
  faqLanguageQuerySchema,
  faqSearchQuerySchema,
  liveChatMessageSchema,
  type Paginated,
  readNotificationsSchema,
  startAssistantSchema,
  SUPPORT_LIMITS,
  type SupportNotifications,
  type TicketAttachment,
  ticketIdParamSchema,
  ticketReplySchema,
  ticketsQuerySchema,
  type TicketSummary,
} from '@bilhanah/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { AssistantService } from './assistant/assistant.service.js';
import { FaqService } from './faq/faq.service.js';
import { LiveChatService } from './live-chat.service.js';
import { SupportNotificationsService } from './notifications/support-notifications.service.js';
import { SupportAttachmentsService } from './tickets/support-attachments.service.js';
import { RESTAURANT_ATTACHMENT_URL, SupportTicketsService, type TicketCustomer } from './tickets/support-tickets.service.js';

const idParam = new ZodValidationPipe(ticketIdParamSchema);
const WRITE_LIMIT = { name: 'support-write:ip', limit: 120, windowSeconds: 60, by: 'ip' } as const;

export function sendAttachment(response: Response, file: { data: Buffer; contentType: string }): StreamableFile {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Disposition', 'inline; filename="attachment.webp"');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return new StreamableFile(file.data, { type: file.contentType });
}
/**
 * The restaurant side of support (support.use): the FAQ, the assistant, the restaurant's tickets and
 * its support notifications. Everything is scoped to the caller's restaurant, and to the caller's own
 * tickets unless they own the restaurant.
 */
@Controller('support')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequirePermission('support.use')
export class SupportController {
  constructor(
    private readonly scopes: BranchScopeService,
    private readonly faq: FaqService,
    private readonly assistant: AssistantService,
    private readonly tickets: SupportTicketsService,
    private readonly attachments: SupportAttachmentsService,
    private readonly notifications: SupportNotificationsService,
    private readonly liveChat: LiveChatService,
  ) {}

  private async customer(auth: AuthContext): Promise<TicketCustomer> {
    const scope = await this.scopes.resolve(auth.userId);
    return { userId: auth.userId, restaurantId: scope.restaurant.id, owner: scope.role === 'OWNER' };
  }

  // FAQ

  @Get('faq/categories')
  categories(@Query(new ZodValidationPipe(faqLanguageQuerySchema)) query: z.output<typeof faqLanguageQuerySchema>): Promise<FaqCategory[]> {
    return this.faq.categories(query.lang);
  }

  @Get('faq/suggested')
  suggested(@Query(new ZodValidationPipe(faqLanguageQuerySchema)) query: z.output<typeof faqLanguageQuerySchema>): Promise<FaqArticleSummary[]> {
    return this.faq.suggested(query.lang);
  }

  @Get('faq/search')
  async search(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(faqSearchQuerySchema)) query: z.output<typeof faqSearchQuerySchema>): Promise<FaqArticleSummary[]> {
    const customer = await this.customer(auth);
    if (!query.q) return query.category ? (await this.faq.inCategory(query.lang, query.category))?.items ?? [] : this.faq.suggested(query.lang);
    return this.faq.search(query.lang, query.q, customer, query.category);
  }

  @Get('faq/articles/:id')
  async article(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<FaqArticle> {
    return this.faq.article(id, await this.customer(auth));
  }

  @Post('faq/articles/:id/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  async feedback(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(faqFeedbackSchema)) body: z.output<typeof faqFeedbackSchema>): Promise<void> {
    await this.faq.feedback(id, body.helpful, await this.customer(auth), body.sessionId);
  }

  // Assistant

  /** The caller's latest conversation (or a new one with the welcome); restart starts over. */
  @Post('assistant/sessions')
  @RateLimit(WRITE_LIMIT)
  async start(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(startAssistantSchema)) body: z.output<typeof startAssistantSchema>): Promise<AssistantSession> {
    return this.liveChat.start(await this.customer(auth), body.lang, body.restart);
  }

  @Get('assistant/sessions/:id')
  @Header('Cache-Control', 'no-store')
  async session(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<AssistantSession> {
    return this.liveChat.session(await this.customer(auth), id);
  }

  @Post('assistant/sessions/:id/messages')
  @RateLimit(WRITE_LIMIT)
  async send(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(assistantInputSchema)) body: z.output<typeof assistantInputSchema>): Promise<AssistantMessage[]> {
    return this.liveChat.send(await this.customer(auth), id, body);
  }

  /** The customer's message in the conversation's live chat with the team. */
  @Post('assistant/sessions/:id/live')
  @RateLimit(WRITE_LIMIT)
  async live(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(liveChatMessageSchema)) body: z.output<typeof liveChatMessageSchema>): Promise<AssistantSession> {
    return this.liveChat.reply(await this.customer(auth), id, body.body);
  }

  // Tickets

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'support-upload:ip', limit: 60, windowSeconds: 60 * 60, by: 'ip' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SUPPORT_LIMITS.attachmentBytes, files: 1, fields: 0 } }))
  async upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined): Promise<TicketAttachment> {
    const customer = await this.customer(auth);
    return this.attachments.upload({ userId: auth.userId, restaurantId: customer.restaurantId }, file, RESTAURANT_ATTACHMENT_URL);
  }

  @Get('attachments/:id')
  async attachment(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    const customer = await this.customer(auth);
    return sendAttachment(response, await this.attachments.read(id, { userId: auth.userId, restaurantId: customer.restaurantId, agent: false }));
  }

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'support-ticket:ip', limit: 20, windowSeconds: 60 * 60, by: 'ip' })
  async create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createTicketSchema)) body: z.output<typeof createTicketSchema>): Promise<CustomerTicket> {
    const customer = await this.customer(auth);
    const ticket = await this.tickets.create(customer, body);
    // The conversation shows the hand-off; the ticket itself does not depend on the assistant.
    if (body.assistantSessionId) await this.assistant.noteTicket(customer, body.assistantSessionId, { id: ticket.id, reference: ticket.reference });
    return ticket;
  }

  @Get('tickets')
  @Header('Cache-Control', 'no-store')
  async list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(ticketsQuerySchema)) query: z.output<typeof ticketsQuerySchema>): Promise<Paginated<TicketSummary>> {
    return this.tickets.customerTickets(await this.customer(auth), query);
  }

  @Get('tickets/:id')
  @Header('Cache-Control', 'no-store')
  async ticket(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<CustomerTicket> {
    return this.tickets.customerTicket(await this.customer(auth), id);
  }

  @Post('tickets/:id/replies')
  @RateLimit(WRITE_LIMIT)
  async reply(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(ticketReplySchema)) body: z.output<typeof ticketReplySchema>): Promise<CustomerTicket> {
    return this.tickets.customerReply(await this.customer(auth), id, body);
  }

  /** { status: 'OPEN' } reopens a resolved ticket; { status: 'CLOSED' } closes it. */
  @Post('tickets/:id/status')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  async status(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(customerTicketStatusSchema)) body: z.output<typeof customerTicketStatusSchema>): Promise<CustomerTicket> {
    return this.tickets.customerStatus(await this.customer(auth), id, body.status);
  }

  // Notifications

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  async notificationList(@CurrentAuth() auth: AuthContext): Promise<SupportNotifications> {
    await this.customer(auth);
    return this.notifications.list(auth.userId);
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(readNotificationsSchema)) body: z.output<typeof readNotificationsSchema>): Promise<void> {
    await this.notifications.markRead(auth.userId, body);
  }
}
