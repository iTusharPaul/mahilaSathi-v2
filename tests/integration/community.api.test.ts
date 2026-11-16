import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { channelSummarySchema, chatSessionSchema, relayMessageSchema } from '@mahilasathi/shared';
import { POLICY } from '../../server/src/services/moderation/messagePolicy.js';
import { COMMUNITY_LIMITS } from '../../server/src/services/community/communityService.js';
import { createTestApp, signIn, testClock, type TestContext } from '../helpers/testApp.js';

type Agent = Awaited<ReturnType<typeof signIn>>['agent'];

async function resident(app: TestContext['app'], neighbourhoodId = 'delhi-saket') {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: 'Resident', homeNeighbourhoodId: neighbourhoodId }).expect(200);
  const session = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  return { ...s, publicId: session.chatUserId };
}

async function joinHome(agent: Agent, neighbourhoodId = 'delhi-saket') {
  return channelSummarySchema.parse((await agent.post(`/api/community/neighbourhoods/${neighbourhoodId}/join`).expect(200)).body);
}

const send = (agent: Agent, channelId: string, text: string) => agent.post(`/api/community/channels/${channelId}/messages`).send({ text });
const fetchMessages = async (agent: Agent, channelId: string) =>
  ((await agent.get(`/api/community/channels/${channelId}/messages`).expect(200)).body.messages as unknown[]).map((m) => relayMessageSchema.parse(m));

function roomInput(clock: ReturnType<typeof testClock>, over: Record<string, unknown> = {}) {
  return {
    from: { type: 'neighbourhood', id: 'gurugram-cyber-city' },
    to: { type: 'neighbourhood', id: 'delhi-saket' },
    windowStart: new Date(clock().getTime() + 30 * 60_000).toISOString(),
    windowMinutes: 30,
    ...over,
  };
}

describe('chat session', () => {
  it('uses the labelled development relay when Nexconn is not configured', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    const session = chatSessionSchema.parse((await agent.get('/api/community/session').expect(200)).body);
    expect(session).toMatchObject({ mode: 'dev-relay', nexconn: null });
    expect(session.chatUserId).toMatch(/^u[0-9a-f]{32}$/);
    expect(session.customMessageTypes.map((t) => t.messageType)).toEqual(['MS:InfraUpdate', 'MS:SystemNotice', 'MS:JourneyStatus', 'MS:SosAlert']);
    expect((await request(app).get('/api/config')).body.providers.nexconn.mode).toBe('dev-adapter');
  });

  it('requires sign-in for every community endpoint', async () => {
    const { app } = createTestApp();
    for (const path of ['/api/community/session', '/api/community/channels', '/api/community/neighbourhoods', '/api/circles']) {
      await request(app).get(path).expect(401);
    }
  });
});

describe('neighbourhood channels', () => {
  it('provisions one channel per neighbourhood on first join and lets two residents talk', async () => {
    const { app, db } = createTestApp();
    const a = await resident(app);
    const b = await resident(app);
    const chA = await joinHome(a.agent);
    const chB = await joinHome(b.agent);
    expect(chB.id).toBe(chA.id);
    expect(chB.memberCount).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM community_channels WHERE kind = 'neighbourhood'").get() as { n: number }).n).toBe(1);

    await send(a.agent, chA.id, 'Streetlights near the market are out tonight').expect(201);
    const seen = await fetchMessages(b.agent, chA.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ senderPublicId: a.publicId, messageType: 'RC:TxtMsg', content: { content: 'Streetlights near the market are out tonight' } });

    // Polling with a cursor returns only newer messages.
    await send(b.agent, chA.id, 'Thanks for the heads-up').expect(201);
    const newer = (await a.agent.get(`/api/community/channels/${chA.id}/messages?after=${seen[0]!.seq}`).expect(200)).body.messages;
    expect(newer.map((m: { content: { content: string } }) => m.content.content)).toEqual(['Thanks for the heads-up']);

    const members = (await a.agent.get(`/api/community/channels/${chA.id}/members`).expect(200)).body.members;
    expect(members).toHaveLength(2);
    expect(JSON.stringify(members)).not.toMatch(/\+91|Resident/); // pseudonyms only: no phones, no display names
  });

  it('controls membership: home district only, at most three, and non-members cannot read or post', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const outsider = await resident(app, 'gurugram-cyber-city');
    const ch = await joinHome(a.agent);

    await outsider.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(403);
    await outsider.agent.get(`/api/community/channels/${ch.id}/messages`).expect(403);
    await send(outsider.agent, ch.id, 'hello').expect(403);

    await a.agent.post('/api/community/neighbourhoods/delhi-hauz-khas/join').expect(200); // same district (South Delhi)
    await a.agent.post('/api/community/neighbourhoods/delhi-vasant-kunj/join').expect(403); // New Delhi district

    // East Delhi has four curated neighbourhoods: the fourth join exceeds the limit of three.
    const east = await resident(app, 'delhi-laxmi-nagar');
    await joinHome(east.agent, 'delhi-laxmi-nagar');
    await east.agent.post('/api/community/neighbourhoods/delhi-preet-vihar/join').expect(200);
    await east.agent.post('/api/community/neighbourhoods/delhi-mayur-vihar/join').expect(200);
    expect((await east.agent.post('/api/community/neighbourhoods/delhi-shahdara/join').expect(409)).body.error.message).toMatch(/up to 3/);
    expect(COMMUNITY_LIMITS.maxNeighbourhoodChannels).toBe(3);

    const noHome = await signIn(app);
    await noHome.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(403);
  });

  it('lets members leave, after which they can no longer read', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const ch = await joinHome(a.agent);
    await a.agent.post(`/api/community/channels/${ch.id}/leave`).expect(204);
    await a.agent.get(`/api/community/channels/${ch.id}/messages`).expect(403);
  });
});

describe('message policy', () => {
  it('blocks phone numbers, emails, coordinates and map links in community channels', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const ch = await joinHome(a.agent);
    for (const text of ['call me 98765 43210', 'mail asha@example.com', 'I am at 28.52451, 77.20661', 'https://maps.app.goo.gl/abc123']) {
      const res = await send(a.agent, ch.id, text).expect(400);
      expect(res.body.error.details).toEqual({ policy: 'contact_info' });
    }
    await send(a.agent, ch.id, 'Meet near the Saket metro gate').expect(201);
  });

  it('rate-limits bursts and repeated identical messages', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const ch = await joinHome(a.agent);
    await send(a.agent, ch.id, 'same message').expect(201);
    await send(a.agent, ch.id, 'same message').expect(201);
    expect((await send(a.agent, ch.id, 'same message').expect(400)).body.error.details).toEqual({ policy: 'duplicate' });
    for (let i = 0; i < POLICY.perMinute - 2; i++) await send(a.agent, ch.id, `message ${i}`).expect(201);
    expect((await send(a.agent, ch.id, 'one too many').expect(429)).body.error.details).toEqual({ policy: 'rate_limited' });
  });

  it('validates structured neighbourhood updates (MS:InfraUpdate) on the server', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const b = await resident(app);
    const ch = await joinHome(a.agent);
    await joinHome(b.agent);
    await a.agent.post(`/api/community/channels/${ch.id}/updates`).send({ category: 'poor_lighting', note: 'Lane behind the mall is dark' }).expect(201);
    await a.agent.post(`/api/community/channels/${ch.id}/updates`).send({ category: 'aliens', note: 'nope' }).expect(400);
    await a.agent.post(`/api/community/channels/${ch.id}/updates`).send({ category: 'other', note: 'call 9876543210' }).expect(400);
    const msgs = await fetchMessages(b.agent, ch.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ messageType: 'MS:InfraUpdate', content: { category: 'poor_lighting', areaLabel: 'Saket' } });
  });
});

describe('journey rooms', () => {
  it('creates, lists, joins and expires a temporary room', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const a = await resident(app, 'gurugram-cyber-city');
    const b = await resident(app);
    const room = channelSummarySchema.parse((await a.agent.post('/api/community/channels').send(roomInput(clock)).expect(201)).body);
    expect(room).toMatchObject({ kind: 'journey_room', name: 'Cyber City → Saket', memberCount: 1, maxMembers: 12, role: 'owner' });
    expect(room.journey).toMatchObject({ from: { name: 'Cyber City' }, to: { name: 'Saket' } });

    const listed = (await b.agent.get('/api/community/journey-rooms?districtId=dl-south').expect(200)).body.rooms;
    expect(listed.map((r: { id: string }) => r.id)).toContain(room.id);
    expect(listed[0].providerChannelId).toBeNull(); // non-members don't get connection details

    await b.agent.post(`/api/community/channels/${room.id}/join`).expect(200);
    await send(b.agent, room.id, 'Leaving at 10:15 from Gate 2').expect(201);
    expect(await fetchMessages(a.agent, room.id)).toHaveLength(1);

    clock.advance(30 * 60_000 + 30 * 60_000 + COMMUNITY_LIMITS.journeyRoomGraceMs + 1);
    expect(await app.services.community.archiveExpiredRooms()).toBe(1);
    expect((await a.agent.get(`/api/community/channels/${room.id}`).expect(200)).body.status).toBe('archived');
    expect((await send(a.agent, room.id, 'still here?').expect(400)).body.error.details).toEqual({ policy: 'archived' });
    expect((await b.agent.get('/api/community/journey-rooms').expect(200)).body.rooms).toEqual([]);
    await b.agent.post(`/api/community/channels/${room.id}/join`).expect(409);
  });

  it('validates the window and areas and limits open rooms per user', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const a = await resident(app);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { windowStart: new Date(clock().getTime() + 30 * 60 * 60_000).toISOString() })).expect(400);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { to: { type: 'neighbourhood', id: 'gurugram-cyber-city' } })).expect(400);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { to: { type: 'district', id: 'ka-bengaluru' } })).expect(400);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { windowMinutes: 300 })).expect(400);
    await a.agent.post('/api/community/channels').send(roomInput(clock)).expect(201);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { to: { type: 'district', id: 'up-gautam-buddh-nagar' } })).expect(201);
    await a.agent.post('/api/community/channels').send(roomInput(clock, { to: { type: 'district', id: 'up-ghaziabad' } })).expect(409);
  });
});

describe('blocking', () => {
  it('hides a blocked user’s messages and prevents bypass through a new room', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const a = await resident(app);
    const b = await resident(app);
    const ch = await joinHome(a.agent);
    await joinHome(b.agent);
    await send(a.agent, ch.id, 'message from A').expect(201);

    await b.agent.post(`/api/users/${a.publicId}/block`).expect(204);
    expect(await fetchMessages(b.agent, ch.id)).toEqual([]);
    expect((await b.agent.get('/api/users/me/blocks').expect(200)).body.blocked).toEqual([
      expect.objectContaining({ publicId: a.publicId }),
    ]);

    // The blocked user creates a fresh room; the blocker cannot be pulled into it, and vice versa.
    const room = (await a.agent.post('/api/community/channels').send(roomInput(clock)).expect(201)).body;
    const denied = await b.agent.post(`/api/community/channels/${room.id}/join`).expect(403);
    expect(denied.body.error.message).not.toMatch(/block/i);
    const roomB = (await b.agent.post('/api/community/channels').send(roomInput(clock)).expect(201)).body;
    await a.agent.post(`/api/community/channels/${roomB.id}/join`).expect(403);

    await b.agent.delete(`/api/users/${a.publicId}/block`).expect(204);
    expect(await fetchMessages(b.agent, ch.id)).toHaveLength(1);
    await b.agent.post(`/api/users/${b.publicId}/block`).expect(400);
    await b.agent.post('/api/users/unothing/block').expect(404);
  });
});

describe('reports and moderation', () => {
  const ADMIN = 'moderation-admin-token-0123456789abcdef';

  it('records message reports with a server-side snapshot and rejects self-reports', async () => {
    const { app, db } = createTestApp();
    const a = await resident(app);
    const b = await resident(app);
    const ch = await joinHome(a.agent);
    await joinHome(b.agent);
    const msg = (await send(a.agent, ch.id, 'you will regret walking here').expect(201)).body;

    const first = await b.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'threat' }).expect(201);
    await b.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'threat' }).expect(200); // idempotent
    await a.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'spam' }).expect(400);
    const row = db.prepare('SELECT * FROM message_reports WHERE id = ?').get(first.body.id) as Record<string, unknown>;
    expect(row).toMatchObject({ snapshot_source: 'server', snapshot_text: 'you will regret walking here', status: 'open' });

    const outsider = await resident(app, 'gurugram-cyber-city');
    await outsider.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'spam' }).expect(404);
  });

  it('pauses posting after three different people report someone, and a moderator can review', async () => {
    const { app } = createTestApp({ env: { ADMIN_TOKEN: ADMIN } });
    const offender = await resident(app);
    const ch = await joinHome(offender.agent);
    const reporters = [await resident(app), await resident(app), await resident(app)];
    const msg = (await send(offender.agent, ch.id, 'abusive message').expect(201)).body;
    for (const [i, r] of reporters.entries()) {
      await joinHome(r.agent);
      await r.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'harassment' }).expect(201);
      const status = (await send(offender.agent, ch.id, `after report ${i}`)).status;
      expect(status).toBe(i < 2 ? 201 : 400);
    }
    expect((await send(offender.agent, ch.id, 'again').expect(400)).body.error.details).toEqual({ policy: 'suspended' });

    await request(app).get('/api/moderation/queue').expect(401);
    await request(app).get('/api/moderation/queue').set('X-Admin-Token', 'wrong').expect(401);
    const queue = (await request(app).get('/api/moderation/queue').set('X-Admin-Token', ADMIN).expect(200)).body;
    expect(queue.messages).toHaveLength(3);

    await request(app)
      .post(`/api/moderation/reports/${queue.messages[0].id}/resolve`)
      .set('X-Admin-Token', ADMIN)
      .send({ action: 'remove_from_channel', reason: 'Threatening language' })
      .expect(200);
    await offender.agent.get(`/api/community/channels/${ch.id}/messages`).expect(403);
    await request(app)
      .post(`/api/moderation/reports/${queue.messages[0].id}/resolve`)
      .set('X-Admin-Token', ADMIN)
      .send({ action: 'dismiss', reason: 'again' })
      .expect(409);
  });

  it('disables moderator endpoints entirely when no admin token is configured', async () => {
    const { app } = createTestApp();
    await request(app).get('/api/moderation/queue').set('X-Admin-Token', 'anything').expect(404);
  });

  it('accepts user reports', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const b = await resident(app);
    await b.agent.post('/api/reports').send({ reportedPublicId: a.publicId, reason: 'impersonation', details: 'Pretending to be a volunteer' }).expect(201);
    await b.agent.post('/api/reports').send({ reportedPublicId: b.publicId, reason: 'spam' }).expect(400);
  });
});

describe('account deletion', () => {
  it('removes the user from community channels', async () => {
    const { app } = createTestApp();
    const a = await resident(app);
    const b = await resident(app);
    const ch = await joinHome(a.agent);
    await joinHome(b.agent);
    await a.agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    expect((await b.agent.get(`/api/community/channels/${ch.id}`).expect(200)).body.memberCount).toBe(1);
  });
});
