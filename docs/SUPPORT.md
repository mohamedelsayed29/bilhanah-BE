# Support: assistant, FAQ and tickets

Restaurant users get a support assistant in the dashboard that answers from a database of FAQs,
and can open a ticket for Bilhanah's support team. The team (platform administrators) works the
tickets in the admin console. No AI service is called; the assistant is built so one can be added
later without touching the dashboard, the conversation storage or the tickets.

## Modules

`src/modules/support/` (one Nest module, `SupportModule`, with clear internal parts):

| Part | Files | Responsibility |
| --- | --- | --- |
| FAQ | `faq/faq.service.ts`, `faq/faq-search.ts` | Categories and articles from the database, search, related questions, interactions and feedback; admin editing with revisions. |
| Assistant | `assistant/assistant.service.ts` | Conversations: sessions, stored messages, which provider answers. Knows nothing about FAQs or tickets. |
| Providers | `assistant/assistant-provider.ts`, `assistant/faq-assistant.provider.ts` | `AssistantProvider` interface; the FAQ provider is the only one today. |
| Tickets | `tickets/support-tickets.service.ts` | Ticket lifecycle, replies, internal notes, assignment, activity history. Independent of the assistant. |
| Attachments | `tickets/support-attachments.service.ts` | Screenshot uploads: checked by content, re-encoded as WebP, stored privately, streamed to authorized users. |
| Notifications | `notifications/support-notifications.service.ts` | In-dashboard notifications for restaurant users and agents, with read state; pluggable extra channels. |
| HTTP | `support.controller.ts` (`/v1/support`), `admin-support.controller.ts` (`/v1/admin/support`) | Restaurant side and support-team side. |

Contracts (types, zod schemas, the status transition tables) are in
`packages/contracts/src/support.ts` and shared with both frontends.

## Data model

Migration `20261116000000_support` creates the tables and the starting FAQ content (10 categories,
20 questions, each in Arabic and English).

- `faq_categories`: slug, topic, Arabic and English names, icon, order.
- `faq_articles`: one question in one language. The same question in both languages shares a `key`.
  It has an answer (Markdown subset: paragraphs, **bold**, lists, links), keywords, `related_keys`,
  whether it is `suggested` when the assistant opens, an order, `DRAFT`/`PUBLISHED`, and a version.
- `faq_revisions`: the text at each version and who saved it.
- `faq_interactions`: views, searches (query and result count) and feedback, by restaurant, user and
  assistant session. Each user has one feedback answer per article; answering again replaces it.
- `assistant_sessions`, `assistant_messages`: conversations in the unified message format (below).
  The assistant session is the support conversation; a ticket keeps the id of the session it came from.
- `support_tickets`: `BIL-{number}` (a sequence from 10001), restaurant, requester, subject,
  description, topic, priority, status, dashboard module, related FAQ, assignee, the times of the
  first response, resolution and closing, last activity, and seen/last-message times for unread markers.
- `support_messages`: replies from the restaurant or an agent. `internal` marks agent notes.
- `support_attachments`: images on a ticket or a reply. Uploads that are never sent are purged after a day
  by the maintenance worker.
- `support_assignments`: every (re)assignment, by whom.
- `support_ticket_activity`: created, status, priority, assigned, replied, note and reopened, with
  from/to values and the actor.
- `support_notifications`: one row per recipient, ticket and kind (see Notifications).

Users, restaurants, roles and permissions are the existing ones. Support agents are platform
administrators (`role = ADMIN`, signed in with an authenticator code). Restaurant access uses the new
`support.use` permission: owners and managers have it, and cashiers and waiters can be granted it.

## The assistant and its providers

```
Dashboard ──► POST /v1/support/assistant/sessions/:id/messages  { type: 'question' | 'category' | 'search' | 'message' | 'feedback' | 'home', ... }
                     │
              AssistantService  (session ownership, history, storage)
                     │  provider chosen by SUPPORT_ASSISTANT_PROVIDER
              AssistantProvider.respond(context, input) → { echo?, blocks[] }
                     │
              FaqAssistantProvider ──► FaqService (database)
```

Every message, whatever the provider, is `{ id, role, provider, blocks[], createdAt }`. The blocks are:
`text`, `answer` (an FAQ article with related questions), `suggestions`, `categories`, `results`,
`feedback`, `handoff` (offer human support: `NOT_HELPFUL`, `NO_RESULTS`, `REQUESTED`) and `ticket`
(a ticket was opened from this conversation). The dashboard only renders blocks. It never calls a
provider and never contains FAQ text.

To add an AI provider later:

1. Implement `AssistantProvider` (`name = 'ai'`, `welcome`, `respond`). `context.history` has the latest messages.
   Answer with the same blocks, and use a `handoff` block when a person should take over.
2. Add it to the `ASSISTANT_PROVIDERS` list in `support.module.ts` and to the `SUPPORT_ASSISTANT_PROVIDER` enum in `config/env.schema.ts`.
3. Set `SUPPORT_ASSISTANT_PROVIDER=ai`.

Tickets, notifications and the dashboard need no change. Tickets never import the assistant. The
controller notes the hand-off in the conversation after a ticket is created.

## Live chat with a person

`LiveChatService` (`live-chat.service.ts`) sits between the assistant and tickets. Neither of them depends on the other.

1. A message asking for a person (`wantsHuman` in `assistant/human-intent.ts`, Arabic or English, e.g. "عاوز اكلم خدمه العملاء")
   or the `{ type: 'human' }` input, sent by "Talk to our team": the assistant asks what the problem is. The session's `handoff` becomes `COLLECTING`.
2. The next typed message is the problem. It opens a ticket with `channel = CHAT`, linked to the session, and every agent gets
   `TICKET_CREATED` and `NEEDS_ATTENTION`. The assistant answers "connecting you with a representative".
3. From then on `GET /v1/support/assistant/sessions/:id` returns `live`: `WAITING` until an agent takes it (assigns it or replies),
   `LIVE` while they talk, and `ENDED` once the ticket is resolved or closed. While `live` is running, the dashboard shows only the chat,
   with a typing indicator while it waits. Assistant inputs answer 409 `LIVE_CHAT_ACTIVE`. The customer writes with
   `POST /v1/support/assistant/sessions/:id/live` `{ body }`, which is a reply on the ticket.
4. Agents work the chat as a ticket. The admin console marks it as a live chat and offers "Take the chat". Restaurants see the agent's first name.

### Realtime (Socket.IO)

Namespace `/support` on the usual path (`/v1/realtime`), with `auth { token: accessToken }`. Administrators join the agents' room.
Restaurant users with `support.use` join their own room.

- `support.updated` `{ ticketId }` (server → client): sent on every change to a ticket. Agents get every change; the requester and the owner get
  agent replies, status changes and assignments. Internal notes never reach them. Clients refetch what is on screen.
- `support.typing` (both ways): a client emits `{ ticketId }` while typing. Customer typing goes to the agents (only if the ticket is theirs);
  agent typing goes to the ticket's requester and owner with the agent's first name. Both apps show three dots for a few seconds.

Polling stays only as a fallback: every 15 s in a live chat, every 30 s elsewhere.

## Ticket lifecycle

Statuses: `OPEN`, `IN_PROGRESS`, `WAITING_FOR_CUSTOMER`, `RESOLVED`, `CLOSED`. Allowed moves are in
`AGENT_TICKET_TRANSITIONS` and `CUSTOMER_TICKET_TRANSITIONS`. Anything else is a 409 `INVALID_TICKET_TRANSITION`.

- Agents can move between all open statuses, resolve or close, and reopen a resolved or closed ticket (to `IN_PROGRESS`).
- Restaurants can close any ticket that is not closed, and reopen a resolved one (to `OPEN`).
- A restaurant reply moves a `WAITING_FOR_CUSTOMER` ticket back to the team (`IN_PROGRESS` if assigned, else `OPEN`)
  and reopens a `RESOLVED` one.
- An agent's first public reply on an `OPEN` ticket moves it to `IN_PROGRESS` and records the first-response time.
- A `CLOSED` ticket takes no public replies (409 `TICKET_CLOSED`). Internal notes are still allowed. Its history stays.

## Notifications

| Event | Who is notified | Kind |
| --- | --- | --- |
| Ticket created | every active agent | `TICKET_CREATED` (+ `NEEDS_ATTENTION` if urgent) |
| Restaurant replies | the assignee, or every agent if unassigned | `CUSTOMER_REPLIED` |
| Ticket assigned | the new assignee | `TICKET_ASSIGNED` |
| Priority set to urgent, or the restaurant reopens | the assignee, or every agent | `NEEDS_ATTENTION` |
| Agent replies (public) | the requester and the restaurant owner | `AGENT_REPLIED` |
| Status changes | the requester and the owner | `STATUS_CHANGED`, or `TICKET_RESOLVED` |

The person who caused an event is never notified about it. A row is unique per (recipient, ticket,
kind). A repeat event while the row is unread increments `count` instead of adding a duplicate. A row
that was already read becomes unread again. Opening a ticket marks its notifications read. Read state
is stored in the database. Each user only ever sees and marks their own notifications.

Delivery today is in the dashboard: `support.updated` refreshes the notifications as they happen, with polling every 30 s as a fallback. For
email or push, implement `SupportNotificationChannel` and provide it under
`SUPPORT_NOTIFICATION_CHANNELS` in `support.module.ts`.

## Security

- Restaurant endpoints require `support.use`. Everything is filtered by the caller's restaurant.
  Owners see all of the restaurant's tickets; other staff see only the tickets they opened. Another
  restaurant's ticket, session or attachment answers 404.
- Agent endpoints require `ADMIN`. Restaurant accounts get 403, and administrators get 403 on restaurant endpoints.
- Internal notes and their attachments are never returned or streamed to restaurants. Restaurants see agent replies signed "Bilhanah".
- Tickets can be assigned to active administrators only (400 `TICKET_ASSIGNEE_INVALID`).
- Attachments must be JPEG, PNG or WebP (checked by their bytes) and at most 8 MB, 5 per message.
  They are re-encoded without metadata and served with `Cache-Control: private, no-store` and `nosniff`.
  An upload can be linked once, only by its uploader.
- All input is validated with the zod schemas in contracts. Writes are rate limited.

## API

Restaurant (`Authorization: Bearer`, `support.use`), prefix `/v1/support`:

| Method | Path | |
| --- | --- | --- |
| GET | `faq/categories?lang=ar\|en` | Published categories with counts |
| GET | `faq/suggested?lang=` | Suggested questions |
| GET | `faq/search?lang=&q=&category=` | Search (records the search) |
| GET | `faq/articles/:id` | A published answer with related questions (records the view) |
| POST | `faq/articles/:id/feedback` | `{ helpful, sessionId? }` → 204 |
| POST | `assistant/sessions` | `{ lang, restart? }` → the latest conversation, or a new one with the welcome |
| GET | `assistant/sessions/:id` | The conversation |
| POST | `assistant/sessions/:id/messages` | An `AssistantInput` → the new messages |
| POST | `attachments` | multipart `file` → `TicketAttachment` |
| GET | `attachments/:id` | The image (own uploads, or the restaurant's non-internal attachments) |
| POST | `tickets` | `createTicketSchema` → `CustomerTicket` |
| GET | `tickets?status=&page=` | The caller's tickets (all of the restaurant's for owners) |
| GET | `tickets/:id` | The ticket without internal notes; marks it read |
| POST | `tickets/:id/replies` | `{ body, attachmentIds }` |
| POST | `tickets/:id/status` | `{ status: 'OPEN' \| 'CLOSED' }` |
| GET | `notifications` | `{ unread, items }` |
| POST | `notifications/read` | `{ ids } \| { all: true }` → 204 |

Support team (`ADMIN`), prefix `/v1/admin/support`:

| Method | Path | |
| --- | --- | --- |
| GET | `agents` | Assignable agents |
| GET | `tickets?view=ALL\|OPEN\|…\|MINE\|UNASSIGNED&q=&priority=&page=` | Inbox with counts per view. `q` matches subject, restaurant, requester email or `BIL-…` |
| GET | `tickets/:id` | Everything, including notes, activity, restaurant and requester info; marks it read |
| POST | `tickets/:id/replies` | `{ body, internal, attachmentIds }` |
| PATCH | `tickets/:id` | `{ status?, priority?, assigneeId? }` |
| POST/GET | `attachments`, `attachments/:id` | Agent uploads and any ticket attachment |
| GET/POST | `notifications`, `notifications/read` | The agent's notifications |
| GET | `faq/categories`, `faq/articles?lang=&status=&category=&q=` | FAQ content with views and helpfulness |
| POST/PATCH | `faq/articles`, `faq/articles/:id` | Create, or save a new version |
| GET | `faq/articles/:id/revisions` | Version history |

## Metrics

All of these come from the tables above:

- FAQ resolution rate: sessions with a helpful answer and no ticket.
- Ticket creation rate: tickets per restaurant or per assistant session.
- Average first response time: `first_response_at - created_at`.
- Average resolution time: `resolved_at - created_at`.
- Unresolved tickets: status in `OPEN`, `IN_PROGRESS`, `WAITING_FOR_CUSTOMER`.
- FAQ helpfulness: `faq_interactions` feedback.

A satisfaction score would need a rating on resolution, which this version does not collect.

## Tests

- `test/support.e2e-spec.ts`: FAQ retrieval, search, drafts, publishing and revisions; assistant
  sessions, answers, feedback and hand-off; the full ticket lifecycle with notes, assignment, transitions,
  reopening, closing and notifications (folding and read state); isolation between restaurants, staff and agents.
- `src/modules/support/support.spec.ts`: search normalization and ranking, transition tables, and provider
  selection and storage with a fake provider.
