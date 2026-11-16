import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, meSchema, routePlanSchema, tripSchema } from '@mahilasathi/shared';
import { DemoModeRequiredError } from '../../server/src/services/demo/demoSeeder.js';
import { createTestApp, signIn, testClock } from '../helpers/testApp.js';

const demoApp = () => {
  const clock = testClock(new Date('2026-11-12T16:55:00.000Z'));
  // Synthetic (labelled) routing: no network in tests.
  return { ...createTestApp({ clock, env: { DEMO_MODE: 'true' }, routingProviders: { places: null, cameras: null } }), clock };
};
const signInAs = (app: Parameters<typeof signIn>[0], i: number) => signIn(app, DEMO_ACCOUNTS[i]!.phone);

describe('demo mode', () => {
  it('refuses to create demo data unless DEMO_MODE is on', async () => {
    const { app, db } = createTestApp();
    await expect(app.services.demo.seed()).rejects.toBeInstanceOf(DemoModeRequiredError);
    await expect(app.services.demo.startCompanion()).rejects.toBeInstanceOf(DemoModeRequiredError);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
  });

  it('seeds fictional, labelled accounts idempotently', async () => {
    const { app, db } = demoApp();
    const first = await app.services.demo.seed();
    expect(first.accounts.map((a) => [a.handle, a.created])).toEqual([['Lotus-42', true], ['Jasmine-17', true], ['Neem-08', true]]);
    const again = await app.services.demo.seed();
    expect(again.accounts.every((a) => !a.created)).toBe(true);
    expect(again.notes).toEqual([]);
    expect(db.prepare('SELECT community_handle, is_demo FROM users ORDER BY community_handle').all()).toEqual([
      { community_handle: 'Jasmine-17', is_demo: 1 },
      { community_handle: 'Lotus-42', is_demo: 1 },
      { community_handle: 'Neem-08', is_demo: 1 },
    ]);

    // Demo accounts sign in through the normal (development) OTP flow and are labelled.
    const lotus = await signInAs(app, 0);
    const me = meSchema.parse((await lotus.agent.get('/api/auth/me').expect(200)).body);
    expect(me).toMatchObject({ communityHandle: 'Lotus-42', displayName: 'Lotus Demo', isDemo: true, onboardingCompleted: true });
    expect(me.homeArea?.neighbourhood?.id).toBe('gurugram-cyber-city');
    const circles = (await lotus.agent.get('/api/circles').expect(200)).body.circles;
    expect(circles[0].members.map((m: { displayName: string }) => m.displayName)).toEqual(['Lotus Demo', 'Jasmine Demo']);
    expect((await lotus.agent.get('/api/users/me/emergency-contacts').expect(200)).body.contacts).toHaveLength(1);

    // The Saket channel carries one demo update, and members are marked as demo accounts.
    const jasmine = await signInAs(app, 1);
    const ch = (await jasmine.agent.get('/api/community/channels').expect(200)).body.channels.find((c: { kind: string }) => c.kind === 'neighbourhood');
    const msgs = (await jasmine.agent.get(`/api/community/channels/${ch.id}/messages`).expect(200)).body.messages;
    expect(msgs[0].content.note).toMatch(/^\[Demo\]/);
    const members = (await jasmine.agent.get(`/api/community/channels/${ch.id}/members`).expect(200)).body.members;
    expect(members.every((m: { isDemo: boolean }) => m.isDemo)).toBe(true);

    // Real users are never labelled demo.
    const real = await signIn(app);
    expect((await real.agent.get('/api/auth/me').expect(200)).body.isDemo).toBe(false);
  });

  it('marks every demo SOS message as not a real emergency', async () => {
    const { app, db } = demoApp();
    await app.services.demo.seed();
    const lotus = await signInAs(app, 0);
    const jasmine = await signInAs(app, 1);
    const sos = (await lotus.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body;
    expect(sos.demo).toBe(true);
    await app.services.sos.dispatchDue();
    const alert = (await jasmine.agent.get('/api/sos/received').expect(200)).body.alerts[0];
    expect(alert).toMatchObject({ demo: true, travellerName: 'Lotus Demo' });
    const chatTexts = (db.prepare("SELECT content_json FROM dev_chat_messages WHERE message_type = 'MS:SosAlert'").all() as { content_json: string }[]).map((r) => JSON.parse(r.content_json).text as string);
    expect(chatTexts.length).toBeGreaterThan(0);
    for (const t of chatTexts) expect(t.startsWith('DEMO, not a real emergency.')).toBe(true);
  });

  it('on a demo server, labels every SOS as a demo, including ones raised by ordinary sign-ups', async () => {
    const { app, db } = createTestApp({ env: { DEMO_MODE: 'true', SMS_PROVIDER: 'mock' }, routingProviders: { places: null, cameras: null } });
    const tester = await signIn(app);
    expect((await tester.agent.get('/api/auth/me').expect(200)).body.isDemo).toBe(false);
    await tester.agent.post('/api/users/me/emergency-contacts').send({ name: 'Test contact', phone: '9000000098', relationship: 'Friend' }).expect(201);
    await tester.agent.patch('/api/users/me/sos-settings').send({ emergencyContacts: 'immediately' }).expect(200);
    const sos = (await tester.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body;
    expect(sos.demo).toBe(true);
    await app.services.sos.dispatchDue();
    const sms = db.prepare('SELECT body FROM dev_sms_outbox').all() as { body: string }[];
    expect(sms.length).toBeGreaterThan(0);
    for (const m of sms) expect(m.body.startsWith('DEMO, not a real emergency.')).toBe(true);
  });

  it('lets several people sign in to a shared demo account at once', async () => {
    const { app } = demoApp();
    await app.services.demo.seed();
    const phone = DEMO_ACCOUNTS[0]!.phone;
    // Four people ask for a code within seconds: no per-number cooldown or 15-minute cap for demo numbers…
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await request(app).post('/api/auth/send-otp').send({ phone }).expect(201)).body);
    // …and a later request doesn't cancel an earlier person's code.
    for (const c of codes) {
      const res = await request(app).post('/api/auth/verify-otp').send({ otpSessionId: c.otpSessionId, code: c.delivery.devCode }).expect(200);
      expect(res.body.user.communityHandle).toBe('Lotus-42');
    }
    // Ordinary numbers keep the normal limits.
    const other = '9811122233';
    await request(app).post('/api/auth/send-otp').send({ phone: other }).expect(201);
    await request(app).post('/api/auth/send-otp').send({ phone: other }).expect(429);
  });

  it('labels nothing as a demo outside demo mode', async () => {
    const { app } = createTestApp({ routingProviders: { places: null, cameras: null } });
    const user = await signIn(app);
    const sos = (await user.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body;
    expect(sos.demo).toBe(false);
  });

  it('keeps demo activity out of the Community Pulse and labels demo reports', async () => {
    const { app, db } = demoApp();
    await app.services.demo.seed();
    const lotus = await signInAs(app, 0);
    const plan = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: { lat: 28.5355, lng: 77.2109 }, destination: { lat: 28.5245, lng: 77.2066 }, mode: 'walk' }).expect(201)).body);
    const trip = tripSchema.parse((await lotus.agent.post('/api/trips').send({ routeId: plan.routes[0]!.id }).expect(201)).body);
    await lotus.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await lotus.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ARRIVED', feedback: 'comfortable' }).expect(200);
    const report = (await lotus.agent.post('/api/community/reports').send({ category: 'poor_lighting', description: 'Demo: dark lane near the gate', lat: 28.5245, lng: 77.2066 }).expect(201)).body;
    expect(report.demo).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM community_pulse_signals').get() as { n: number }).n).toBe(0);
  });

  it('starts a walking companion that a demo traveller can match with', async () => {
    const { app } = demoApp();
    await app.services.demo.seed();
    const companion = await app.services.demo.startCompanion({ from: [77.203, 28.555], to: [77.219, 28.5285] }, 45);
    expect(companion.matches).toBe(0);
    const lotus = await signInAs(app, 0);
    const plan = routePlanSchema.parse((await lotus.agent.post('/api/routes/plan').send({ origin: { lat: 28.5552, lng: 77.2028 }, destination: { lat: 28.5283, lng: 77.2195 }, mode: 'walk' }).expect(201)).body);
    const trip = tripSchema.parse((await lotus.agent.post('/api/trips').send({ routeId: plan.routes[0]!.id }).expect(201)).body);
    const res = (await lotus.agent.post('/api/walk-together/request').send({ tripId: trip.id, windowMinutes: 30 }).expect(200)).body;
    expect(res.matches.map((m: { otherHandle: string }) => m.otherHandle)).toEqual(['Neem-08']);
    // Running it again replaces Neem's previous walk rather than piling up journeys.
    await app.services.demo.startCompanion();
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
