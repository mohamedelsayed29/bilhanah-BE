import { AGENT_TICKET_TRANSITIONS, canMoveTicket, CUSTOMER_TICKET_TRANSITIONS, TICKET_STATUSES, ticketReference } from '@bilhanah/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantProvider } from './assistant/assistant-provider.js';
import { AssistantService } from './assistant/assistant.service.js';
import { wantsHuman } from './assistant/human-intent.js';
import { normalize, search, terms } from './faq/faq-search.js';

describe('FAQ search', () => {
  const articles = [
    { key: 'add', question: 'إزاي أضيف صنف جديد للمنيو؟', answer: 'من صفحة المنيو دوس ضيف صنف.', keywords: ['اضافة', 'صنف'], sortOrder: 10 },
    { key: 'qr', question: 'How do I generate a QR code for a table?', answer: 'Open the table menu.', keywords: ['qr', 'code'], sortOrder: 20 },
    { key: 'orders', question: 'How can I track incoming orders?', answer: 'Orders arrive live.', keywords: ['orders'], sortOrder: 30 },
  ];

  it('normalizes Arabic letter forms, diacritics and digits', () => {
    expect(normalize('إضافةُ الطلبات ٣')).toBe('اضافه الطلبات 3');
    expect(normalize('مُستشفى')).toBe('مستشفي');
    expect(terms('How do I add a QR?')).toEqual(['add', 'qr']);
  });

  it('ranks keyword and question matches first, matches word prefixes, and returns nothing for no match', () => {
    expect(search(articles, 'إضافه صنف').map((article) => article.key)).toEqual(['add']);
    expect(search(articles, 'qr table').map((article) => article.key)[0]).toBe('qr');
    expect(search(articles, 'order').map((article) => article.key)).toEqual(['orders']);
    expect(search(articles, 'xyz')).toEqual([]);
    expect(search(articles, '')).toEqual([]);
  });
});

describe('ticket lifecycle', () => {
  it('lets agents reopen and close, restaurants only reopen resolved tickets or close them', () => {
    for (const status of TICKET_STATUSES) expect(AGENT_TICKET_TRANSITIONS[status]).not.toContain(status);
    expect(canMoveTicket('agent', 'RESOLVED', 'IN_PROGRESS')).toBe(true);
    expect(canMoveTicket('agent', 'CLOSED', 'IN_PROGRESS')).toBe(true);
    expect(canMoveTicket('agent', 'CLOSED', 'RESOLVED')).toBe(false);
    expect(canMoveTicket('customer', 'RESOLVED', 'OPEN')).toBe(true);
    expect(canMoveTicket('customer', 'IN_PROGRESS', 'OPEN')).toBe(false);
    expect(canMoveTicket('customer', 'OPEN', 'RESOLVED')).toBe(false);
    expect(CUSTOMER_TICKET_TRANSITIONS.CLOSED).toEqual([]);
    expect(ticketReference(10482)).toBe('BIL-10482');
  });
});

describe('assistant providers', () => {
  const config = (name: string) => ({ get: () => name }) as never;
  const fake = (name: string): AssistantProvider => ({
    name,
    welcome: vi.fn(async () => [{ type: 'text' as const, text: `hello from ${name}` }]),
    respond: vi.fn(async () => ({ echo: 'hi', blocks: [{ type: 'text' as const, text: 'answer' }] })),
  });

  it('uses the provider chosen by configuration, so another one (e.g. AI) plugs in without other changes', () => {
    const faq = fake('faq');
    const ai = fake('ai');
    const service = new AssistantService({} as never, [faq, ai], config('ai'));
    service.onModuleInit();
    expect(service.providerName).toBe('ai');
    expect(() => new AssistantService({} as never, [faq], config('ai')).onModuleInit()).toThrow('No support assistant provider named "ai"');
  });

  it('stores the welcome and the replies of whichever provider answers, in the shared message format', async () => {
    const provider = fake('ai');
    const rows: { role: string; provider: string; blocks: unknown }[] = [];
    const prisma = {
      assistantSession: {
        findFirst: vi.fn(async () => ({ id: 's1', provider: 'ai', language: 'en' })),
        create: vi.fn(async () => ({ id: 's1' })),
        update: vi.fn(async () => ({})),
      },
      assistantMessage: {
        create: vi.fn(async ({ data }: { data: (typeof rows)[number] }) => {
          rows.push(data);
          return { id: `m${rows.length}`, createdAt: new Date(), ...data };
        }),
        findMany: vi.fn(async () => []),
      },
      supportTicket: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    const service = new AssistantService(prisma as never, [provider], config('ai'));
    service.onModuleInit();
    const user = { userId: 'u1', restaurantId: 'r1' };
    await service.start(user, 'en', true);
    expect(rows[0]).toMatchObject({ role: 'ASSISTANT', provider: 'ai', blocks: [{ type: 'text', text: 'hello from ai' }] });
    const messages = await service.send(user, 's1', { type: 'message', text: 'hi' });
    expect(messages.map((message) => [message.role, message.provider])).toEqual([['user', 'user'], ['assistant', 'ai']]);
    expect(provider.respond).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', userId: 'u1', restaurantId: 'r1', language: 'en' }), { type: 'message', text: 'hi' });
  });
});

describe('asking for a person', () => {
  it('recognises customer-service requests in Arabic and English, but not ordinary questions', () => {
    for (const text of ['عاوز اكلم خدمه العملاء', 'عايز أتكلم مع خدمة العملاء', 'ممكن اكلم حد من الفريق', 'محتاج اتواصل مع الدعم الفني', 'I want to talk to a human', 'customer service please', 'connect me with an agent']) {
      expect(wantsHuman(text), text).toBe(true);
    }
    for (const text of ['ازاي اضيف صنف', 'pause orders', 'how do I add a branch', 'عاوز اطبع الاكواد', 'support for QR codes']) {
      expect(wantsHuman(text), text).toBe(false);
    }
  });
});
