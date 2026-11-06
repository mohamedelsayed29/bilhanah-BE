import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, signInAdmin, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let baseUrl = '';
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sockets: Socket[] = [];

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/support`, { path: '/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
  });
}

/** The next `event` on `socket`, or null after `ms`. */
function next<T>(socket: Socket, event: string, ms = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    const handler = (payload: T) => { clearTimeout(timer); socket.off(event, handler); resolve(payload); };
    socket.on(event, handler);
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await t.app.close();
});
beforeEach(async () => { await t.reset(); });

describe('support over Socket.IO', () => {
  it('tells agents and the restaurant about changes at once, relays typing both ways, and keeps others out', async () => {
    const owner = await signUpOwner(t, 'owner@koshary.test');
    await http().post('/v1/restaurants').set(auth(owner))
      .send({ name: 'Koshary', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain: 'koshary' }).expect(201);
    const other = await signUpOwner(t, 'owner@feteer.test');
    await http().post('/v1/restaurants').set(auth(other))
      .send({ name: 'Feteer', contactName: 'Mona', phone: '01012345679', city: 'Cairo', address: '1 St', subdomain: 'feteer' }).expect(201);
    const { token: admin } = await signInAdmin(t);
    const [agentSocket, ownerSocket, otherSocket] = await Promise.all([connect(admin), connect(owner), connect(other)]);
    await expect(connect('not-a-token')).rejects.toThrow('UNAUTHENTICATED');

    // The restaurant asks for a person and describes the problem: agents hear about the chat right away.
    const session = (await http().post('/v1/support/assistant/sessions').set(auth(owner)).send({ lang: 'en' }).expect(201)).body;
    const created = next<{ ticketId: string }>(agentSocket, 'support.updated');
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'message', text: 'I want to talk to customer service' }).expect(201);
    // Asking again while the chat waits is refused, not a second chat.
    await http().post(`/v1/support/assistant/sessions/${session.id}/messages`).set(auth(owner)).send({ type: 'human' }).expect(409);
    const ticketId = (await created)!.ticketId;
    expect(ticketId).toEqual(expect.any(String));

    // Typing goes to the other side only.
    const agentSeesTyping = next<{ ticketId: string; side: string }>(agentSocket, 'support.typing');
    ownerSocket.emit('support.typing', { ticketId });
    expect(await agentSeesTyping).toEqual({ ticketId, side: 'CUSTOMER', name: null });
    const ownerSeesTyping = next<{ side: string; name: string }>(ownerSocket, 'support.typing');
    const strangerSeesTyping = next(otherSocket, 'support.typing', 600);
    agentSocket.emit('support.typing', { ticketId });
    expect(await ownerSeesTyping).toEqual({ ticketId, side: 'AGENT', name: 'Platform' });
    expect(await strangerSeesTyping).toBeNull();
    // Another restaurant cannot pretend to type in this chat.
    const fake = next(agentSocket, 'support.typing', 600);
    otherSocket.emit('support.typing', { ticketId });
    expect(await fake).toBeNull();

    // An agent's reply reaches the restaurant at once; an internal note does not.
    const reply = next<{ ticketId: string }>(ownerSocket, 'support.updated');
    await http().post(`/v1/admin/support/tickets/${ticketId}/replies`).set(auth(admin)).send({ body: 'Hello, which branch?' }).expect(201);
    expect(await reply).toEqual({ ticketId });
    const note = next(ownerSocket, 'support.updated', 600);
    await http().post(`/v1/admin/support/tickets/${ticketId}/replies`).set(auth(admin)).send({ body: 'note', internal: true }).expect(201);
    expect(await note).toBeNull();
    // The customer's answer reaches the agents at once.
    const answer = next<{ ticketId: string }>(agentSocket, 'support.updated');
    await http().post(`/v1/support/assistant/sessions/${session.id}/live`).set(auth(owner)).send({ body: 'Downtown' }).expect(201);
    expect(await answer).toEqual({ ticketId });
  });
});
