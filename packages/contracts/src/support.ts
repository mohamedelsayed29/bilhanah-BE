import { z } from 'zod';

/**
 * Support: a FAQ assistant in the restaurant dashboard, and tickets for Bilhanah's support team.
 *
 * The assistant speaks one message format (AssistantMessage, made of blocks) whatever answers it: today
 * the FAQ provider, later an AI provider, with human support as the hand-off. See
 * bilhanah-backend/docs/SUPPORT.md for the architecture and the API.
 */

// --- Shared -----------------------------------------------------------------

export const SUPPORT_LANGUAGES = ['ar', 'en'] as const;
export type SupportLanguage = (typeof SUPPORT_LANGUAGES)[number];

/** The topics FAQs are grouped under and tickets are filed under. */
export const SUPPORT_TOPICS = [
  'GETTING_STARTED', 'RESTAURANT_SETUP', 'MENU', 'QR_TABLES', 'ORDERS', 'PAYMENTS', 'BRANCHES', 'BILLING', 'ACCOUNT', 'TROUBLESHOOTING',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export const SUPPORT_LIMITS = {
  question: 200,
  answer: 6000,
  keywords: 20,
  keyword: 40,
  related: 8,
  search: 120,
  subject: 140,
  description: 5000,
  reply: 5000,
  attachments: 5,
  /** An image attachment, before it is re-encoded. */
  attachmentBytes: 8 * 1024 * 1024,
  module: 60,
  /** Assistant messages kept and returned for a session. */
  sessionMessages: 200,
} as const;

export const SUPPORT_ERROR_CODES = {
  FAQ_NOT_FOUND: 'FAQ_NOT_FOUND',
  FAQ_KEY_TAKEN: 'FAQ_KEY_TAKEN',
  FAQ_CATEGORY_NOT_FOUND: 'FAQ_CATEGORY_NOT_FOUND',
  ASSISTANT_SESSION_NOT_FOUND: 'ASSISTANT_SESSION_NOT_FOUND',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  /** details: { from, to, allowed } */
  INVALID_TICKET_TRANSITION: 'INVALID_TICKET_TRANSITION',
  /** A closed ticket takes no more replies; open a new one. */
  TICKET_CLOSED: 'TICKET_CLOSED',
  /** The assignee is not a Bilhanah support agent. */
  TICKET_ASSIGNEE_INVALID: 'TICKET_ASSIGNEE_INVALID',
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  ATTACHMENT_UNSUPPORTED: 'ATTACHMENT_UNSUPPORTED',
  /** A live chat with the team is running in this conversation; messages go to it. */
  LIVE_CHAT_ACTIVE: 'LIVE_CHAT_ACTIVE',
} as const;

const uuid = z.uuid();
const language = z.enum(SUPPORT_LANGUAGES);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || undefined);

// --- FAQ ----------------------------------------------------------------------

export type FaqCategory = { id: string; slug: string; topic: SupportTopic; name: string; icon: string; articleCount: number };
export type FaqArticleSummary = { id: string; key: string; question: string; categorySlug: string };
export type FaqArticle = FaqArticleSummary & {
  /** Markdown subset: paragraphs, **bold**, lists (- or 1.), and links [text](/path or https://…). */
  answer: string;
  categoryName: string;
  related: FaqArticleSummary[];
  updatedAt: string;
};

export const faqLanguageQuerySchema = z.strictObject({ lang: language.default('ar') });
export const faqSearchQuerySchema = z.strictObject({
  lang: language.default('ar'),
  q: z.string().trim().max(SUPPORT_LIMITS.search).default(''),
  category: z.string().trim().max(60).optional(),
});
export const faqFeedbackSchema = z.strictObject({ helpful: z.boolean(), sessionId: uuid.optional() });

// FAQ management (Bilhanah admins).
export const FAQ_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];
const faqKey = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);

export const upsertFaqArticleSchema = z.strictObject({
  /** The same question in each language shares a key; related questions point at keys. */
  key: faqKey,
  language,
  categoryId: uuid,
  question: text(SUPPORT_LIMITS.question),
  answer: text(SUPPORT_LIMITS.answer),
  keywords: z.array(z.string().trim().min(1).max(SUPPORT_LIMITS.keyword)).max(SUPPORT_LIMITS.keywords).default([]),
  relatedKeys: z.array(faqKey).max(SUPPORT_LIMITS.related).default([]),
  suggested: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  status: z.enum(FAQ_STATUSES).default('DRAFT'),
});
export const updateFaqArticleSchema = upsertFaqArticleSchema.partial().refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export const adminFaqQuerySchema = z.strictObject({
  lang: language.optional(),
  status: z.enum(FAQ_STATUSES).optional(),
  category: uuid.optional(),
  q: z.string().trim().max(SUPPORT_LIMITS.search).optional(),
});

export type AdminFaqCategory = { id: string; slug: string; topic: SupportTopic; nameAr: string; nameEn: string; icon: string; sortOrder: number };
export type AdminFaqArticle = {
  id: string; key: string; language: SupportLanguage; categoryId: string; question: string; answer: string; keywords: string[];
  relatedKeys: string[]; suggested: boolean; sortOrder: number; status: FaqStatus; version: number;
  views: number; helpful: number; notHelpful: number; createdAt: string; updatedAt: string;
};
export type FaqRevision = { version: number; question: string; answer: string; status: FaqStatus; editorName: string | null; createdAt: string };

// --- Assistant ------------------------------------------------------------------

/** What the user did; free text goes to the provider (the FAQ provider searches it). */
export const assistantInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('question'), articleId: uuid }),
  z.strictObject({ type: z.literal('category'), slug: z.string().trim().min(1).max(60) }),
  z.strictObject({ type: z.literal('search'), query: text(SUPPORT_LIMITS.search) }),
  z.strictObject({ type: z.literal('message'), text: text(1000) }),
  z.strictObject({ type: z.literal('home') }),
  z.strictObject({ type: z.literal('feedback'), articleId: uuid, helpful: z.boolean() }),
  /** "Talk to a person": the assistant asks for the problem, then connects a support agent. */
  z.strictObject({ type: z.literal('human') }),
]);
export type AssistantInput = z.output<typeof assistantInputSchema>;
export const startAssistantSchema = z.strictObject({ lang: language.default('ar'), restart: z.boolean().default(false) });

/** The parts of an assistant message; the UI renders blocks, never provider-specific data. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'answer'; article: FaqArticle }
  | { type: 'suggestions'; title: string; items: FaqArticleSummary[] }
  | { type: 'categories'; items: Pick<FaqCategory, 'slug' | 'name' | 'icon' | 'articleCount'>[] }
  | { type: 'results'; query: string; items: FaqArticleSummary[] }
  | { type: 'feedback'; articleId: string }
  | { type: 'handoff'; reason: 'NOT_HELPFUL' | 'NO_RESULTS' | 'REQUESTED' }
  | { type: 'ticket'; ticketId: string; reference: string };

export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Which provider wrote it (faq, later ai), or human for support hand-off notes. */
  provider: string;
  blocks: AssistantBlock[];
  createdAt: string;
};
/**
 * A live chat with the support team, opened from the assistant. While it runs, the dashboard shows only
 * this conversation: WAITING until an agent takes it, LIVE while they talk, ENDED once resolved or closed.
 */
export type LiveChat = {
  ticketId: string;
  reference: string;
  state: 'WAITING' | 'LIVE' | 'ENDED';
  /** The agent's first name, once someone has taken the chat. */
  agentName: string | null;
  problem: string;
  messages: TicketMessage[];
  createdAt: string;
};
export type AssistantSession = {
  id: string;
  provider: string;
  language: SupportLanguage;
  ticketId: string | null;
  /** COLLECTING: the customer asked for a person; their next message is the problem. */
  handoff: 'NONE' | 'COLLECTING';
  live: LiveChat | null;
  messages: AssistantMessage[];
};
export const liveChatMessageSchema = z.strictObject({ body: text(SUPPORT_LIMITS.reply) });

// --- Tickets ----------------------------------------------------------------------

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const OPEN_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] as const satisfies readonly TicketStatus[];
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Where Bilhanah's support agents can move a ticket from each status (reopening included). */
export const AGENT_TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: ['IN_PROGRESS'],
};
/** What the restaurant can do itself: reopen a resolved ticket, or close one it no longer needs. */
export const CUSTOMER_TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['CLOSED'],
  IN_PROGRESS: ['CLOSED'],
  WAITING_FOR_CUSTOMER: ['CLOSED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};
export const canMoveTicket = (side: 'agent' | 'customer', from: TicketStatus, to: TicketStatus) =>
  (side === 'agent' ? AGENT_TICKET_TRANSITIONS : CUSTOMER_TICKET_TRANSITIONS)[from].includes(to);

/** "BIL-10482" */
export const ticketReference = (number: number) => `BIL-${number}`;

export const createTicketSchema = z.strictObject({
  subject: text(SUPPORT_LIMITS.subject),
  description: text(SUPPORT_LIMITS.description),
  topic: z.enum(SUPPORT_TOPICS),
  priority: z.enum(TICKET_PRIORITIES).default('NORMAL'),
  /** The FAQ that did not help, when the ticket comes from one. */
  faqArticleId: uuid.optional(),
  /** The dashboard page it is about, e.g. "menu" or "tables". */
  module: optionalText(SUPPORT_LIMITS.module),
  assistantSessionId: uuid.optional(),
  attachmentIds: z.array(uuid).max(SUPPORT_LIMITS.attachments).default([]).transform((ids) => [...new Set(ids)]),
});
export const ticketReplySchema = z.strictObject({
  body: text(SUPPORT_LIMITS.reply),
  attachmentIds: z.array(uuid).max(SUPPORT_LIMITS.attachments).default([]).transform((ids) => [...new Set(ids)]),
});
export const customerTicketStatusSchema = z.strictObject({ status: z.enum(['OPEN', 'CLOSED']) });
export const ticketsQuerySchema = z.strictObject({
  status: z.enum([...TICKET_STATUSES, 'ACTIVE']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export const ticketIdParamSchema = uuid;

export type TicketAttachment = { id: string; fileName: string; contentType: string; bytes: number; width: number; height: number; url: string };
export type TicketMessage = {
  id: string;
  side: 'CUSTOMER' | 'AGENT';
  /** Agent notes for the support team; never sent to restaurants. */
  internal: boolean;
  authorName: string;
  body: string;
  attachments: TicketAttachment[];
  createdAt: string;
};
export const TICKET_ACTIVITY_KINDS = ['CREATED', 'STATUS', 'PRIORITY', 'ASSIGNED', 'REPLIED', 'NOTE', 'REOPENED'] as const;
export type TicketActivityKind = (typeof TICKET_ACTIVITY_KINDS)[number];
export type TicketActivity = { id: string; kind: TicketActivityKind; actorName: string | null; from: string | null; to: string | null; createdAt: string };

export const SUPPORT_CHANNELS = ['FORM', 'CHAT'] as const;
export type SupportChannel = (typeof SUPPORT_CHANNELS)[number];

export type TicketSummary = {
  id: string;
  reference: string;
  subject: string;
  topic: SupportTopic;
  /** CHAT: a live chat from the assistant, waiting for or talking with an agent. */
  channel: SupportChannel;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  lastActivityAt: string;
  /** Agent replies the restaurant has not opened yet (for restaurants) or customer messages (for agents). */
  unread: boolean;
};
export type CustomerTicket = TicketSummary & {
  description: string;
  module: string | null;
  faqQuestion: string | null;
  requesterName: string;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
  allowedStatuses: TicketStatus[];
};

// Support agents (Bilhanah admins).
export const AGENT_TICKET_VIEWS = ['ALL', ...TICKET_STATUSES, 'MINE', 'UNASSIGNED'] as const;
export type AgentTicketView = (typeof AGENT_TICKET_VIEWS)[number];
export const agentTicketsQuerySchema = z.strictObject({
  view: z.enum(AGENT_TICKET_VIEWS).default('ALL'),
  q: z.string().trim().max(SUPPORT_LIMITS.search).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().pipe(z.union([z.literal(10), z.literal(25), z.literal(50)])).default(10),
});
export const AGENT_PAGE_SIZES = [10, 25, 50] as const;
export const updateTicketSchema = z.strictObject({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  /** null unassigns. */
  assigneeId: uuid.nullable().optional(),
}).refine((value) => value.status !== undefined || value.priority !== undefined || value.assigneeId !== undefined, 'Nothing to update.');
export const agentReplySchema = ticketReplySchema.extend({ internal: z.boolean().default(false) });

export type SupportAgent = { id: string; fullName: string; email: string };
export type AgentTicketRow = TicketSummary & {
  restaurant: { id: string; name: string; subdomain: string };
  requester: { id: string; fullName: string; email: string };
  assignee: SupportAgent | null;
};
export type AgentTicket = AgentTicketRow & {
  description: string;
  module: string | null;
  faqQuestion: string | null;
  restaurantInfo: { phone: string; city: string; status: string; plan: string | null; ownerName: string; ownerEmail: string };
  requesterRole: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
  activity: TicketActivity[];
  allowedStatuses: TicketStatus[];
};
export type SupportCounts = Record<AgentTicketView, number>;

// --- Notifications ----------------------------------------------------------------

export const SUPPORT_NOTIFICATION_KINDS = [
  'TICKET_CREATED', 'CUSTOMER_REPLIED', 'TICKET_ASSIGNED', 'NEEDS_ATTENTION', 'AGENT_REPLIED', 'STATUS_CHANGED', 'TICKET_RESOLVED',
] as const;
export type SupportNotificationKind = (typeof SUPPORT_NOTIFICATION_KINDS)[number];
export type SupportNotification = {
  id: string;
  kind: SupportNotificationKind;
  ticketId: string;
  reference: string;
  subject: string;
  restaurantName: string | null;
  /** Events folded into this one since it was last read. */
  count: number;
  read: boolean;
  updatedAt: string;
};
export type SupportNotifications = { unread: number; items: SupportNotification[] };
export const readNotificationsSchema = z.strictObject({ ids: z.array(uuid).max(200).optional(), all: z.boolean().optional() })
  .refine((value) => value.all || value.ids?.length, 'Pick notifications or all.');

// --- Realtime ---------------------------------------------------------------------

/**
 * Socket.IO namespace for support (same path as the rest, REALTIME_PATH), auth { token: accessToken }.
 * Restaurant users hear about their own tickets and live chats; administrators about every ticket.
 */
export const SUPPORT_NAMESPACE = '/support';
export const SUPPORT_EVENTS = {
  /** Server → client: something changed on this ticket (reply, status, assignment); fetch it again. */
  UPDATED: 'support.updated',
  /** Both ways: someone is typing in this ticket's conversation (client → server: { ticketId }). */
  TYPING: 'support.typing',
} as const;
export type SupportUpdatedEvent = { ticketId: string };
export type SupportTypingEvent = { ticketId: string; side: 'CUSTOMER' | 'AGENT'; name: string | null };
