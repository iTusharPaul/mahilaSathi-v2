import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, routePlanSchema, tripSchema, type RoutePlan } from '@mahilasathi/shared';
import { createTestApp, signIn, testClock } from '../helpers/testApp.js';

/**
 * The product's demo script (two windows, Lotus-42 and Jasmine-17), end to end through the real HTTP API.
 * Routing uses the labelled synthetic adapter (no network in tests); everything else is the production code.
 */

const PLACES = {
  cyberCity: { lat: 28.495, lng: 77.0895 }, // Gurugram, Haryana
  saket: { lat: 28.5245, lng: 77.2066 }, // South Delhi
  noida62: { lat: 28.627, lng: 77.372 }, // Noida, Uttar Pradesh
  connaughtPlace: { lat: 28.6315, lng: 77.2167 }, // New Delhi
  faridabad15: { lat: 28.396, lng: 77.315 }, // Faridabad, Haryana
  greenPark: { lat: 28.5552, lng: 77.2028 },
  selectCitywalk: { lat: 28.5283, lng: 77.2195 },
};
const states = (p: RoutePlan) => new Set(p.routes[0]!.jurisdictions.map((j) => j.stateName));

describe('demo script, end to end', () => {
  it('runs every step of both windows, plus the cross-state and safety demonstrations', async () => {
    const clock = testClock(new Date('2026-11-12T16:55:00.000Z')); // 22:25 IST
    const { app, db } = createTestApp({ clock, env: { DEMO_MODE: 'true', ADMIN_TOKEN: 'demo-admin-token-0123456789abcdef-012345' }, routingProviders: { places: null, cameras: null } });
    await app.services.demo.seed();
    const lotus = await signIn(app, DEMO_ACCOUNTS[0].phone);
    const jasmine = await signIn(app, DEMO_ACCOUNTS[1].phone);

    // ── Window A: Lotus-42 ────────────────────────────────────────────────────
    // 2–4. Plan Gurugram Cyber City → South Delhi, compare alternatives, review score and confidence.
    const cross = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: PLACES.cyberCity, destination: PLACES.saket, mode: 'drive' }).expect(201)).body);
    expect(states(cross)).toEqual(new Set(['Haryana', 'NCT of Delhi']));
    for (const r of cross.routes) {
      expect(r.factors).toHaveLength(8);
      expect(['high', 'medium', 'low']).toContain(r.confidence);
      expect(r.synthetic).toBe(true); // the dev adapter is labelled, never passed off as real roads
    }
    expect(cross.notices.join(' ')).toMatch(/synthetic/i);
    await lotus.agent.post('/api/routes/compare').send({ planId: cross.planId, ranking: 'fastest' }).expect(200);

    // 5–6. Start a (walking) journey and share it with the Guardian Circle.
    const walk = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: PLACES.greenPark, destination: PLACES.selectCitywalk, mode: 'walk' }).expect(201)).body);
    const trip = tripSchema.parse((await lotus.agent.post('/api/trips').send({ routeId: walk.routes[0]!.id, shareLevel: 'approximate' }).expect(201)).body);
    await lotus.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);

    // 7–8. Open Walk Together and review a matching journey (the demo companion, Neem-08).
    await app.services.demo.startCompanion({ from: [77.203, 28.555], to: [77.219, 28.5285] }, 45);
    const wt = (await lotus.agent.post('/api/walk-together/request').send({ tripId: trip.id, windowMinutes: 30 }).expect(200)).body;
    expect(wt.matches).toHaveLength(1);
    expect(wt.matches[0]).toMatchObject({ otherHandle: 'Neem-08', status: 'proposed', channelId: null });

    // 9. Send a neighbourhood update.
    const hood = (await lotus.agent.get('/api/community/channels').expect(200)).body.channels.find((c: { kind: string }) => c.kind === 'neighbourhood');
    await lotus.agent.post(`/api/community/channels/${hood.id}/updates`).send({ category: 'poor_lighting', note: 'Service lane lights are off tonight' }).expect(201);

    // ── Window B: Jasmine-17 ──────────────────────────────────────────────────
    // 2–4. Open the Guardian Circle, view Lotus's authorised journey status, acknowledge it.
    const circles = (await jasmine.agent.get('/api/circles').expect(200)).body.circles;
    expect(circles[0].isOwner).toBe(false);
    const [shared] = (await jasmine.agent.get('/api/trips/shared').expect(200)).body.trips;
    expect(shared).toMatchObject({ travellerName: 'Lotus Demo', status: 'ACTIVE', level: 'approximate', route: null });
    await jasmine.agent.post(`/api/trips/shared/${shared.shareId}/acknowledge`).expect(200);
    const notices = (await jasmine.agent.get(`/api/community/channels/${circles[0].channelId}/messages`).expect(200)).body.messages;
    expect(notices.some((m: { messageType: string; content: { text: string } }) => m.messageType === 'MS:JourneyStatus' && m.content.text.startsWith('[Demo]'))).toBe(true);

    // 5–6. Open the relevant neighbourhood channel and view community updates.
    const saket = (await jasmine.agent.get('/api/community/channels').expect(200)).body.channels.find((c: { kind: string }) => c.kind === 'neighbourhood');
    const updates = (await jasmine.agent.get(`/api/community/channels/${saket.id}/messages`).expect(200)).body.messages;
    expect(updates[0]).toMatchObject({ messageType: 'MS:InfraUpdate' });

    // ── Also demonstrate ──────────────────────────────────────────────────────
    // Noida → Delhi, and Haryana ↔ Uttar Pradesh corridors.
    const noida = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: PLACES.noida62, destination: PLACES.connaughtPlace, mode: 'drive' }).expect(201)).body);
    expect(states(noida)).toEqual(new Set(['Uttar Pradesh', 'NCT of Delhi']));
    const hrUp = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: PLACES.faridabad15, destination: PLACES.noida62, mode: 'drive' }).expect(201)).body);
    expect(states(hrUp).has('Haryana') && states(hrUp).has('Uttar Pradesh')).toBe(true);

    // Community report submission (labelled as a demo report).
    const report = (await lotus.agent.post('/api/community/reports').send({ category: 'broken_streetlight', description: 'Pole near the gate is dark', ...PLACES.saket }).expect(201)).body;
    expect(report).toMatchObject({ label: 'Community reported', demo: true });

    // User blocking and reporting (Jasmine reports and blocks the author of the Saket update).
    const neemMsg = updates[0];
    await jasmine.agent.post(`/api/moderation/messages/${neemMsg.id}/report`).send({ channelId: saket.id, reason: 'spam' }).expect(201);
    await jasmine.agent.post(`/api/users/${neemMsg.senderPublicId}/block`).expect(204);
    expect((await jasmine.agent.get(`/api/community/channels/${saket.id}/messages`).expect(200)).body.messages).toEqual([]);

    // SOS activation in demo mode, clearly not a real emergency.
    const sos = (await lotus.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body;
    expect(sos.demo).toBe(true);
    await app.services.sos.dispatchDue();
    const [alert] = (await jasmine.agent.get('/api/sos/received').expect(200)).body.alerts;
    expect(alert).toMatchObject({ demo: true, status: 'ACTIVE' });
    const sosChat = db.prepare("SELECT content_json FROM dev_chat_messages WHERE message_type = 'MS:SosAlert'").all() as { content_json: string }[];
    expect(sosChat.every((r) => (JSON.parse(r.content_json).text as string).startsWith('DEMO, not a real emergency.'))).toBe(true);
    await lotus.agent.post(`/api/sos/${sos.id}/cancel`).send({ outcome: 'false_alarm' }).expect(200);

    // Window A, step 10: complete the journey.
    const done = tripSchema.parse((await lotus.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED', feedback: 'comfortable' }).expect(200)).body);
    expect(done.status).toBe('ARRIVED');
    // Demo activity never becomes community intelligence.
    expect((db.prepare('SELECT COUNT(*) AS n FROM community_pulse_signals').get() as { n: number }).n).toBe(0);
  });

  it('lets a brand-new (non-demo) user sign up, onboard, plan, start and complete a journey', async () => {
    const clock = testClock(new Date('2026-11-12T16:55:00.000Z'));
    const { app } = createTestApp({ clock, routingProviders: { places: null, cameras: null } });
    const u = await signIn(app);
    expect(u.isNewUser).toBe(true);
    await u.agent.patch('/api/users/me').send({ displayName: 'New Rider', homeNeighbourhoodId: 'noida-sector-18', onboardingCompleted: true }).expect(200);
    await u.agent.post('/api/users/me/emergency-contacts').send({ name: 'Sister', phone: '9811122233' }).expect(201);
    const plan = routePlanSchema.parse((await u.agent.post('/api/routes/plan').send({ origin: PLACES.noida62, destination: PLACES.connaughtPlace, mode: 'drive' }).expect(201)).body);
    const trip = tripSchema.parse((await u.agent.post('/api/trips').send({ routeId: plan.routes[0]!.id }).expect(201)).body);
    await u.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await u.agent.post(`/api/trips/${trip.id}/checkin`).send({}).expect(200);
    const done = tripSchema.parse((await u.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED' }).expect(200)).body);
    expect(done.status).toBe('ARRIVED');
    expect((await u.agent.get('/api/auth/me').expect(200)).body.isDemo).toBe(false);
  });
});
