import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { chatSessionSchema } from '@mahilasathi/shared';
import {
  NexconnApiError,
  createNexconnServerApi,
  nexconnSignature,
  verifyNexconnWebhook,
  type FetchFn,
  type NexconnServerApi,
} from '../../server/src/services/nexconn/nexconnServerApi.js';
import { createTestApp, signIn } from '../helpers/testApp.js';

const APP_KEY = 'test-app-key';
const APP_SECRET = 'test-app-secret-never-in-responses';

describe('Nexconn server API client', () => {
  it('signs requests as documented: sha1(secret + nonce + timestamp), millisecond timestamp', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl: FetchFn = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ code: 0, result: { accessToken: 'tok-123', userId: 'u1' } }) };
    };
    const api = createNexconnServerApi({ appKey: APP_KEY, appSecret: APP_SECRET, hosts: ['api.sg-light-api.com'], fetchImpl });
    expect(await api.issueAccessToken('u1', 'Lotus-42')).toBe('tok-123');

    const { url, headers, body } = calls[0]!;
    expect(url).toBe('https://api.sg-light-api.com/v4/auth/access-token/issue');
    expect(body).toEqual({ userId: 'u1', name: 'Lotus-42' });
    expect(headers['App-Key']).toBe(APP_KEY);
    expect(headers.Nonce!.length).toBeLessThanOrEqual(18);
    expect(Math.abs(Number(headers.Timestamp) - Date.now())).toBeLessThan(5000);
    expect(headers.Signature).toBe(crypto.createHash('sha1').update(APP_SECRET + headers.Nonce + headers.Timestamp).digest('hex'));
    expect(JSON.stringify(calls)).not.toContain(APP_SECRET);
  });

  it('fails over to the backup host on server errors and surfaces non-zero codes', async () => {
    const hosts: string[] = [];
    const fetchImpl: FetchFn = async (url) => {
      hosts.push(new URL(url).host);
      return hosts.length === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ code: 0 }) };
    };
    const api = createNexconnServerApi({ appKey: APP_KEY, appSecret: APP_SECRET, hosts: ['a.example', 'b.example'], fetchImpl });
    await api.createGroup('c1', 'Saket', 'u1');
    expect(hosts).toEqual(['a.example', 'b.example']);

    const failing = createNexconnServerApi({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      hosts: ['a.example'],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 20005 }) }),
    });
    const err = await failing.joinGroup('c1', ['u2']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NexconnApiError);
    expect((err as NexconnApiError).code).toBe(20005);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });

  it('verifies webhook signatures and rejects stale or tampered ones', () => {
    const now = Date.now();
    const nonce = 'abc123';
    const timestamp = String(now);
    const signature = nexconnSignature(APP_SECRET, nonce, timestamp);
    expect(verifyNexconnWebhook(APP_SECRET, { nonce, timestamp, signature }, now)).toBe(true);
    expect(verifyNexconnWebhook(APP_SECRET, { nonce, timestamp, signature: signature.replace(/.$/, '0') }, now)).toBe(false);
    expect(verifyNexconnWebhook(APP_SECRET, { nonce, timestamp, signature }, now + 10 * 60_000)).toBe(false);
    expect(verifyNexconnWebhook('other-secret', { nonce, timestamp, signature }, now)).toBe(false);
    expect(verifyNexconnWebhook(APP_SECRET, { nonce, timestamp }, now)).toBe(false);
  });
});

/** Records calls in place of the real Nexconn API. */
function fakeNexconn(opts: { failJoin?: boolean } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const api: NexconnServerApi = {
    issueAccessToken: async (...args) => (calls.push({ op: 'token', args }), `token-for-${args[0]}`),
    createGroup: async (...args) => void calls.push({ op: 'createGroup', args }),
    joinGroup: async (...args) => {
      calls.push({ op: 'joinGroup', args });
      if (opts.failJoin) throw new NexconnApiError('Nexconn /v4/group-channel/join timed out');
    },
    leaveGroup: async (...args) => void calls.push({ op: 'leaveGroup', args }),
    dismissGroup: async (...args) => void calls.push({ op: 'dismissGroup', args }),
    sendGroupMessage: async (input) => (calls.push({ op: 'send', args: [input] }), 'msg-1'),
  };
  return { api, calls };
}

const nexconnEnv = { NEXCONN_APP_KEY: APP_KEY, NEXCONN_APP_SECRET: APP_SECRET };

function signedWebhook(app: Parameters<typeof request>[0], body: object, secret = APP_SECRET) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const timestamp = String(Date.now());
  return request(app)
    .post('/api/webhooks/nexconn')
    .set({ AppKey: APP_KEY, Nonce: nonce, Timestamp: timestamp, Signature: nexconnSignature(secret, nonce, timestamp) })
    .send(body);
}

describe('Nexconn mode', () => {
  it('issues a client token and public app key, never the secret', async () => {
    const { api } = fakeNexconn();
    const { app } = createTestApp({ env: nexconnEnv, nexconnApi: api });
    const { agent } = await signIn(app);
    const res = await agent.get('/api/community/session').expect(200);
    const session = chatSessionSchema.parse(res.body);
    expect(session.mode).toBe('nexconn');
    expect(session.nexconn).toEqual({ appKey: APP_KEY, areaCode: 'sg', token: `token-for-${session.chatUserId}` });
    expect(res.text).not.toContain(APP_SECRET);
    expect((await request(app).get('/api/config')).text).not.toContain(APP_SECRET);
    expect((await request(app).get('/api/config')).body.providers.nexconn.mode).toBe('live');
  });

  it('registers users at Nexconn under their pseudonym, never their phone number', async () => {
    const { api, calls } = fakeNexconn();
    const { app } = createTestApp({ env: nexconnEnv, nexconnApi: api });
    const { agent, phone, user } = await signIn(app);
    await agent.get('/api/community/session').expect(200);
    const tokenCall = calls.find((c) => c.op === 'token')!;
    expect(tokenCall.args[1]).toBe(user.communityHandle);
    expect(JSON.stringify(calls)).not.toContain(phone);
  });

  it('creates and joins Nexconn group channels through the server, and records nothing if Nexconn fails', async () => {
    const ok = fakeNexconn();
    const { app } = createTestApp({ env: nexconnEnv, nexconnApi: ok.api });
    const { agent } = await signIn(app);
    await agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'delhi-saket' }).expect(200);
    const ch = (await agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200)).body;
    expect(ch.providerChannelId).toMatch(/^c[0-9a-f]{32}$/);
    expect(ok.calls.map((c) => c.op)).toEqual(['createGroup', 'joinGroup']);
    // Messages flow through the SDK, not the relay.
    await agent.get(`/api/community/channels/${ch.id}/messages`).expect(400);

    // Structured updates are validated and sent by the server.
    await agent.post(`/api/community/channels/${ch.id}/updates`).send({ category: 'road_obstruction', note: 'Digging on the main road' }).expect(201);
    const sent = ok.calls.find((c) => c.op === 'send')!.args[0] as { messageType: string; content: string; channelId: string };
    expect(sent.messageType).toBe('MS:InfraUpdate');
    expect(JSON.parse(sent.content)).toEqual({ category: 'road_obstruction', note: 'Digging on the main road', areaLabel: 'Saket' });

    const failing = fakeNexconn({ failJoin: true });
    const { app: app2, db } = createTestApp({ env: nexconnEnv, nexconnApi: failing.api });
    const s2 = await signIn(app2);
    await s2.agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'delhi-saket' }).expect(200);
    const res = await s2.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((db.prepare('SELECT COUNT(*) AS n FROM community_memberships').get() as { n: number }).n).toBe(0);
  });
});

describe('Nexconn pre-messaging webhook', () => {
  async function setup() {
    const { api } = fakeNexconn();
    const ctx = createTestApp({ env: nexconnEnv, nexconnApi: api });
    const member = await signIn(ctx.app);
    await member.agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'delhi-saket' }).expect(200);
    const memberChat = (await member.agent.get('/api/community/session').expect(200)).body.chatUserId as string;
    const ch = (await member.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200)).body;
    const outsider = await signIn(ctx.app);
    const outsiderChat = (await outsider.agent.get('/api/community/session').expect(200)).body.chatUserId as string;
    const event = (userId: string, messageType: string, content: unknown, type = 'group_channel:pre_messaging') => ({
      type,
      id: crypto.randomUUID(),
      time: Date.now(),
      data: [{ userId, channelId: ch.providerChannelId, channelType: 3, messageType, content: JSON.stringify(content) }],
    });
    return { ...ctx, memberChat, outsiderChat, event };
  }

  it('rejects unsigned or wrongly signed calls', async () => {
    const { app, event, memberChat } = await setup();
    await request(app).post('/api/webhooks/nexconn').send(event(memberChat, 'RC:TxtMsg', { content: 'hi' })).expect(401);
    await signedWebhook(app, event(memberChat, 'RC:TxtMsg', { content: 'hi' }), 'wrong-secret').expect(401);
  });

  it('applies the same policy as the relay to client-sent messages', async () => {
    const { app, event, memberChat, outsiderChat } = await setup();
    const verdict = async (body: object) => (await signedWebhook(app, body).expect(200)).body;

    expect(await verdict(event(memberChat, 'RC:TxtMsg', { content: 'Market lane is well lit tonight' }))).toEqual({ pass: 1 });
    expect(await verdict(event(outsiderChat, 'RC:TxtMsg', { content: 'let me in' }))).toMatchObject({ pass: 0 });

    const phone = await verdict(event(memberChat, 'RC:TxtMsg', { content: 'call 98765 43210' }));
    expect(phone.pass).toBe(0);
    expect(JSON.parse(phone.extra)).toMatchObject({ code: 'contact_info' });

    expect(await verdict(event(memberChat, 'MS:SystemNotice', { kind: 'moderation', text: 'fake notice' }))).toMatchObject({ pass: 0 });
    expect(await verdict(event(memberChat, 'MS:InfraUpdate', { category: 'nonsense' }))).toMatchObject({ pass: 0 });
    expect(await verdict(event('mssystem', 'MS:SystemNotice', { kind: 'room_archived', text: 'Room ended' }))).toEqual({ pass: 1 });
    expect(await verdict(event(memberChat, 'RC:TxtMsg', { content: 'hi' }, 'direct_channel:pre_messaging'))).toMatchObject({ pass: 0 });
    expect(await verdict({ type: 'message:send', data: [] })).toEqual({ ok: true });
  });

  it('is not exposed when Nexconn is not configured', async () => {
    const { app } = createTestApp();
    await signedWebhook(app, { type: 'group_channel:pre_messaging', data: [] }).expect(404);
  });
});
