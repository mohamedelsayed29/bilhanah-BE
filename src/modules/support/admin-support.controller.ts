import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AdminFaqArticle,
  type AdminFaqCategory,
  adminFaqQuerySchema,
  type AgentTicket,
  type AgentTicketRow,
  agentReplySchema,
  agentTicketsQuerySchema,
  type FaqRevision,
  type Paginated,
  readNotificationsSchema,
  SUPPORT_LIMITS,
  type SupportAgent,
  type SupportCounts,
  type SupportNotifications,
  type TicketAttachment,
  ticketIdParamSchema,
  updateFaqArticleSchema,
  updateTicketSchema,
  upsertFaqArticleSchema,
} from '@bilhanah/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { FaqService } from './faq/faq.service.js';
import { SupportNotificationsService } from './notifications/support-notifications.service.js';
import { sendAttachment } from './support.controller.js';
import { SupportAttachmentsService } from './tickets/support-attachments.service.js';
import { AGENT_ATTACHMENT_URL, SupportTicketsService } from './tickets/support-tickets.service.js';

const idParam = new ZodValidationPipe(ticketIdParamSchema);
const WRITE_LIMIT = { name: 'admin-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** Bilhanah's support team (administrators): the support inbox, tickets, FAQ content and their notifications. */
@Controller('admin/support')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('ADMIN')
export class AdminSupportController {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly attachments: SupportAttachmentsService,
    private readonly notifications: SupportNotificationsService,
    private readonly faq: FaqService,
  ) {}

  @Get('agents')
  agents(): Promise<SupportAgent[]> {
    return this.tickets.agents();
  }

  @Get('tickets')
  @Header('Cache-Control', 'no-store')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(agentTicketsQuerySchema)) query: z.output<typeof agentTicketsQuerySchema>): Promise<Paginated<AgentTicketRow> & { counts: SupportCounts }> {
    return this.tickets.agentTickets(auth.userId, query);
  }

  @Get('tickets/:id')
  @Header('Cache-Control', 'no-store')
  ticket(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<AgentTicket> {
    return this.tickets.agentTicket(auth.userId, id);
  }

  /** A reply to the restaurant, or `internal: true` for a note only agents see. */
  @Post('tickets/:id/replies')
  @RateLimit(WRITE_LIMIT)
  reply(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(agentReplySchema)) body: z.output<typeof agentReplySchema>): Promise<AgentTicket> {
    return this.tickets.agentReply(auth.userId, id, body);
  }

  /** Status (validated transitions; reopening included), priority and assignee. */
  @Patch('tickets/:id')
  @RateLimit(WRITE_LIMIT)
  update(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateTicketSchema)) body: z.output<typeof updateTicketSchema>): Promise<AgentTicket> {
    return this.tickets.update(auth.userId, id, body);
  }

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-support-upload:ip', limit: 120, windowSeconds: 60 * 60, by: 'ip' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SUPPORT_LIMITS.attachmentBytes, files: 1, fields: 0 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined): Promise<TicketAttachment> {
    return this.attachments.upload({ userId: auth.userId, restaurantId: null }, file, AGENT_ATTACHMENT_URL);
  }

  @Get('attachments/:id')
  async attachment(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    return sendAttachment(response, await this.attachments.read(id, { userId: auth.userId, restaurantId: null, agent: true }));
  }

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  notificationList(@CurrentAuth() auth: AuthContext): Promise<SupportNotifications> {
    return this.notifications.list(auth.userId);
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(readNotificationsSchema)) body: z.output<typeof readNotificationsSchema>): Promise<void> {
    await this.notifications.markRead(auth.userId, body);
  }

  // FAQ content

  @Get('faq/categories')
  faqCategories(): Promise<AdminFaqCategory[]> {
    return this.faq.adminCategories();
  }

  @Get('faq/articles')
  @Header('Cache-Control', 'no-store')
  faqArticles(@Query(new ZodValidationPipe(adminFaqQuerySchema)) query: z.output<typeof adminFaqQuerySchema>): Promise<AdminFaqArticle[]> {
    return this.faq.adminArticles(query);
  }

  @Post('faq/articles')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE_LIMIT)
  createFaq(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(upsertFaqArticleSchema)) body: z.output<typeof upsertFaqArticleSchema>): Promise<AdminFaqArticle> {
    return this.faq.create(auth.userId, body);
  }

  @Patch('faq/articles/:id')
  @RateLimit(WRITE_LIMIT)
  updateFaq(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateFaqArticleSchema)) body: z.output<typeof updateFaqArticleSchema>): Promise<AdminFaqArticle> {
    return this.faq.update(auth.userId, id, body);
  }

  @Get('faq/articles/:id/revisions')
  revisions(@Param('id', idParam) id: string): Promise<FaqRevision[]> {
    return this.faq.revisions(id);
  }
}
