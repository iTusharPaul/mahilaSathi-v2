import { describe, expect, it } from 'vitest';
import {
  chatSessionSchema,
  circleSchema,
  inviteCreatedSchema,
  pulseCellSchema,
  routePlanSchema,
  sharedTripSchema,
  tripSchema,
  walkMatchSchema,
  type LngLat,
} from '@mahilasathi/shared';
import { cellToLatLng } from 'h3-js';
import type { RoutingProvider } from '../../server/src/services/routing/providers.js';
import { createTestApp, signIn, testClock, type TestContext } from '../helpers/testApp.js';

// A walk along Mehrauli–Badarpur Road, South Delhi (about 4 km, west to east). Synthetic test geometry.
const WEST = { lat: 28.515, lng: 77.19 };
const EAST = { lat: 28.515, lng: 77.23 };
const ADMIN = 'test-admin-token-0123456789abcdef-0123456789';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Straight-line routes at walking speed: deterministic, no network. */
const straightRouting: RoutingProvider = {
  name: 'fake-routing',
  mode: 'live',
  variants: () => [{ variant: 'balanced', label: 'Recommended by routing' }],
  async route(o: LngLat, d: LngLat, _mode, variant) {
    const coords = Array.from({ length: 81 }, (_, i) => [o[0] + ((d[0] - o[0]) * i) / 80, o[1] + ((d[1] - o[1]) * i) / 80] as LngLat);
    const distanceM = Math.hypot((d[0] - o[0]) * 97_800, (d[1] - o[1]) * 111_200);
    return {
      variant,
      label: variant,
      synthetic: false,
      distanceM,
      durationS: distanceM / 1.3,
      coordinates: coords,
      steps: [{ fromIndex: 0, toIndex: 80, distanceM, roadClass: 'primary', instructionType: 'StartAt' }],
    };
  },
};

function setup() {
  const clock = testClock(new Date('2026-11-12T16:55:00.000Z')); // 22:25 IST
  const ctx = createTestApp({ clock, env: { ADMIN_TOKEN: ADMIN }, routingProviders: { routing: straightRouting, places: null, cameras: null } });
  return { ...ctx, clock };
}

async function person(app: TestContext['app'], name: string) {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: name }).expect(200);
  const { chatUserId } = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  return { ...s, name, publicId: chatUserId };
}
type Person = Awaited<ReturnType<typeof person>>;

async function circleWith(owner: Person, ...guardians: Person[]) {
  const circle = circleSchema.parse((await owner.agent.post('/api/circles').send({ name: 'Family' }).expect(201)).body);
  for (const g of guardians) {
    const { code } = inviteCreatedSchema.parse((await owner.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body);
    await g.agent.post('/api/circles/accept').send({ code }).expect(200);
  }
  return circle;
}

async function plan(p: Person, from = WEST, to = EAST, mode = 'walk') {
  const res = await p.agent.post('/api/routes/plan').send({ origin: from, destination: to, mode }).expect(201);
  return routePlanSchema.parse(res.body);
}

async function startTrip(p: Person, body: Record<string, unknown> = {}, from = WEST, to = EAST, mode = 'walk') {
  const pl = await plan(p, from, to, mode);
  const res = await p.agent.post('/api/trips').send({ routeId: pl.routes[0]!.id, ...body }).expect(201);
  return tripSchema.parse(res.body);
}

const circleMessages = async (p: Person, channelId: string) =>
  ((await p.agent.get(`/api/community/channels/${channelId}/messages`).expect(200)).body.messages as { messageType: string; content: { status?: string; text: string } }[]);

describe('journeys', () => {
  it('runs a journey from start to arrival, with guardians seeing only what was shared', async () => {
    const { app, db, clock } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    const stranger = await person(app, 'Stranger');
    const circle = await circleWith(asha, meera);

    const trip = await startTrip(asha, { shareLevel: 'approximate', destinationLabel: 'Home' });
    expect(trip).toMatchObject({ status: 'CREATED', mode: 'walk', destinationLabel: 'Home', locationSharing: false, allowedTransitions: ['ACTIVE', 'CANCELLED'] });
    expect(trip.shares).toEqual([{ id: expect.any(String), circleName: 'Family', level: 'approximate', active: true, acknowledgedBy: [] }]);
    // One open journey at a time; journeys can't skip the start.
    const again = await plan(asha);
    await asha.agent.post('/api/trips').send({ routeId: again.routes[0]!.id }).expect(409);
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED' }).expect(409);
    // DELAYED is set by the server only.
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'DELAYED' }).expect(400);

    const started = tripSchema.parse((await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200)).body);
    expect(started.status).toBe('ACTIVE');
    expect(Date.parse(started.expectedArrivalAt!) - Date.parse(started.startedAt!)).toBeCloseTo(started.route.durationS * 1000, -3);
    expect(Date.parse(started.nextCheckinDueAt!) - Date.parse(started.startedAt!)).toBe(15 * MIN);
    expect((await asha.agent.get('/api/trips/active').expect(200)).body.trip.id).toBe(trip.id);

    // The guardian sees status and destination area, but no route or location at "approximate" with sharing off.
    const [seen] = (await meera.agent.get('/api/trips/shared').expect(200)).body.trips.map((t: unknown) => sharedTripSchema.parse(t));
    expect(seen).toMatchObject({ id: trip.id, travellerName: 'Asha', level: 'approximate', status: 'ACTIVE', route: null, lastLocation: null, acknowledged: false });

    // Live location: approximate shows an area name only.
    await asha.agent.post(`/api/trips/${trip.id}/location`).send({ lat: 28.515, lng: 77.2 }).expect(409);
    await asha.agent.put(`/api/trips/${trip.id}/location-sharing`).send({ enabled: true }).expect(200);
    expect((await asha.agent.post(`/api/trips/${trip.id}/location`).send({ lat: 28.515, lng: 77.2, accuracyM: 20 }).expect(200)).body).toEqual({ stored: true });
    expect((await asha.agent.post(`/api/trips/${trip.id}/location`).send({ lat: 28.515, lng: 77.201 }).expect(200)).body).toEqual({ stored: false }); // throttled
    const approx = sharedTripSchema.parse((await meera.agent.get(`/api/trips/shared/${seen.shareId}`).expect(200)).body);
    expect(approx.lastLocation).toMatchObject({ lat: null, lng: null });
    expect(approx.progressPct).toBeGreaterThanOrEqual(20);
    expect(approx.progressPct).toBeLessThanOrEqual(30);

    // Precise adds the exact point and route.
    await asha.agent.post(`/api/trips/${trip.id}/share`).send({ level: 'precise' }).expect(200);
    const precise = sharedTripSchema.parse((await meera.agent.get(`/api/trips/shared/${seen.shareId}`).expect(200)).body);
    expect(precise.lastLocation).toMatchObject({ lat: 28.515, lng: 77.2 });
    expect(precise.route?.geometry.length).toBeGreaterThan(10);

    // Strangers learn nothing, not even that the journey exists.
    await stranger.agent.get(`/api/trips/${trip.id}`).expect(404);
    await stranger.agent.get(`/api/trips/shared/${seen.shareId}`).expect(404);
    await stranger.agent.post(`/api/trips/shared/${seen.shareId}/acknowledge`).expect(404);
    await stranger.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'CANCELLED' }).expect(404);
    await stranger.agent.post(`/api/trips/${trip.id}/location`).send({ lat: 28.5, lng: 77.2 }).expect(404);
    expect((await stranger.agent.get('/api/trips/shared').expect(200)).body.trips).toEqual([]);
    // The traveller cannot use the guardian endpoint on their own journey either.
    await asha.agent.get(`/api/trips/shared/${seen.shareId}`).expect(404);

    // Acknowledge and check in.
    await meera.agent.post(`/api/trips/shared/${seen.shareId}/acknowledge`).expect(200);
    clock.advance(5 * MIN);
    const checked = tripSchema.parse((await asha.agent.post(`/api/trips/${trip.id}/checkin`).send({ note: 'Passing the metro' }).expect(200)).body);
    expect(checked.shares[0]!.acknowledgedBy).toEqual(['Meera']);
    expect(Date.parse(checked.nextCheckinDueAt!)).toBe(clock().getTime() + 15 * MIN);

    // Arrive with feedback: sharing stops, guardians see the outcome without any location.
    clock.advance(20 * MIN);
    const arrived = tripSchema.parse((await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED', feedback: 'comfortable' }).expect(200)).body);
    expect(arrived).toMatchObject({ status: 'ARRIVED', locationSharing: false, nextCheckinDueAt: null, allowedTransitions: [] });
    const after = sharedTripSchema.parse((await meera.agent.get(`/api/trips/shared/${seen.shareId}`).expect(200)).body);
    expect(after).toMatchObject({ status: 'ARRIVED', lastLocation: null, route: null, progressPct: null });
    await asha.agent.post(`/api/trips/${trip.id}/checkin`).send({}).expect(409);
    await asha.agent.put(`/api/trips/${trip.id}/location-sharing`).send({ enabled: true }).expect(409);

    // The circle chat received structured MS:JourneyStatus updates (server-sent).
    const msgs = await circleMessages(meera, circle.channelId);
    const statuses = msgs.filter((m) => m.messageType === 'MS:JourneyStatus').map((m) => m.content.status);
    expect(statuses).toEqual(expect.arrayContaining(['CREATED', 'ACTIVE', 'ARRIVED']));
    expect(msgs.map((m) => m.content.text).join('\n')).toContain('Asha arrived safely.');
    // No coordinates are ever written into chat.
    expect(JSON.stringify(msgs)).not.toMatch(/28\.5\d|77\.\d{2}/);

    // Retention: guardians stop seeing it after 12 h; live points go after 24 h; exact endpoints after 30 days.
    clock.advance(13 * HOUR);
    expect((await meera.agent.get('/api/trips/shared').expect(200)).body.trips).toEqual([]);
    clock.advance(12 * HOUR);
    expect(app.services.trips.purge().tripLocations).toBe(1);
    clock.advance(30 * 24 * HOUR);
    expect(app.services.trips.purge().tripCoordinates).toBe(1);
    expect(db.prepare('SELECT origin_lat, destination_lng, destination_label FROM trips WHERE id = ?').get(trip.id)).toEqual({ origin_lat: null, destination_lng: null, destination_label: null });
  });

  it('marks overdue journeys DELAYED, alerts the circle, and resumes on check-in', async () => {
    const { app, clock } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    const circle = await circleWith(asha, meera);
    const trip = await startTrip(asha, { shareLevel: 'status' });
    const started = tripSchema.parse((await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200)).body);
    // Status-only shares can't carry live location.
    await asha.agent.put(`/api/trips/${trip.id}/location-sharing`).send({ enabled: true }).expect(400);

    // Grace is max(10 min, 25% of duration): nothing happens just after the expected arrival.
    const grace = Math.max(10 * MIN, started.route.durationS * 250);
    clock.advance(started.route.durationS * 1000 + grace - MIN);
    expect(await app.services.trips.tick()).toEqual({ delayed: 0, expired: 0 });
    clock.advance(2 * MIN);
    expect(await app.services.trips.tick()).toEqual({ delayed: 1, expired: 0 });
    const delayed = tripSchema.parse((await asha.agent.get(`/api/trips/${trip.id}`).expect(200)).body);
    expect(delayed.status).toBe('DELAYED');
    expect((await circleMessages(meera, circle.channelId)).at(-1)!.content.text).toContain('has not arrived yet');

    // "I'm OK" from DELAYED resumes the journey with 15 more minutes.
    const resumed = tripSchema.parse((await asha.agent.post(`/api/trips/${trip.id}/checkin`).send({}).expect(200)).body);
    expect(resumed.status).toBe('ACTIVE');
    expect(Date.parse(resumed.expectedArrivalAt!)).toBe(clock().getTime() + 15 * MIN);

    // Escalate: the circle is asked to help, and pointed to 112. No emergency service is contacted.
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ESCALATED' }).expect(200);
    expect((await circleMessages(meera, circle.channelId)).at(-1)!.content.text).toContain('call 112');
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'CANCELLED' }).expect(409);
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED' }).expect(200);
  });

  it('cancels journeys never started and requires a circle to escalate', async () => {
    const { app, clock } = setup();
    const solo = await person(app, 'Solo');
    const trip = await startTrip(solo); // no circle, no preference: private
    expect(trip.shares).toEqual([]);
    await solo.agent.post(`/api/trips/${trip.id}/share`).send({ level: 'status' }).expect(400);
    await solo.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await solo.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ESCALATED' }).expect(400);
    await solo.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'CANCELLED' }).expect(200);

    const later = await startTrip(solo);
    clock.advance(2 * HOUR + MIN);
    expect(await app.services.trips.tick()).toEqual({ delayed: 0, expired: 1 });
    expect(tripSchema.parse((await solo.agent.get(`/api/trips/${later.id}`).expect(200)).body).status).toBe('CANCELLED');
  });

  it('only accepts routes from the caller’s own plans', async () => {
    const { app } = setup();
    const a = await person(app, 'Anu');
    const b = await person(app, 'Bina');
    const p = await plan(a);
    await b.agent.post('/api/trips').send({ routeId: p.routes[0]!.id }).expect(404);
  });
});

describe('Walk Together', () => {
  it('matches walkers on the same corridor by pseudonym and opens a pair channel only after both accept', async () => {
    const { app, db } = setup();
    const a = await person(app, 'Alpha');
    const b = await person(app, 'Bravo');
    const opposite = await person(app, 'Charlie');
    const blocked = await person(app, 'Delta');

    const ta = await startTrip(a);
    const tb = await startTrip(b, {}, { lat: 28.5152, lng: 77.192 }, { lat: 28.5148, lng: 77.228 });
    const tc = await startTrip(opposite, {}, EAST, WEST);
    const td = await startTrip(blocked);
    await a.agent.post(`/api/users/${blocked.publicId}/block`).send({}).expect(204);

    await a.agent.post('/api/walk-together/request').send({ tripId: ta.id, windowMinutes: 20 }).expect(200);
    await opposite.agent.post('/api/walk-together/request').send({ tripId: tc.id }).expect(200);
    await blocked.agent.post('/api/walk-together/request').send({ tripId: td.id }).expect(200);
    const res = (await b.agent.post('/api/walk-together/request').send({ tripId: tb.id, windowMinutes: 20 }).expect(200)).body;

    // Bravo is matched with Alpha and Delta (same direction), never with Charlie (opposite direction).
    const matches: ReturnType<typeof walkMatchSchema.parse>[] = res.matches.map((m: unknown) => walkMatchSchema.parse(m));
    expect(matches.map((x) => x.otherHandle).sort()).toEqual([a.user.communityHandle, blocked.user.communityHandle].sort());
    const m = matches.find((x) => x.otherHandle === a.user.communityHandle)!;
    expect(m).toMatchObject({ status: 'proposed', myAccepted: false, theyAccepted: false, channelId: null });
    expect(m.overlapPct).toBeGreaterThanOrEqual(40);
    expect(m.sharedAreas.length).toBeGreaterThan(0);
    // Nothing identifying: no names, phones or coordinates.
    const raw = JSON.stringify(res);
    expect(raw).not.toContain('Alpha');
    expect(raw).not.toContain(a.phone);
    expect(raw).not.toMatch(/28\.5\d|77\.\d{2}/);
    // Alpha blocked Delta, so those two are never proposed to each other (in either direction).
    const handles = async (p: Person) => ((await p.agent.get('/api/walk-together/matches').expect(200)).body.matches as { otherHandle: string }[]).map((x) => x.otherHandle);
    expect(await handles(a)).toEqual([b.user.communityHandle]);
    expect(await handles(blocked)).toEqual([b.user.communityHandle]);
    expect(await handles(opposite)).toEqual([]);

    // Others can't act on the match.
    await opposite.agent.post(`/api/walk-together/matches/${m.id}/accept`).expect(404);

    // One acceptance is not enough.
    const half = walkMatchSchema.parse((await a.agent.post(`/api/walk-together/matches/${m.id}/accept`).expect(200)).body);
    expect(half).toMatchObject({ status: 'proposed', myAccepted: true, theyAccepted: false, channelId: null });
    const bView = (await b.agent.get('/api/walk-together/matches').expect(200)).body.matches.find((x: { id: string }) => x.id === m.id);
    expect(walkMatchSchema.parse(bView)).toMatchObject({ theyAccepted: true, myAccepted: false });

    const both = walkMatchSchema.parse((await b.agent.post(`/api/walk-together/matches/${m.id}/accept`).expect(200)).body);
    expect(both.status).toBe('accepted');
    expect(both.channelId).toBeTruthy();
    // Once a pair forms, other pending proposals for either walker are withdrawn.
    expect(await handles(blocked)).toEqual([]);
    const channel = (await a.agent.get(`/api/community/channels/${both.channelId}`).expect(200)).body;
    expect(channel).toMatchObject({ kind: 'walk_together', maxMembers: 2, memberCount: 2, isMember: true });
    await opposite.agent.get(`/api/community/channels/${both.channelId}/messages`).expect(403);
    // Contact details are blocked between strangers, even after matching.
    await a.agent.post(`/api/community/channels/${both.channelId}/messages`).send({ text: 'call me 98765 43210' }).expect(400);
    await a.agent.post(`/api/community/channels/${both.channelId}/messages`).send({ text: 'Meet at the metro gate?' }).expect(201);
    const msgs = (await b.agent.get(`/api/community/channels/${both.channelId}/messages`).expect(200)).body.messages;
    expect(msgs[0].content.text).toContain('well-lit public place');

    // A "withdraw" sent from a stale view (still showing "proposed") must not break up the new pair.
    await a.agent.post(`/api/walk-together/matches/${m.id}/cancel`).send({ expect: 'proposed' }).expect(409);
    expect((db.prepare('SELECT status FROM community_channels WHERE id = ?').get(both.channelId) as { status: string }).status).toBe('active');

    // Leaving the pair closes the channel for both.
    await b.agent.post(`/api/walk-together/matches/${m.id}/cancel`).send({ expect: 'accepted' }).expect(200);
    expect((db.prepare('SELECT status FROM community_channels WHERE id = ?').get(both.channelId) as { status: string }).status).toBe('archived');
  });

  it('withdraws proposals when a journey ends, and refuses short or driving journeys', async () => {
    const { app } = setup();
    const a = await person(app, 'Alpha');
    const b = await person(app, 'Bravo');
    const ta = await startTrip(a);
    const tb = await startTrip(b);
    await a.agent.post('/api/walk-together/request').send({ tripId: ta.id }).expect(200);
    const m = (await b.agent.post('/api/walk-together/request').send({ tripId: tb.id }).expect(200)).body.matches[0];
    await a.agent.patch(`/api/trips/${ta.id}/status`).send({ status: 'CANCELLED' }).expect(200);
    expect((await b.agent.get('/api/walk-together/matches').expect(200)).body.matches).toEqual([]);
    await b.agent.post(`/api/walk-together/matches/${m.id}/accept`).expect(409);
    await b.agent.patch(`/api/trips/${tb.id}/status`).send({ status: 'CANCELLED' }).expect(200);

    const short = await startTrip(a, {}, WEST, { lat: 28.515, lng: 77.195 }); // ~500 m: nothing left after trimming
    await a.agent.post('/api/walk-together/request').send({ tripId: short.id }).expect(400);
    await a.agent.patch(`/api/trips/${short.id}/status`).send({ status: 'CANCELLED' }).expect(200);
    const drive = await startTrip(a, {}, WEST, EAST, 'drive');
    await a.agent.post('/api/walk-together/request').send({ tripId: drive.id }).expect(400);
  });
});

describe('community reports and Pulse', () => {
  it('labels reports, hides unverified allegations, and only verifies through moderation', async () => {
    const { app } = setup();
    const reporter = await person(app, 'Reporter');
    const neighbour = await person(app, 'Neighbour');
    const here = { lat: 28.5152, lng: 77.2001 };

    const light = (await reporter.agent.post('/api/community/reports').send({ category: 'poor_lighting', description: 'Streetlights out near the bus stop', ...here }).expect(201)).body;
    expect(light).toMatchObject({ label: 'Community reported', mine: true });
    await reporter.agent.post('/api/community/reports').send({ category: 'poor_lighting', description: 'Still dark here tonight', ...here }).expect(409);
    await reporter.agent.post('/api/community/reports').send({ category: 'other', description: 'Somewhere far away', lat: 26.91, lng: 75.79 }).expect(400);

    const allegation = (await reporter.agent.post('/api/community/reports').send({ category: 'harassment', description: 'A man followed me from the gate', ...here }).expect(201)).body;
    expect(allegation.label).toBe('Under review');

    const near = (await neighbour.agent.get('/api/community/reports').query(here).expect(200)).body.reports;
    expect(near.map((r: { category: string }) => r.category)).toEqual(['poor_lighting']);
    expect(JSON.stringify(near)).not.toContain(reporter.user.communityHandle);
    expect(JSON.stringify(near)).not.toContain('Reporter');

    // Moderation is token-protected.
    await neighbour.agent.get('/api/moderation/community-reports').expect(401);
    const queue = (await neighbour.agent.get('/api/moderation/community-reports').set('x-admin-token', ADMIN).expect(200)).body.reports;
    expect(queue.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([light.id, allegation.id]));
    await neighbour.agent.post(`/api/moderation/community-reports/${allegation.id}/review`).set('x-admin-token', ADMIN).send({ decision: 'verify', note: 'CCTV confirmed' }).expect(200);
    await neighbour.agent.post(`/api/moderation/community-reports/${allegation.id}/review`).set('x-admin-token', ADMIN).send({ decision: 'verify', note: 'again' }).expect(409);

    const after = (await neighbour.agent.get('/api/community/reports').query(here).expect(200)).body.reports;
    expect(after.find((r: { category: string }) => r.category === 'harassment')).toMatchObject({ label: 'Verified information' });
  });

  it('aggregates completed journeys into the Pulse only once three people contribute', async () => {
    const { app, db } = setup();
    const walkers = [await person(app, 'W1'), await person(app, 'W2'), await person(app, 'W3')];
    const probe = { lat: 28.515, lng: 77.21 };

    for (const [i, w] of walkers.entries()) {
      const t = await startTrip(w);
      await w.agent.patch(`/api/trips/${t.id}/status`).send({ status: 'ACTIVE' }).expect(200);
      await w.agent.patch(`/api/trips/${t.id}/status`).send({ status: 'ARRIVED', feedback: 'comfortable' }).expect(200);
      const cells = (await w.agent.get('/api/community/pulse').query(probe).expect(200)).body.cells.map((c: unknown) => pulseCellSchema.parse(c));
      const centre = cells[0]!;
      if (i < 2) expect(centre).toMatchObject({ level: 'insufficient', contributors: 'fewer than 3', value: 0.5 });
      else expect(centre).toMatchObject({ level: 'positive', contributors: '3–9' });
    }
    // Responses never identify contributors.
    const body = JSON.stringify((await walkers[0]!.agent.get('/api/community/pulse').query(probe).expect(200)).body);
    for (const w of walkers) expect(body).not.toContain(w.user.id);

    // Signals sit only on the trimmed corridor: the exact start and end cells get nothing.
    const cells = (db.prepare('SELECT DISTINCT cell FROM community_pulse_signals').all() as { cell: string }[]).map((r) => r.cell);
    const nearest = (p: { lat: number; lng: number }) =>
      Math.min(...cells.map((c) => {
        const [lat, lng] = cellToLatLng(c);
        return Math.hypot((lat - p.lat) * 111_200, (lng - p.lng) * 97_800);
      }));
    expect(nearest(WEST)).toBeGreaterThan(150);
    expect(nearest(EAST)).toBeGreaterThan(150);

    // Route scoring now uses the Pulse for this corridor.
    const scored = await plan(walkers[0]!);
    const factor = scored.routes[0]!.factors.find((f) => f.key === 'communityPulse')!;
    expect(factor.raw).toMatch(/^Signals for \d+% of the route$/);
    expect(factor.score).toBeGreaterThan(0.6);
  });

  it('forgets a deleted account’s journeys, reports and signals', async () => {
    const { app, db } = setup();
    const w = await person(app, 'Leaving');
    const t = await startTrip(w);
    await w.agent.patch(`/api/trips/${t.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await w.agent.patch(`/api/trips/${t.id}/status`).send({ status: 'ARRIVED' }).expect(200);
    await w.agent.post('/api/community/reports').send({ category: 'poor_lighting', description: 'Dark lane by the park', lat: 28.515, lng: 77.2 }).expect(201);
    await w.agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    const count = (sql: string) => (db.prepare(sql).get(w.user.id) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM community_reports WHERE user_id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM community_pulse_signals WHERE contributor_id = ?')).toBe(0);
  });
});
