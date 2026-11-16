import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chatSessionSchema, circleSchema, inviteCreatedSchema, routePlanSchema, tripSchema } from '@mahilasathi/shared';
import { createTestApp, signIn, testClock, type TestContext } from '../helpers/testApp.js';

/**
 * The security tests listed in the product specification, in one place:
 * - User A cannot access User B's private trip.
 * - User A cannot access another user's Guardian Circle.
 * - Blocked users cannot bypass restrictions through a new channel.
 * - Exact location is never exposed to public channels.
 * - Unauthorised users cannot modify SOS events.
 * - Repeated SOS requests do not create duplicate incidents.
 * (Secrets in frontend bundles: tests/security/client-bundle-secrets.test.ts.)
 */

const SAKET = { lat: 28.5245, lng: 77.2066 };
const MALVIYA = { lat: 28.5355, lng: 77.2109 };
const COORDS = /28\.5[0-9]{2}|77\.2[0-9]{2}/;

async function person(app: TestContext['app'], name: string) {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: name, homeNeighbourhoodId: 'delhi-saket' }).expect(200);
  const { chatUserId } = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  return { ...s, publicId: chatUserId };
}

describe('authorisation and privacy (security suite)', () => {
  it('keeps trips, circles and SOS events private, and never puts coordinates in shared channels', async () => {
    const clock = testClock(new Date('2026-11-12T16:55:00.000Z'));
    const { app, db } = createTestApp({ clock, routingProviders: { places: null, cameras: null } }); // labelled synthetic routing
    const asha = await person(app, 'Asha');
    const guardian = await person(app, 'Guardian');
    const other = await person(app, 'Other');

    // Asha: a circle, a journey shared precisely with live location, a neighbourhood update, an SOS.
    const circle = circleSchema.parse((await asha.agent.post('/api/circles').send({ name: 'Family' }).expect(201)).body);
    const { code } = inviteCreatedSchema.parse((await asha.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body);
    await guardian.agent.post('/api/circles/accept').send({ code }).expect(200);
    const plan = routePlanSchema.parse((await asha.agent.post('/api/routes/plan').send({ origin: MALVIYA, destination: SAKET, mode: 'walk' }).expect(201)).body);
    const trip = tripSchema.parse((await asha.agent.post('/api/trips').send({ routeId: plan.routes[0]!.id, shareLevel: 'precise' }).expect(201)).body);
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await asha.agent.put(`/api/trips/${trip.id}/location-sharing`).send({ enabled: true }).expect(200);
    await asha.agent.post(`/api/trips/${trip.id}/location`).send(SAKET).expect(200);
    const hood = (await asha.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200)).body;
    await other.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200);
    await asha.agent.post(`/api/community/channels/${hood.id}/updates`).send({ category: 'poor_lighting', note: 'Lane behind the market is dark' }).expect(201);
    const sos = (await asha.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID(), location: SAKET }).expect(201)).body;
    await app.services.sos.dispatchDue();

    // User A cannot access User B's private trip.
    await other.agent.get(`/api/trips/${trip.id}`).expect(404);
    await other.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'CANCELLED' }).expect(404);
    await other.agent.post(`/api/trips/${trip.id}/location`).send(SAKET).expect(404);
    await other.agent.post(`/api/trips/${trip.id}/share`).send({ level: 'precise' }).expect(404);
    await other.agent.get(`/api/walk-together/trips/${trip.id}`).expect(404);
    expect((await other.agent.get('/api/trips/shared').expect(200)).body.trips).toEqual([]);
    expect((await other.agent.get('/api/trips').expect(200)).body.trips).toEqual([]);

    // User A cannot access another user's Guardian Circle.
    expect((await other.agent.get('/api/circles').expect(200)).body.circles).toEqual([]);
    await other.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(404);
    await other.agent.get(`/api/community/channels/${circle.channelId}`).expect(404);
    await other.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(403);

    // Unauthorised users cannot read or modify SOS events (a guardian can read and respond, not change).
    for (const p of [other, guardian]) {
      await p.agent.post(`/api/sos/${sos.id}/cancel`).send({ outcome: 'false_alarm' }).expect(404);
      await p.agent.post(`/api/sos/${sos.id}/location`).send(SAKET).expect(404);
      await p.agent.put(`/api/sos/${sos.id}/location-sharing`).send({ enabled: false }).expect(404);
    }
    await other.agent.get(`/api/sos/${sos.id}`).expect(404);
    await other.agent.post(`/api/sos/${sos.id}/acknowledge`).send({ response: 'seen' }).expect(404);
    await guardian.agent.get(`/api/sos/${sos.id}`).expect(200);

    // Repeated SOS requests do not create duplicate incidents, even fired concurrently with fresh keys.
    const burst = await Promise.all(Array.from({ length: 5 }, () => asha.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() })));
    expect(new Set(burst.map((r) => r.body.id))).toEqual(new Set([sos.id]));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sos_events WHERE user_id = (SELECT user_id FROM sos_events LIMIT 1)').get() as { n: number }).n).toBe(1);

    // Exact location is never exposed to public channels, and server-sent safety messages stay in the circle.
    const rows = db
      .prepare('SELECT c.kind, m.message_type, m.content_json FROM dev_chat_messages m JOIN community_channels c ON c.id = m.channel_id')
      .all() as { kind: string; message_type: string; content_json: string }[];
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(r.content_json).not.toMatch(COORDS);
    for (const r of rows.filter((x) => ['MS:SosAlert', 'MS:JourneyStatus'].includes(x.message_type))) expect(r.kind).toBe('guardian_circle');
    // Public community endpoints carry no coordinates either.
    const publicBodies = [
      (await other.agent.get('/api/community/channels').expect(200)).body,
      (await other.agent.get('/api/community/journey-rooms').expect(200)).body,
      (await other.agent.get(`/api/community/channels/${hood.id}/messages`).expect(200)).body,
      (await other.agent.get(`/api/community/channels/${hood.id}/members`).expect(200)).body,
    ];
    for (const b of publicBodies) expect(JSON.stringify(b)).not.toMatch(COORDS);
  });

  it('does not let a blocked user bypass the block through a newly created channel', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const a = await person(app, 'Alpha');
    const b = await person(app, 'Bravo');
    await b.agent.post(`/api/users/${a.publicId}/block`).expect(204);
    const room = {
      from: { type: 'neighbourhood', id: 'gurugram-cyber-city' },
      to: { type: 'neighbourhood', id: 'delhi-saket' },
      windowStart: new Date(clock().getTime() + 30 * 60_000).toISOString(),
      windowMinutes: 30,
    };
    const created = (await a.agent.post('/api/community/channels').send(room).expect(201)).body;
    await b.agent.post(`/api/community/channels/${created.id}/join`).expect(403);
    const theirs = (await b.agent.post('/api/community/channels').send(room).expect(201)).body;
    await a.agent.post(`/api/community/channels/${theirs.id}/join`).expect(403);
  });
});
