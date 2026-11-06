import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminSupportController } from './admin-support.controller.js';
import { ASSISTANT_PROVIDERS } from './assistant/assistant-provider.js';
import { AssistantService } from './assistant/assistant.service.js';
import { FaqAssistantProvider } from './assistant/faq-assistant.provider.js';
import { FaqService } from './faq/faq.service.js';
import { LiveChatService } from './live-chat.service.js';
import { SUPPORT_NOTIFICATION_CHANNELS, SupportNotificationsService } from './notifications/support-notifications.service.js';
import { SupportController } from './support.controller.js';
import { SupportAttachmentsService } from './tickets/support-attachments.service.js';
import { SupportTicketsService } from './tickets/support-tickets.service.js';

/**
 * Support: FAQ (FaqService), the assistant (AssistantService + providers), tickets, attachments and
 * notifications. To add an AI provider later, implement AssistantProvider, add it to the
 * ASSISTANT_PROVIDERS list below and set SUPPORT_ASSISTANT_PROVIDER; nothing else changes.
 */
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [SupportController, AdminSupportController],
  providers: [
    FaqService,
    FaqAssistantProvider,
    { provide: ASSISTANT_PROVIDERS, useFactory: (faq: FaqAssistantProvider) => [faq], inject: [FaqAssistantProvider] },
    AssistantService,
    SupportAttachmentsService,
    // Extra delivery channels (email, push) go here; the dashboard needs none.
    { provide: SUPPORT_NOTIFICATION_CHANNELS, useValue: [] },
    SupportNotificationsService,
    SupportTicketsService,
    LiveChatService,
  ],
  exports: [SupportAttachmentsService],
})
export class SupportModule {}
