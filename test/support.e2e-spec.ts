import sharp from 'sharp';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Summary = { id: string; key: string; question: string };

async function restaurant(email: string, subdomain: string) {
  const token = await signUpOwner(t, email);
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: `R ${subdomain}`, contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  return token;
}

async function staff(owner: string, email: string, role: 'CASHIER' | 'WAITER', permissions: string[] = []) {
  await http().post('/v1/kitchen-accounts').set(auth(owner)).send({ fullName: `${role} One`, email, password: 'staff-password', role, permissions }).expect(201);
  return (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200)).body.accessToken as string;
}

const png = () => sharp({ create: { width: 500, height: 400, channels: 3, background: '#F45164' } }).png().toBuffer();

beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); });
beforeEach(async () => {
  await t.reset();
  await t.prisma.faqArticle.deleteMany({ where: { key: { startsWith: 'e2e-' } } });
});

describe('support FAQ', () => {
  it('serves published FAQs from the database by language, searches them, and lets admins edit them with revisions', async () => {
    const owner = await restaurant('owner@koshary.test', 'koshary');

    const categories = (await http().get('/v1/support/faq/categories?lang=ar').set(auth(owner)).expect(200)).body;
    expect(categories.map((category: { slug: string }) => category.slug)).toEqual(expect.arrayContaining(['menu', 'qr-tables', 'orders', 'branches']));
    expect(categories.find((category: { slug: string }) => category.slug === 'menu').name).toBe('إدارة المنيو');
    expect((await http().get('/v1/support/faq/categories?lang=en').set(auth(owner)).expect(200)).body[0].name).toBe('Getting started');

    const suggested: Summary[] = (await http().get('/v1/support/faq/suggested?lang=en').set(auth(owner)).expect(200)).body;
    expect(suggested.map((entry) => entry.question)).toEqual(expect.arrayContaining(['How can I add a new menu item?', 'How do I generate a QR code for a table?']));

    // Arabic search ignores hamza and diacritics forms; English search matches keywords.
    const arabic: Summary[] = (await http().get(`/v1/support/faq/search?lang=ar&q=${encodeURIComponent('إضافه صنف جديد')}`).set(auth(owner)).expect(200)).body;
    expect(arabic[0]!.key).toBe('add-menu-item');
    const english: Summary[] = (await http().get('/v1/support/faq/search?lang=en&q=print%20qr%20codes').set(auth(owner)).expect(200)).body;
    expect(english.map((entry) => entry.key).slice(0, 2)).toEqual(expect.arrayContaining(['print-table-codes']));
    expect((await http().get('/v1/support/faq/search?lang=en&q=zzzz').set(auth(owner)).expect(200)).body).toEqual([]);

    const article = (await http().get(`/v1/support/faq/articles/${arabic[0]!.id}`).set(auth(owner)).expect(200)).body;
    expect(article.answer).toContain('[المنيو](/menu)');
    expect(article.related.map((entry: Summary) => entry.key)).toEqual(['sold-out-item', 'item-photo', 'first-steps']);
    await http().post(`/v1/support/faq/articles/${article.id}/feedback`).set(auth(owner)).send({ helpful: false }).expect(204);
    await http().post(`/v1/support/faq/articles/${article.id}/feedback`).set(auth(owner)).send({ helpful: true }).expect(204);

    // Admins write a draft (invisible to restaurants), then publish it: no deploy needed.
    const { token: admin } = await signInAdmin(t);
    const menu = (await http().get('/v1/admin/support/faq/categories').set(auth(admin)).expect(200)).body.find((category: { slug: string }) => category.slug === 'menu');
    const draft = (await http().post('/v1/admin/support/faq/articles').set(auth(admin))
      .send({ key: 'e2e-combo', language: 'en', categoryId: menu.id, question: 'How do I make a combo meal?', answer: 'Add a dish with sizes.', keywords: ['combo'] }).expect(201)).body;
    expect(draft).toMatchObject({ status: 'DRAFT', version: 1 });
    await http().get(`/v1/support/faq/articles/${draft.id}`).set(auth(owner)).expect(404);
    expect((await http().get('/v1/support/faq/search?lang=en&q=combo').set(auth(owner)).expect(200)).body).toEqual([]);
    await http().post('/v1/admin/support/faq/articles').set(auth(admin))
      .send({ key: 'e2e-combo', language: 'en', categoryId: menu.id, question: 'Again?', answer: 'Again.' }).expect(409);
    const published = (await http().patch(`/v1/admin/support/faq/articles/${draft.id}`).set(auth(admin)).send({ status: 'PUBLISHED', answer: 'Add a dish called Combo with sizes.' }).expect(200)).body;
    expect(published).toMatchObject({ status: 'PUBLISHED', version: 2 });
    expect((await http().get('/v1/support/faq/search?lang=en&q=combo').set(auth(owner)).expect(200)).body.map((entry: Summary) => entry.key)).toEqual(['e2e-combo']);
    const revisions = (await http().get(`/v1/admin/support/faq/articles/${draft.id}/revisions`).set(auth(admin)).expect(200)).body;
    expect(revisions.map((revision: { version: number; status: string }) => [revision.version, revision.status])).toEqual([[2, 'PUBLISHED'], [1, 'DRAFT']]);
    const stats = (await http().get('/v1/admin/support/faq/articles?lang=ar&q=add-menu').set(auth(admin)).expect(200)).body[0];
    expect(stats).toMatchObject({ key: 'add-menu-item', views: 1, helpful: 1, notHelpful: 0 });

    // Restaurants cannot edit FAQs.
    await http().get('/v1/admin/support/faq/articles').set(auth(owner)).expect(403);
  });
});

describe('support assistant', () => {
  it('keeps one conversation per user, answers from the FAQ provider, and hands off when nothing helps', async () => {
    const owner = await restaurant('owner@koshary.test', 'koshary');
    const session = (await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'en' }).expect(201)).body;
    expect(session.provider).toBe('faq');
    const [welcome] = session.messages;
    expect(welcome.blocks[0]).toMatchObject({ type: 'text' });
    expect(welcome.blocks[0].text).toContain('Welcome to Bilhanah Support');
    expect(welcome.blocks.map((block: { type: string }) => block.type)).toEqual(['text', 'suggestions', 'categories']);

    // Opening again restores it (state survives page changes and reloads); restart begins a new one.
    expect((await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'en' }).expect(201)).body.id).toBe(session.id);

    const question = welcome.blocks[1].items.find((item: Summary) => item.key === 'table-qr-code');
    const answered = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'question', articleId: question.id }).expect(201)).body;
    expect(answered.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
    expect(answered[0].blocks[0].text).toBe('How do I generate a QR code for a table?');
    expect(answered[1].blocks.map((block: { type: string }) => block.type)).toEqual(['answer', 'feedback']);
    expect(answered[1].blocks[0].article.related.length).toBeGreaterThan(0);

    const notHelpful = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'feedback', articleId: question.id, helpful: false }).expect(201)).body;
    expect(notHelpful.at(-1).blocks.at(-1)).toEqual({ type: 'handoff', reason: 'NOT_HELPFUL' });

    const category = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'category', slug: 'orders' }).expect(201)).body;
    expect(category.at(-1).blocks[0]).toMatchObject({ type: 'suggestions', title: 'Orders management' });

    const nothing = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'message', text: 'qwerty asdf' }).expect(201)).body;
    expect(nothing.at(-1).blocks.at(-1)).toEqual({ type: 'handoff', reason: 'NO_RESULTS' });
    const found = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'search', query: 'pause orders' }).expect(201)).body;
    expect(found.at(-1).blocks[0].items[0].key).toBe('pause-orders');

    const restored = (await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(owner)).expect(200)).body;
    expect(restored.messages.length).toBe(1 + 2 + 1 + 2 + 2 + 2);
    expect((await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'en', restart: true }).expect(201)).body.id).not.toBe(session.id);

    // Another restaurant cannot read or write this conversation.
    const other = await restaurant('owner@feteer.test', 'feteer');
    await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(other)).expect(404);
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(other)).send({ type: 'home' }).expect(404);
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'nope' }).expect(400);
  });
});

describe('support tickets', () => {
  it('runs a ticket from the assistant through replies, notes, assignment, resolution and reopening, with notifications', async () => {
    const owner = await restaurant('owner@koshary.test', 'koshary');
    const { token: admin } = await signInAdmin(t);
    const { token: second } = await signInAdmin(t, 'agent2@bilhanah.test');
    const agents = (await http().get('/v1/admin/support/agents').set(auth(admin)).expect(200)).body;
    expect(agents).toHaveLength(2);
    const me = agents.find((agent: { email: string }) => agent.email === 'admin@bilhanah.test');

    // A screenshot: images only, re-encoded.
    const upload = (await http().post('/v1/support/attachments').set(auth(owner)).attach('file', await png(), 'screen.png').expect(201)).body;
    expect(upload).toMatchObject({ contentType: 'image/webp', width: 500, height: 400, fileName: 'screen.webp' });
    await http().post('/v1/support/attachments').set(auth(owner)).attach('file', Buffer.from('not an image'), 'notes.txt').expect(400);

    const session = (await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'ar' }).expect(201)).body;
    const created = (await http().post('/v1/support/tickets').set(auth(owner)).send({
      subject: 'الطلبات مش بتوصل', description: 'من الصبح مفيش طلبات بتظهر على الشاشة.', topic: 'ORDERS', priority: 'HIGH',
      module: 'orders', assistantSessionId: session.id, attachmentIds: [upload.id],
    }).expect(201)).body;
    expect(created.reference).toMatch(/^BIL-1\d{4}$/);
    expect(created).toMatchObject({ status: 'OPEN', priority: 'HIGH', topic: 'ORDERS', module: 'orders', allowedStatuses: ['CLOSED'] });
    expect(created.attachments).toHaveLength(1);
    const second_ = (await http().post('/v1/support/tickets').set(auth(owner)).send({ subject: 'Another', description: 'x', topic: 'MENU' }).expect(201)).body;
    expect(Number(second_.reference.slice(4))).toBe(Number(created.reference.slice(4)) + 1);
    // The attachment cannot be reused; validation rejects bad input.
    await http().post('/v1/support/tickets').set(auth(owner)).send({ subject: 'x', description: 'x', topic: 'MENU', attachmentIds: [upload.id] }).expect(404);
    await http().post('/v1/support/tickets').set(auth(owner)).send({ subject: '', description: 'x', topic: 'NOPE' }).expect(400);

    // The conversation shows the hand-off.
    const conversation = (await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(owner)).expect(200)).body;
    expect(conversation.ticketId).toBe(created.id);
    expect(conversation.messages.at(-1)).toMatchObject({ role: 'system', blocks: [{ type: 'ticket', reference: created.reference }] });

    // Every agent is told about new tickets; the inbox has it unread.
    const adminNotes = (await http().get('/v1/admin/support/notifications').set(auth(admin)).expect(200)).body;
    expect(adminNotes.unread).toBe(2);
    expect(adminNotes.items.map((item: { kind: string }) => item.kind)).toEqual(['TICKET_CREATED', 'TICKET_CREATED']);
    const inbox = (await http().get('/v1/admin/support/tickets?view=OPEN').set(auth(admin)).expect(200)).body;
    expect(inbox.counts).toMatchObject({ ALL: 2, OPEN: 2, UNASSIGNED: 2, MINE: 0, CLOSED: 0 });
    expect(inbox.items.find((row: { id: string }) => row.id === created.id)).toMatchObject({ unread: true, restaurant: { subdomain: 'koshary' }, requester: { email: 'owner@koshary.test' } });
    expect((await http().get(`/v1/admin/support/tickets?q=${created.reference}`).set(auth(admin)).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([created.id]);

    // Opening it reads its notification; an internal note stays inside the team.
    const opened = (await http().get(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).expect(200)).body;
    expect(opened).toMatchObject({ unread: false, restaurantInfo: { ownerEmail: 'owner@koshary.test' }, activity: [{ kind: 'CREATED' }] });
    expect((await http().get('/v1/admin/support/notifications').set(auth(admin)).expect(200)).body.unread).toBe(1);
    await http().post(`/v1/admin/support/tickets/${created.id}/replies`).set(auth(admin)).send({ body: 'Check their printer settings', internal: true }).expect(201);
    expect((await http().get(`/v1/support/tickets/${created.id}`).set(auth(owner)).expect(200)).body.messages).toEqual([]);
    expect((await http().get('/v1/support/notifications').set(auth(owner)).expect(200)).body.unread).toBe(0);

    // A public reply reaches the restaurant and takes the ticket on.
    const replied = (await http().post(`/v1/admin/support/tickets/${created.id}/replies`).set(auth(admin)).send({ body: 'بنبص عليها دلوقتي' }).expect(201)).body;
    expect(replied).toMatchObject({ status: 'IN_PROGRESS' });
    expect(replied.firstResponseAt).toEqual(expect.any(String));
    const list = (await http().get('/v1/support/tickets').set(auth(owner)).expect(200)).body;
    expect(list.items.find((row: { id: string }) => row.id === created.id).unread).toBe(true);
    const ownerNotes = (await http().get('/v1/support/notifications').set(auth(owner)).expect(200)).body;
    expect(ownerNotes).toMatchObject({ unread: 1, items: [{ kind: 'AGENT_REPLIED', reference: created.reference }] });
    const seen = (await http().get(`/v1/support/tickets/${created.id}`).set(auth(owner)).expect(200)).body;
    expect(seen.messages).toEqual([expect.objectContaining({ side: 'AGENT', authorName: 'Bilhanah', body: 'بنبص عليها دلوقتي', internal: false })]);
    expect((await http().get('/v1/support/notifications').set(auth(owner)).expect(200)).body.unread).toBe(0);

    // Assignment: to agents only, tracked, and the assignee is told.
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ assigneeId: (await t.prisma.user.findFirstOrThrow({ where: { email: 'owner@koshary.test' } })).id }).expect(400);
    const secondId = agents.find((agent: { email: string }) => agent.email === 'agent2@bilhanah.test').id;
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ assigneeId: secondId, status: 'WAITING_FOR_CUSTOMER', priority: 'URGENT' }).expect(200);
    const secondNotes = (await http().get('/v1/admin/support/notifications').set(auth(second)).expect(200)).body;
    expect(secondNotes.items.map((item: { kind: string }) => item.kind)).toEqual(expect.arrayContaining(['TICKET_ASSIGNED', 'NEEDS_ATTENTION']));
    expect((await http().get('/v1/admin/support/tickets?view=MINE').set(auth(second)).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([created.id]);
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ assigneeId: me.id }).expect(200);
    expect(await t.prisma.supportAssignment.count({ where: { ticketId: created.id } })).toBe(2);

    // The restaurant answers: back to the team, and the assignee hears about it once, folded.
    await http().post(`/v1/support/tickets/${created.id}/replies`).set(auth(owner)).send({ body: 'لسه مش شغال', attachmentIds: [] }).expect(201);
    await http().post(`/v1/support/tickets/${created.id}/replies`).set(auth(owner)).send({ body: 'ولسه' }).expect(201);
    expect((await t.prisma.supportTicket.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('IN_PROGRESS');
    const replies = await t.prisma.supportNotification.findMany({ where: { ticketId: created.id, kind: 'CUSTOMER_REPLIED' } });
    expect(replies.map((row) => [row.recipientId, row.count])).toEqual([[me.id, 2]]);

    // Invalid moves are refused; resolving tells the restaurant; it can reopen.
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ status: 'OPEN' }).expect(200);
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ status: 'RESOLVED' }).expect(200);
    await http().post(`/v1/support/tickets/${created.id}/status`).set(auth(owner)).send({ status: 'OPEN' }).expect(200);
    const reopened = (await http().get(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).expect(200)).body;
    expect(reopened.status).toBe('OPEN');
    expect(reopened.activity.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(['CREATED', 'NOTE', 'REPLIED', 'ASSIGNED', 'PRIORITY', 'STATUS', 'REOPENED']));
    expect(reopened.messages.filter((message: { internal: boolean }) => message.internal)).toHaveLength(1);
    expect((await t.prisma.supportNotification.findMany({ where: { ticketId: created.id, recipientId: (await t.prisma.user.findFirstOrThrow({ where: { email: 'owner@koshary.test' } })).id } })).map((row) => row.kind).sort())
      .toEqual(['AGENT_REPLIED', 'STATUS_CHANGED', 'TICKET_RESOLVED']);
    await http().post(`/v1/support/tickets/${created.id}/status`).set(auth(owner)).send({ status: 'OPEN' }).expect(409);

    // Closed: no more replies until an agent reopens it; history stays.
    await http().post(`/v1/support/tickets/${created.id}/status`).set(auth(owner)).send({ status: 'CLOSED' }).expect(200);
    await http().post(`/v1/support/tickets/${created.id}/replies`).set(auth(owner)).send({ body: 'hello?' }).expect(409);
    await http().post(`/v1/admin/support/tickets/${created.id}/replies`).set(auth(admin)).send({ body: 'hi' }).expect(409);
    await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ status: 'WAITING_FOR_CUSTOMER' }).expect(409);
    const back = (await http().patch(`/v1/admin/support/tickets/${created.id}`).set(auth(admin)).send({ status: 'IN_PROGRESS' }).expect(200)).body;
    expect(back.messages.length).toBe(4);

    // Read state is kept; "all" clears it.
    await http().post('/v1/admin/support/notifications/read').set(auth(second)).send({ all: true }).expect(204);
    expect((await http().get('/v1/admin/support/notifications').set(auth(second)).expect(200)).body.unread).toBe(0);
  });

  it('keeps restaurants, staff and agents to their own support data', async () => {
    const owner = await restaurant('owner@koshary.test', 'koshary');
    const other = await restaurant('owner@feteer.test', 'feteer');
    const { token: admin } = await signInAdmin(t);
    const cashier = await staff(owner, 'cashier@koshary.test', 'CASHIER', ['support.use']);
    const waiter = await staff(owner, 'waiter@koshary.test', 'WAITER');

    const upload = (await http().post('/v1/support/attachments').set(auth(cashier)).attach('file', await png(), 'a.png').expect(201)).body;
    const ticket = (await http().post('/v1/support/tickets').set(auth(cashier)).send({ subject: 'Drawer', description: 'Cash is off', topic: 'PAYMENTS', attachmentIds: [upload.id] }).expect(201)).body;
    const own = (await http().post('/v1/support/tickets').set(auth(owner)).send({ subject: 'Logo', description: 'Blurry', topic: 'RESTAURANT_SETUP' }).expect(201)).body;

    // The owner sees every ticket of the restaurant; staff only theirs; other restaurants none.
    expect((await http().get('/v1/support/tickets').set(auth(owner)).expect(200)).body.total).toBe(2);
    expect((await http().get('/v1/support/tickets').set(auth(cashier)).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([ticket.id]);
    await http().get(`/v1/support/tickets/${own.id}`).set(auth(cashier)).expect(404);
    await http().get(`/v1/support/tickets/${ticket.id}`).set(auth(owner)).expect(200);
    await http().get(`/v1/support/tickets/${ticket.id}`).set(auth(other)).expect(404);
    await http().post(`/v1/support/tickets/${ticket.id}/replies`).set(auth(other)).send({ body: 'hi' }).expect(404);
    expect((await http().get('/v1/support/tickets').set(auth(other)).expect(200)).body.total).toBe(0);
    await http().get(upload.url).set(auth(owner)).expect(200).expect('Content-Type', 'image/webp');
    await http().get(upload.url).set(auth(other)).expect(404);
    await http().get(`/v1/admin/support/attachments/${upload.id}`).set(auth(admin)).expect(200);

    // An agent's internal attachment is never served to the restaurant.
    const note = (await http().post('/v1/admin/support/attachments').set(auth(admin)).attach('file', await png(), 'internal.png').expect(201)).body;
    await http().post(`/v1/admin/support/tickets/${ticket.id}/replies`).set(auth(admin)).send({ body: 'internal', internal: true, attachmentIds: [note.id] }).expect(201);
    await http().get(`/v1/support/attachments/${note.id}`).set(auth(owner)).expect(404);

    // Without support.use (a waiter by default) there is no support; restaurants are not agents.
    await http().get('/v1/support/tickets').set(auth(waiter)).expect(403);
    await http().post('/v1/support/assistant/sessions').set(auth(waiter)).send({}).expect(403);
    await http().get('/v1/admin/support/tickets').set(auth(owner)).expect(403);
    await http().patch(`/v1/admin/support/tickets/${ticket.id}`).set(auth(owner)).send({ status: 'RESOLVED' }).expect(403);
    await http().get('/v1/support/tickets').set(auth(admin)).expect(403);

    // Notifications of one account are not another's to read.
    await http().post(`/v1/admin/support/tickets/${ticket.id}/replies`).set(auth(admin)).send({ body: 'On it' }).expect(201);
    const cashierNotes = (await http().get('/v1/support/notifications').set(auth(cashier)).expect(200)).body;
    expect(cashierNotes.unread).toBe(1);
    await http().post('/v1/support/notifications/read').set(auth(other)).send({ ids: [cashierNotes.items[0].id] }).expect(204);
    expect((await http().get('/v1/support/notifications').set(auth(cashier)).expect(200)).body.unread).toBe(1);
    expect((await http().get('/v1/support/notifications').set(auth(other)).expect(200)).body.items).toEqual([]);
    // The owner is told too, as the restaurant's account.
    expect((await http().get('/v1/support/notifications').set(auth(owner)).expect(200)).body.items.map((item: { ticketId: string }) => item.ticketId)).toEqual([ticket.id]);
  });
});

describe('live chat with the support team', () => {
  it('asks for the problem when someone asks for customer service, connects an agent, and ends with the ticket', async () => {
    const owner = await restaurant('owner@koshary.test', 'koshary');
    const { token: admin } = await signInAdmin(t);
    const session = (await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'ar' }).expect(201)).body;
    expect(session).toMatchObject({ handoff: 'NONE', live: null });

    // Something asked first, then a request for a person typed in Egyptian Arabic: transferred at once.
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'search', query: 'الطلبات مش بتظهر في المطبخ' }).expect(201);
    const connecting = (await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'message', text: 'عاوز اكلم خدمه العملاء' }).expect(201)).body;
    expect(connecting.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'system']);
    expect(connecting[1].blocks[0].text).toBe('جاري تحويلك إلى أحد ممثلي خدمة العملاء…');
    const waiting = (await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(owner)).expect(200)).body;
    expect(waiting).toMatchObject({ handoff: 'NONE', live: { state: 'WAITING', agentName: null, messages: [] } });
    // The agent sees what the customer had asked the assistant.
    expect(waiting.live.problem).toContain('عاوز اكلم خدمه العملاء');
    expect(waiting.live.problem).toContain('- الطلبات مش بتظهر في المطبخ');
    // The assistant is paused while the chat runs.
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'home' }).expect(409);

    // Agents see a waiting chat that needs attention.
    const inbox = (await http().get('/v1/admin/support/tickets').set(auth(admin)).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ channel: 'CHAT', subject: 'طلب محادثة مع خدمة العملاء' });
    const kinds = (await http().get('/v1/admin/support/notifications').set(auth(admin)).expect(200)).body.items.map((item: { kind: string }) => item.kind).sort();
    expect(kinds).toEqual(['NEEDS_ATTENTION', 'TICKET_CREATED']);

    // An agent takes the chat and talks; the customer sees their first name and answers in the chat.
    const agentId = (await t.prisma.user.findFirstOrThrow({ where: { email: 'admin@bilhanah.test' } })).id;
    await http().patch(`/v1/admin/support/tickets/${waiting.live.ticketId}`).set(auth(admin)).send({ assigneeId: agentId }).expect(200);
    expect((await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(owner)).expect(200)).body.live).toMatchObject({ state: 'LIVE', agentName: 'Platform' });
    await http().post(`/v1/admin/support/tickets/${waiting.live.ticketId}/replies`).set(auth(admin)).send({ body: 'أهلًا، الشاشة دي متوصلة بأنهي فرع؟' }).expect(201);
    await http().post(`/v1/admin/support/tickets/${waiting.live.ticketId}/replies`).set(auth(admin)).send({ body: 'note', internal: true }).expect(201);
    const chat = (await http().post(`/v1/support/assistant/sessions/${session.id}/live`).set(auth(owner)).send({ body: 'وسط البلد' }).expect(201)).body;
    expect(chat.live.messages.map((message: { side: string; authorName: string; body: string }) => [message.side, message.body])).toEqual([['AGENT', 'أهلًا، الشاشة دي متوصلة بأنهي فرع؟'], ['CUSTOMER', 'وسط البلد']]);
    expect(chat.live.messages[0].authorName).toBe('Platform');

    // Resolving ends the chat; the assistant works again.
    await http().patch(`/v1/admin/support/tickets/${waiting.live.ticketId}`).set(auth(admin)).send({ status: 'RESOLVED' }).expect(200);
    expect((await http().get(`/v1/support/assistant/sessions/${session.id}`).set(auth(owner)).expect(200)).body.live.state).toBe('ENDED');
    await http().post(`/v1/support/assistant/sessions/${session.id}/live`).set(auth(owner)).send({ body: 'hello?' }).expect(409);
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'home' }).expect(201);

    // The button works the same in English, and a normal question is not taken for a hand-off.
    const english = (await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'en', restart: true }).expect(201)).body;
    expect((await http().post(`/v1/support/assistant/sessions/${english.id}/messages`).set(auth(owner)).send({ type: 'search', query: 'pause orders' }).expect(201)).body.at(-1).blocks[0].type).toBe('results');
    const human = (await http().post(`/v1/support/assistant/sessions/${english.id}/messages`).set(auth(owner)).send({ type: 'human' }).expect(201)).body;
    expect(human[1].blocks[0].text).toBe('Transferring you to a customer service representative…');
    expect((await http().get(`/v1/support/assistant/sessions/${english.id}`).set(auth(owner)).expect(200)).body.live).toMatchObject({ state: 'WAITING', problem: 'I want to talk to customer service\n\nWhat the customer last asked the assistant:\n- pause orders' });
  });
});
