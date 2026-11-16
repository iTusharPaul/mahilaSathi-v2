import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CONTACT_INFO_MESSAGE, chatSessionSchema, circleSchema, containsContactInfo, coverageSchema, inviteCreatedSchema, isAllowedPushEndpoint, pushConfigSchema } from '@mahilasathi/shared';
import { COVERAGE_RULES, coverageLevel } from '../../server/src/services/geography/coverageService.js';
import type { PushSender } from '../../server/src/services/push/pushService.js';
import { PushGoneError } from '../../server/src/services/push/pushService.js';
import type { PlacesProvider } from '../../server/src/services/routing/providers.js';
import type { PlaceRecord } from '../../server/src/services/scoring/types.js';
import { createTestApp, nextPhone, signIn, type TestContext } from '../helpers/testApp.js';

const ADMIN = 'local-features-admin-token-0123456789abcdef';
const COORDS = /28\.5\d{2}|77\.2\d{2}/;

function fakePush(fail: 'none' | 'gone' = 'none'): PushSender & { sent: { endpoint: string; payload: { title: string; body: string; url: string; urgent: boolean }; urgency: string }[] } {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string; urgent: boolean }; urgency: string }[] = [];
  return {
    sent,
    async send(target, payload, options) {
      if (fail === 'gone') throw new PushGoneError('gone');
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), urgency: options.urgency });
      return { statusCode: 201 };
    },
  };
}
const sub = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

async function person(app: TestContext['app'], name: string) {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: name, homeNeighbourhoodId: 'delhi-saket' }).expect(200);
  const { chatUserId } = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  return { ...s, publicId: chatUserId };
}

describe('push notifications (Web Push)', () => {
  it('is reported as off when the server has no VAPID keys', async () => {
    const { app } = createTestApp();
    const u = await signIn(app);
    expect(pushConfigSchema.parse((await u.agent.get('/api/push/config').expect(200)).body)).toEqual({ enabled: false, publicKey: null, subscriptions: 0 });
    await u.agent.post('/api/push/subscriptions').send(sub()).expect(404);
  });

  it('only accepts real push-service endpoints (no SSRF), and lets people unsubscribe', async () => {
    const push = fakePush();
    const { app } = createTestApp({ pushSender: push });
    const u = await signIn(app);
    for (const endpoint of ['http://127.0.0.1:8080/api/admin', 'https://evil.example.com/push', 'https://fcm.googleapis.com.evil.com/x', 'file:///etc/passwd']) {
      await u.agent.post('/api/push/subscriptions').send({ ...sub(), endpoint }).expect(400);
    }
    const s = sub();
    expect((await u.agent.post('/api/push/subscriptions').send(s).expect(201)).body.subscriptions).toBe(1);
    expect((await u.agent.post('/api/push/test').expect(200)).body).toMatchObject({ sent: 1 });
    expect(push.sent[0]!.endpoint).toBe(s.endpoint);
    expect((await u.agent.delete('/api/push/subscriptions').send({ endpoint: s.endpoint }).expect(200)).body.subscriptions).toBe(0);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('notifies guardians of an SOS and journey updates, honours preferences, and drops dead subscriptions', async () => {
    const push = fakePush();
    const { app, db } = createTestApp({ pushSender: push });
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    const kiran = await person(app, 'Kiran');
    const circle = circleSchema.parse((await asha.agent.post('/api/circles').send({ name: 'Family' }).expect(201)).body);
    for (const g of [meera, kiran]) {
      const { code } = inviteCreatedSchema.parse((await asha.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body);
      await g.agent.post('/api/circles/accept').send({ code }).expect(200);
    }
    const meeraSub = sub();
    await meera.agent.post('/api/push/subscriptions').send(meeraSub).expect(201);
    await kiran.agent.post('/api/push/subscriptions').send(sub()).expect(201);
    // Kiran turned SOS notifications off.
    await kiran.agent.patch('/api/users/me/preferences').send({ notifySos: false }).expect(200);

    const sos = (await asha.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID(), location: { lat: 28.5245, lng: 77.2066 } }).expect(201)).body;
    await new Promise((r) => setTimeout(r, 20));
    const sosPushes = push.sent.filter((p) => p.payload.url === `/sos/alerts/${sos.id}`);
    expect(sosPushes.map((p) => p.endpoint)).toEqual([meeraSub.endpoint]);
    expect(sosPushes[0]).toMatchObject({ urgency: 'high', payload: { title: 'SOS from Asha', urgent: true } });
    // No coordinates ever go into a notification.
    expect(JSON.stringify(push.sent)).not.toMatch(COORDS);

    // Journey updates go to guardians who want them (Kiran turned SOS off, not journeys).
    const plan = (await asha.agent.post('/api/routes/plan').send({ origin: { lat: 28.5355, lng: 77.2109 }, destination: { lat: 28.5245, lng: 77.2066 }, mode: 'walk' }).expect(201)).body;
    const trip = (await asha.agent.post('/api/trips').send({ routeId: plan.routes[0].id, shareLevel: 'status' }).expect(201)).body;
    await asha.agent.patch(`/api/trips/${trip.id}/status`).send({ status: 'ACTIVE' }).expect(200);
    await new Promise((r) => setTimeout(r, 20));
    const journeyPushes = push.sent.filter((p) => p.payload.title === 'Journey update');
    expect(new Set(journeyPushes.map((p) => p.endpoint)).size).toBe(2);
    expect(journeyPushes.some((p) => p.payload.body.includes('Asha started a journey'))).toBe(true);
    expect(journeyPushes.every((p) => p.payload.url.startsWith('/journeys/shared/'))).toBe(true);
    expect(JSON.stringify(push.sent)).not.toMatch(COORDS);

    // A subscription the push service reports gone (410) is removed.
    const gone = fakePush('gone');
    const app2 = createTestApp({ pushSender: gone });
    const u = await signIn(app2.app);
    await u.agent.post('/api/push/subscriptions').send(sub()).expect(201);
    expect((await u.agent.post('/api/push/test').expect(200)).body).toMatchObject({ removed: 1 });
    expect((app2.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n).toBe(0);

    // Account deletion removes subscriptions.
    await meera.agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(meeraSub.endpoint) as { n: number }).n).toBe(0);
  });
});

describe('data coverage from live place data', () => {
  it('assesses a neighbourhood with published thresholds and serves it through the coverage endpoint', async () => {
    // A fake place provider: 300 shops around Saket, 20% with opening hours, plus 4 metro/bus stops.
    const places: PlaceRecord[] = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      name: `Shop ${i}`,
      kind: 'shop',
      lat: 28.5245 + ((i % 20) - 10) * 0.0006,
      lng: 77.2066 + (Math.floor(i / 20) - 7) * 0.0006,
      openingHours: i % 5 === 0 ? 'Mo-Su 09:00-22:00' : null,
    }));
    const transit: PlaceRecord[] = [0, 1, 2, 3].map((i) => ({ id: `t${i}`, name: `Stop ${i}`, kind: 'bus', lat: 28.5245 + i * 0.001, lng: 77.2066, openingHours: null }));
    const provider: PlacesProvider = {
      name: 'fake-places',
      async fetchCell(b, layer) {
        const pool = layer === 'transit' ? transit : places;
        return { places: pool.filter((p) => p.lat >= b.minLat && p.lat < b.maxLat && p.lng >= b.minLng && p.lng < b.maxLng), truncated: false };
      },
    };
    const { app, db } = createTestApp({ routingProviders: { places: provider, cameras: null } });
    const u = await signIn(app);
    const before = coverageSchema.parse((await u.agent.get('/api/geo/coverage').query({ areaType: 'neighbourhood', areaId: 'delhi-saket' }).expect(200)).body.coverage);
    expect(before.level).toBe('unknown');
    // The first view started a background assessment.
    await new Promise((r) => setTimeout(r, 50));
    const after = coverageSchema.parse((await u.agent.get('/api/geo/coverage').query({ areaType: 'neighbourhood', areaId: 'delhi-saket' }).expect(200)).body.coverage);
    expect(after).toMatchObject({ level: 'high', source: 'OpenStreetMap via Geoapify', assessedAt: expect.any(String) });
    expect(after.summary).toMatch(/300 shops, cafés and other places mapped within 1\.5 km \(42 per km²\), 20% with opening hours, 4 transit stops\. This describes how complete the map data is, not how safe the area is\./);
    const row = db.prepare("SELECT basis_json FROM coverage_assessments WHERE area_id = 'delhi-saket'").get() as { basis_json: string };
    expect(JSON.parse(row.basis_json)).toMatchObject({ establishments: 300, withHours: 60, transitStops: 4 });
  });

  it('applies the published thresholds', () => {
    expect(coverageLevel(COVERAGE_RULES.high.establishmentsPerKm2, COVERAGE_RULES.high.hoursShare)).toBe('high');
    expect(coverageLevel(100, 0.1)).toBe('medium');
    expect(coverageLevel(100, 0.05)).toBe('low');
    expect(coverageLevel(10, 0.5)).toBe('low');
  });

  it('does not assess without a place provider', async () => {
    const { app } = createTestApp({ routingProviders: { places: null, cameras: null } });
    expect(await app.services.coverage.assessNeighbourhood('delhi-saket')).toBeNull();
  });
});

describe('development SMS outbox for moderators', () => {
  it('shows what the dev adapter recorded, to moderators only', async () => {
    const ctx = createTestApp({ env: { ADMIN_TOKEN: ADMIN } });
    // Without the dev adapter the outbox is not available.
    await request(ctx.app).get('/api/moderation/dev-sms').set('X-Admin-Token', ADMIN).expect(404);

    const app = createTestApp({ env: { ADMIN_TOKEN: ADMIN, SMS_PROVIDER: 'mock' } }).app;
    const asha = await signIn(app);
    await asha.agent.patch('/api/users/me').send({ displayName: 'Asha' }).expect(200);
    await asha.agent.post('/api/users/me/emergency-contacts').send({ name: 'Didi', phone: nextPhone() }).expect(201);
    await asha.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201); // no circle: contacts messaged at once
    await new Promise((r) => setTimeout(r, 30));
    await request(app).get('/api/moderation/dev-sms').expect(401);
    const out = (await request(app).get('/api/moderation/dev-sms').set('X-Admin-Token', ADMIN).expect(200)).body.messages;
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('mahilaSathi SOS: Asha needs help');
  });
});

describe('contact-info rule shared by client and server', () => {
  it('detects phone numbers, emails, coordinates and map links', () => {
    for (const t of ['call 98765 43210', '+91 9876543210', 'mail me a@b.co', 'I am at 28.52451, 77.20661', 'https://maps.app.goo.gl/x']) expect(containsContactInfo(t)).toBe(true);
    for (const t of ['Meet at the metro gate at 10', 'Lights out on lane 4', 'Sector 62, Noida']) expect(containsContactInfo(t)).toBe(false);
    expect(CONTACT_INFO_MESSAGE).toMatch(/Guardian Circle/);
  });
});
