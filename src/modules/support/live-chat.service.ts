import { ConflictException, Injectable } from '@nestjs/common';
import { type AssistantInput, type AssistantMessage, type AssistantSession, SUPPORT_ERROR_CODES, type SupportLanguage } from '@bilhanah/contracts';
import { AssistantService } from './assistant/assistant.service.js';
import { wantsHuman } from './assistant/human-intent.js';
import { SupportTicketsService, type TicketCustomer } from './tickets/support-tickets.service.js';

const COPY = {
  connecting: ['شكرًا، وصلتني المشكلة. جاري التواصل مع أحد ممثلي خدمة العملاء…', 'Thanks, I have your problem. Connecting you with a customer service representative…'],
  human: ['عاوز أكلم خدمة العملاء', 'I want to talk to customer service'],
  transferring: ['جاري تحويلك إلى أحد ممثلي خدمة العملاء…', 'Transferring you to a customer service representative…'],
  subject: ['طلب محادثة مع خدمة العملاء', 'Chat request with customer service'],
  context: ['آخر اللي العميل سأل عنه في المساعد:', 'What the customer last asked the assistant:'],
} as const;
const t = (language: SupportLanguage, key: keyof typeof COPY) => COPY[key][language === 'ar' ? 0 : 1];

/**
 * The hand-off from the assistant to a person. "Talk to customer service" (typed or tapped) transfers the
 * conversation at once: it opens a CHAT ticket (with what the customer asked the assistant before), and the dashboard
 * shows only the live chat (the ticket's public messages) until the ticket is resolved or closed.
 * The provider never sees any of this, and tickets stay their own module.
 */
@Injectable()
export class LiveChatService {
  constructor(
    private readonly assistant: AssistantService,
    private readonly tickets: SupportTicketsService,
  ) {}

  async session(customer: TicketCustomer, sessionId: string): Promise<AssistantSession> {
    const [session, live] = await Promise.all([this.assistant.session(customer, sessionId), this.tickets.liveChat(customer, sessionId)]);
    return { ...session, live };
  }

  async start(customer: TicketCustomer, language: SupportLanguage, restart: boolean): Promise<AssistantSession> {
    const session = await this.assistant.start(customer, language, restart);
    return { ...session, live: await this.tickets.liveChat(customer, session.id) };
  }

  /** A step in the conversation: the hand-off when someone is asked for, the provider otherwise. */
  async send(customer: TicketCustomer, sessionId: string, input: AssistantInput): Promise<AssistantMessage[]> {
    const { language, handoff } = await this.assistant.state(customer, sessionId);
    const live = await this.tickets.liveChat(customer, sessionId);
    if (live && live.state !== 'ENDED') throw this.inLiveChat();
    const typed = input.type === 'message' ? input.text : input.type === 'search' ? input.query : null;

    // Conversations from before transfers were immediate may still be waiting for the problem.
    if (handoff === 'COLLECTING' && typed !== null) {
      const ticket = await this.tickets.create(customer, {
        subject: typed.replace(/\s+/g, ' ').trim().slice(0, 120),
        description: typed,
        topic: 'TROUBLESHOOTING',
        priority: 'NORMAL',
        module: undefined,
        assistantSessionId: sessionId,
        attachmentIds: [],
      }, 'CHAT');
      await this.assistant.setHandoff(sessionId, 'NONE');
      return this.assistant.append(customer, sessionId, [
        { role: 'USER', provider: 'user', blocks: [{ type: 'text', text: typed }] },
        { role: 'ASSISTANT', provider: 'human', blocks: [{ type: 'text', text: t(language, 'connecting') }] },
        { role: 'SYSTEM', provider: 'human', blocks: [{ type: 'ticket', ticketId: ticket.id, reference: ticket.reference }] },
      ]);
    }
    // Asking for a person transfers the conversation straight away; the problem is told in the chat.
    if (input.type === 'human' || (typed !== null && wantsHuman(typed))) {
      const request = typed ?? t(language, 'human');
      // The agent sees what the customer asked the assistant before, so they need not ask again.
      const earlier = (await this.assistant.session(customer, sessionId)).messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
        .slice(-5);
      const ticket = await this.tickets.create(customer, {
        subject: t(language, 'subject'),
        description: earlier.length ? `${request}\n\n${t(language, 'context')}\n${earlier.map((line) => `- ${line}`).join('\n')}` : request,
        topic: 'TROUBLESHOOTING',
        priority: 'NORMAL',
        module: undefined,
        assistantSessionId: sessionId,
        attachmentIds: [],
      }, 'CHAT');
      await this.assistant.setHandoff(sessionId, 'NONE');
      return this.assistant.append(customer, sessionId, [
        { role: 'USER', provider: 'user', blocks: [{ type: 'text', text: request }] },
        { role: 'ASSISTANT', provider: 'human', blocks: [{ type: 'text', text: t(language, 'transferring') }] },
        { role: 'SYSTEM', provider: 'human', blocks: [{ type: 'ticket', ticketId: ticket.id, reference: ticket.reference }] },
      ]);
    }
    // Anything else (a question, a topic, "start over") leaves the hand-off and goes to the provider.
    if (handoff === 'COLLECTING') await this.assistant.setHandoff(sessionId, 'NONE');
    return this.assistant.send(customer, sessionId, input);
  }

  /** The customer's message in a running live chat (a reply on its ticket). */
  async reply(customer: TicketCustomer, sessionId: string, body: string): Promise<AssistantSession> {
    await this.assistant.state(customer, sessionId);
    const live = await this.tickets.liveChat(customer, sessionId);
    if (!live || live.state === 'ENDED') {
      throw new ConflictException({ code: SUPPORT_ERROR_CODES.TICKET_CLOSED, message: 'This chat has ended. Start a new conversation.' });
    }
    await this.tickets.customerReply(customer, live.ticketId, { body, attachmentIds: [] });
    return this.session(customer, sessionId);
  }

  private inLiveChat() {
    return new ConflictException({ code: SUPPORT_ERROR_CODES.LIVE_CHAT_ACTIVE, message: 'You are chatting with our team; send your message in the chat.' });
  }
}
