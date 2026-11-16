import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chatSessionSchema, circleSchema, inviteCreatedSchema, receivedSosSchema, sosEventSchema, type SosEvent } from '@mahilasathi/shared';
import { SmsPermanentError, SmsTransientError, type SmsProvider } from '../../server/src/services/sos/smsProvider.js';
import { createTestApp, nextPhone, signIn, testClock, type TestContext } from '../helpers/testApp.js';

const ADMIN = 'test-admin-token-0123456789abcdef-0123456789';
const HERE = { lat: 28.5245, lng: 77.2066, accuracyM: 15 }; // Saket, synthetic test point
const SEC = 1000;
const MIN = 60 * SEC;
const COORDS = /28\.52|77\.20/;

/** Controllable SMS provider: queue outcomes ('ok' | 'transient' | 'permanent' | 'hang'). Defaults to 'ok'. */
function fakeSms(outcomes: ('ok' | 'transient' | 'permanent' | 'hang')[] = []): SmsProvider & { sent: { to: string; body: string }[] } {
  const sent: { to: string; body: string }[] = [];
  return {
    name: 'fake-sms',
    mode: 'live',
    sent,
    async send(to, body) {
      const next = outcomes.shift() ?? 'ok';
      if (next === 'transient') throw new SmsTransientError('carrier timeout');
      if (next === 'permanent') throw new SmsPermanentError('The number was rejected by the carrier');
      if (next === 'hang') return new Promise(() => undefined);
      sent.push({ to, body });
      return { providerMessageId: `sms-${sent.length}` };
    },
  };
}

function setup(opts: { sms?: SmsProvider } = {}) {
  const clock = testClock();
  const ctx = createTestApp({ clock, env: { ADMIN_TOKEN: ADMIN }, ...(opts.sms ? { smsProvider: opts.sms } : {}) });
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

const addContact = (p: Person, name = 'Didi') => p.agent.post('/api/users/me/emergency-contacts').send({ name, phone: nextPhone() }).expect(201);
const activate = (p: Person, body: Record<string, unknown> = {}) => p.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID(), ...body });
const ownView = async (p: Person) => sosEventSchema.parse((await p.agent.get('/api/sos/active').expect(200)).body.sos) as SosEvent;
const contactSms = (e: SosEvent) => e.recipients.find((r) => r.kind === 'emergency_contact')!.deliveries.filter((d) => d.channel === 'sms');

describe('SOS activation and delivery', () => {
  it('creates one durable SOS, alerts the circle, and reports only what was confirmed', async () => {
    const { app, db, clock } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    const kiran = await person(app, 'Kiran');
    const stranger = await person(app, 'Stranger');
    const circle = await circleWith(asha, meera, kiran);
    await addContact(asha);

    const key = crypto.randomUUID();
    const first = sosEventSchema.parse((await asha.agent.post('/api/sos').send({ idempotencyKey: key, location: HERE, note: 'Followed near the market' }).expect(201)).body);
    expect(first).toMatchObject({ status: 'ACTIVE', locationDetail: 'precise', locationSharing: true, escalation: { contactsPolicy: 'if_unacknowledged', stage: 0 } });
    expect(first.location).toMatchObject({ lat: HERE.lat, lng: HERE.lng, source: 'device', areaName: expect.any(String) });
    expect(first.recipients.map((r) => [r.kind, r.name])).toEqual([['guardian', 'Meera'], ['guardian', 'Kiran'], ['emergency_contact', 'Didi']]);
    // Emergency contacts wait for the escalation rule; guardians are alerted in the app at once.
    expect(contactSms(first)).toEqual([]);

    // Idempotent: a retry with the same key, or a second activation while one is active, returns the same SOS.
    expect((await asha.agent.post('/api/sos').send({ idempotencyKey: key }).expect(200)).body.id).toBe(first.id);
    expect((await activate(asha).expect(200)).body.id).toBe(first.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sos_events').get() as { n: number }).n).toBe(1);

    await app.services.sos.dispatchDue();
    let view = await ownView(asha);
    // The circle chat accepted the alert: handed over, NOT confirmed delivered.
    expect(view.circleChat).toEqual([expect.objectContaining({ purpose: 'alert', status: 'accepted', attempts: 1, confirmedAt: null })]);
    // In-app alerts are available but not yet seen by anyone.
    for (const r of view.recipients.filter((x) => x.kind === 'guardian')) expect(r.deliveries).toEqual([expect.objectContaining({ channel: 'in_app', status: 'accepted', confirmedAt: null })]);
    expect(view.summary).toEqual({ recipients: 3, confirmed: 0, acknowledged: 0, unreached: 0 });

    // Meera's app loads the alert: that, and only that, confirms in-app delivery to her.
    const [alert] = (await meera.agent.get('/api/sos/received').expect(200)).body.alerts.map((a: unknown) => receivedSosSchema.parse(a));
    expect(alert).toMatchObject({ id: first.id, travellerName: 'Asha', status: 'ACTIVE', locationLevel: 'precise', note: 'Followed near the market', myResponse: null });
    expect(alert.location).toMatchObject({ lat: HERE.lat, lng: HERE.lng });
    view = await ownView(asha);
    expect(view.recipients.find((r) => r.name === 'Meera')!.deliveries[0]).toMatchObject({ status: 'delivered', confirmedAt: expect.any(String) });
    expect(view.recipients.find((r) => r.name === 'Kiran')!.deliveries[0]!.status).toBe('accepted');
    expect(view.summary.confirmed).toBe(1);

    // The circle chat got a structured MS:SosAlert without any coordinates.
    const msgs = (await kiran.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(200)).body.messages as { messageType: string; content: { text: string; status: string } }[];
    const sosMsgs = msgs.filter((m) => m.messageType === 'MS:SosAlert');
    expect(sosMsgs).toHaveLength(1);
    expect(sosMsgs[0]!.content.text).toContain('SOS from Asha');
    expect(JSON.stringify(msgs)).not.toMatch(COORDS);

    // Only Asha can change it; only her guardians can see or acknowledge it. Others learn nothing.
    for (const p of [stranger]) {
      await p.agent.get(`/api/sos/${first.id}`).expect(404);
      await p.agent.post(`/api/sos/${first.id}/acknowledge`).send({ response: 'seen' }).expect(404);
      expect((await p.agent.get('/api/sos/received').expect(200)).body.alerts).toEqual([]);
    }
    for (const p of [stranger, meera]) {
      await p.agent.post(`/api/sos/${first.id}/cancel`).send({ outcome: 'false_alarm' }).expect(404);
      await p.agent.post(`/api/sos/${first.id}/location`).send({ lat: 28.6, lng: 77.2 }).expect(404);
      await p.agent.put(`/api/sos/${first.id}/location-sharing`).send({ enabled: false }).expect(404);
    }

    // Meera responds; the escalation rule then finds a response and does not message contacts.
    const acked = receivedSosSchema.parse((await meera.agent.post(`/api/sos/${first.id}/acknowledge`).send({ response: 'on_my_way' }).expect(200)).body);
    expect(acked.responses).toEqual([{ name: 'Meera', response: 'on_my_way', at: expect.any(String) }]);
    await app.services.sos.dispatchDue();
    clock.advance(3 * MIN + SEC);
    expect(await app.services.sos.escalateDue()).toEqual({ escalated: 0, notNeeded: 1 });
    view = await ownView(asha);
    expect(view.recipients.find((r) => r.name === 'Meera')!.acknowledgement).toMatchObject({ response: 'on_my_way' });
    expect(contactSms(view)).toEqual([]);
    expect(view.escalation.stage).toBe(1);

    // Ending it: once only, and everyone reached is told.
    const ended = sosEventSchema.parse((await asha.agent.post(`/api/sos/${first.id}/cancel`).send({ outcome: 'safe' }).expect(200)).body);
    expect(ended).toMatchObject({ status: 'RESOLVED', outcome: 'safe', endedAt: expect.any(String) });
    await asha.agent.post(`/api/sos/${first.id}/cancel`).send({ outcome: 'false_alarm' }).expect(409);
    await kiran.agent.post(`/api/sos/${first.id}/acknowledge`).send({ response: 'seen' }).expect(409);
    await app.services.sos.dispatchDue();
    const after = sosEventSchema.parse((await asha.agent.get(`/api/sos/${first.id}`).expect(200)).body.event);
    expect(after.circleChat.map((d) => [d.purpose, d.status])).toEqual(expect.arrayContaining([['alert', 'accepted'], ['update', 'accepted'], ['ended', 'accepted']]));
    const meeraAfter = receivedSosSchema.parse((await meera.agent.get(`/api/sos/${first.id}`).expect(200)).body.event);
    expect(meeraAfter).toMatchObject({ status: 'RESOLVED', outcome: 'safe', location: null });
    expect((await asha.agent.get('/api/sos/active').expect(200)).body.sos).toBeNull();

    // A new SOS can be raised after the first ended.
    expect((await activate(asha).expect(201)).body.id).not.toBe(first.id);

    // The audit trail records each step without coordinates or phone numbers.
    const audit = db.prepare("SELECT action, metadata_json FROM audit_events WHERE action LIKE 'sos.%' ORDER BY rowid").all() as { action: string; metadata_json: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['sos.activated', 'sos.duplicate_activation', 'sos.acknowledged', 'sos.escalation_not_needed', 'sos.ended']));
    expect(JSON.stringify(audit)).not.toMatch(COORDS);
    expect(JSON.stringify(audit)).not.toMatch(/\+91\d{10}/);
  });

  it('escalates to emergency contacts when nobody responds, and reports SMS as unavailable rather than faking it', async () => {
    const { app, clock } = setup(); // SMS_PROVIDER not set: disabled
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    await circleWith(asha, meera);
    await addContact(asha);
    await activate(asha, { location: HERE }).expect(201);
    await app.services.sos.dispatchDue();

    clock.advance(2 * MIN);
    expect(await app.services.sos.escalateDue()).toEqual({ escalated: 0, notNeeded: 0 }); // not yet
    clock.advance(MIN + SEC);
    expect(await app.services.sos.escalateDue()).toEqual({ escalated: 1, notNeeded: 0 });
    expect(await app.services.sos.escalateDue()).toEqual({ escalated: 0, notNeeded: 0 }); // once only
    const view = await ownView(asha);
    expect(contactSms(view)).toEqual([expect.objectContaining({ purpose: 'escalation', status: 'unavailable', attempts: 0, lastError: 'SMS is not set up on this server, so nothing was sent' })]);
    expect(view.circleChat.map((d) => [d.purpose, d.status])).toEqual([['alert', 'accepted'], ['escalation', 'accepted']]);
    expect(view.summary.unreached).toBe(1);
    expect(view.recipients.some((r) => r.deliveries.some((d) => d.status === 'delivered' && d.channel === 'sms'))).toBe(false);
  });

  it('messages contacts at once when there is no circle to respond, and retries transient SMS failures with backoff', async () => {
    const sms = fakeSms(['transient', 'transient', 'ok']);
    const { app, clock } = setup({ sms });
    const asha = await person(app, 'Asha');
    await addContact(asha);
    await activate(asha, { location: HERE }).expect(201);
    await app.services.sos.dispatchDue();

    let d = contactSms(await ownView(asha))[0]!;
    expect(d).toMatchObject({ purpose: 'alert', status: 'pending', attempts: 1, lastError: 'The SMS provider did not accept the message' });
    expect(Date.parse(d.nextAttemptAt!) - clock().getTime()).toBe(10 * SEC);
    await app.services.sos.dispatchDue(); // not due yet
    expect(contactSms(await ownView(asha))[0]!.attempts).toBe(1);

    clock.advance(10 * SEC);
    await app.services.sos.dispatchDue();
    d = contactSms(await ownView(asha))[0]!;
    expect(d).toMatchObject({ status: 'pending', attempts: 2 });
    expect(Date.parse(d.nextAttemptAt!) - clock().getTime()).toBe(30 * SEC);

    clock.advance(30 * SEC);
    await app.services.sos.dispatchDue();
    d = contactSms(await ownView(asha))[0]!;
    // Accepted by the provider. Never "delivered": no handset receipt exists.
    expect(d).toMatchObject({ status: 'accepted', attempts: 3, lastError: null, confirmedAt: null, devAdapter: false });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.body).toContain('mahilaSathi SOS: Asha needs help');
    expect(sms.sent[0]!.body).toContain('openstreetmap.org/?mlat=28.52450');

    // Ending it tells the contact who was reached, saying where the message comes from.
    await asha.agent.post(`/api/sos/${(await ownView(asha)).id}/cancel`).send({ outcome: 'false_alarm' }).expect(200);
    await app.services.sos.dispatchDue();
    expect(sms.sent[1]!.body).toBe('mahilaSathi: Asha ended the SOS: it was a false alarm.');
  });

  it('gives up after five tries and records every attempt', async () => {
    const sms = fakeSms(['transient', 'transient', 'transient', 'transient', 'transient']);
    const { app, db, clock } = setup({ sms });
    const asha = await person(app, 'Asha');
    await addContact(asha, 'First');
    await asha.agent.patch('/api/users/me/sos-settings').send({ emergencyContacts: 'immediately' }).expect(200);
    await activate(asha).expect(201);
    for (const wait of [0, 10, 30, 90, 270]) {
      clock.advance(wait * SEC);
      await app.services.sos.dispatchDue();
    }
    const failed = contactSms(await ownView(asha))[0]!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 5, nextAttemptAt: null, lastError: 'The SMS provider did not accept the message (gave up after 5 tries)' });
    const log = db.prepare('SELECT a.attempt_no, a.outcome FROM sos_delivery_attempts a JOIN sos_deliveries d ON d.id = a.delivery_id WHERE d.channel = ? ORDER BY a.attempt_no').all('sms');
    expect(log).toEqual([1, 2, 3, 4, 5].map((n) => ({ attempt_no: n, outcome: 'retryable_error' })));
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'sos.delivery_failed'").get() as { n: number }).n).toBe(1);
  });

  it('marks a permanent SMS error failed at once, without retrying', async () => {
    const sms = fakeSms(['permanent']);
    const { app } = setup({ sms });
    const asha = await person(app, 'Asha');
    await addContact(asha);
    await asha.agent.patch('/api/users/me/sos-settings').send({ emergencyContacts: 'immediately' }).expect(200);
    await activate(asha).expect(201);
    await app.services.sos.dispatchDue();
    expect(contactSms(await ownView(asha))[0]).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null, lastError: 'The number was rejected by the carrier' });
  });

  it('retries a circle alert through a chat outage', async () => {
    const { app, clock } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    const circle = await circleWith(asha, meera);
    const chat = app.services.chatProvider;
    const original = chat.sendServerMessage.bind(chat);
    let failures = 2;
    chat.sendServerMessage = async (input) => {
      if (failures-- > 0) throw new Error('upstream 503 from internal host');
      return original(input);
    };
    await activate(asha).expect(201);
    await app.services.sos.dispatchDue();
    let alert = (await ownView(asha)).circleChat[0]!;
    expect(alert).toMatchObject({ status: 'pending', attempts: 1, lastError: 'The chat service did not accept the message' });
    expect(JSON.stringify(alert)).not.toContain('503'); // provider internals are not surfaced
    clock.advance(10 * SEC);
    await app.services.sos.dispatchDue();
    expect((await ownView(asha)).circleChat[0]).toMatchObject({ status: 'pending', attempts: 2 });
    clock.advance(30 * SEC);
    await app.services.sos.dispatchDue();
    alert = (await ownView(asha)).circleChat[0]!;
    expect(alert).toMatchObject({ status: 'accepted', attempts: 3, lastError: null });
    const msgs = (await meera.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(200)).body.messages as { messageType: string }[];
    expect(msgs.filter((m) => m.messageType === 'MS:SosAlert')).toHaveLength(1);
  });

  it('recovers deliveries left mid-send by a crash after a restart', async () => {
    const clock = testClock();
    const first = createTestApp({ clock, smsProvider: fakeSms(['hang']) });
    const asha = await person(first.app, 'Asha');
    await addContact(asha);
    await asha.agent.patch('/api/users/me/sos-settings').send({ emergencyContacts: 'immediately' }).expect(200);
    const sos = sosEventSchema.parse((await asha.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body);
    // The worker claimed the SMS and "died" mid-send: the job is left in 'sending' with a lease.
    void first.app.services.sos.dispatchDue();
    await new Promise((r) => setTimeout(r, 20));
    const stuck = first.db.prepare("SELECT status, attempts FROM sos_deliveries WHERE channel = 'sms'").get();
    expect(stuck).toEqual({ status: 'sending', attempts: 1 });

    // "Restart": a new app on the same database with a working provider.
    const sms = fakeSms();
    const second = createTestApp({ clock, db: first.db, smsProvider: sms });
    expect(await second.app.services.sos.dispatchDue()).toEqual({ sent: 0, failed: 0, retried: 0 }); // lease still held
    clock.advance(61 * SEC);
    expect(await second.app.services.sos.dispatchDue()).toEqual({ sent: 1, failed: 0, retried: 0 });
    const row = second.db.prepare("SELECT status, attempts FROM sos_deliveries WHERE channel = 'sms'").get();
    expect(row).toEqual({ status: 'accepted', attempts: 2 });
    expect(sms.sent).toHaveLength(1);
    // The SOS itself survived the restart unchanged.
    expect(second.db.prepare('SELECT status FROM sos_events WHERE id = ?').get(sos.id)).toEqual({ status: 'ACTIVE' });
    // Attempt 1 has no outcome (it never finished); attempt 2 was accepted.
    expect(second.db.prepare('SELECT attempt_no, outcome FROM sos_delivery_attempts ORDER BY attempt_no').all()).toEqual([
      { attempt_no: 1, outcome: null },
      { attempt_no: 2, outcome: 'accepted' },
    ]);
  });
});

describe('SOS location and privacy controls', () => {
  it('shares only the detail the user chose, and stops at once when asked', async () => {
    const { app, db } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    await circleWith(asha, meera);

    await asha.agent.patch('/api/users/me/sos-settings').send({ locationDetail: 'approximate' }).expect(200);
    const s = sosEventSchema.parse((await activate(asha, { location: HERE }).expect(201)).body);
    const alert = receivedSosSchema.parse((await meera.agent.get('/api/sos/received').expect(200)).body.alerts[0]);
    expect(alert.location).toMatchObject({ lat: null, lng: null, accuracyM: null, areaName: expect.any(String) });

    // Live updates are throttled; stopping clears the stored point immediately.
    expect((await asha.agent.post(`/api/sos/${s.id}/location`).send({ lat: 28.525, lng: 77.207 }).expect(200)).body).toEqual({ stored: false });
    const stopped = sosEventSchema.parse((await asha.agent.put(`/api/sos/${s.id}/location-sharing`).send({ enabled: false }).expect(200)).body);
    expect(stopped).toMatchObject({ locationSharing: false, location: null });
    expect(db.prepare('SELECT lat, lng, area_name FROM sos_events WHERE id = ?').get(s.id)).toEqual({ lat: null, lng: null, area_name: null });
    await asha.agent.post(`/api/sos/${s.id}/location`).send({ lat: 28.525, lng: 77.207 }).expect(409);
    expect(receivedSosSchema.parse((await meera.agent.get('/api/sos/received').expect(200)).body.alerts[0]).location).toBeNull();
    await asha.agent.post(`/api/sos/${s.id}/cancel`).send({ outcome: 'false_alarm' }).expect(200);

    // "none": no coordinates are even stored.
    await asha.agent.patch('/api/users/me/sos-settings').send({ locationDetail: 'none' }).expect(200);
    const n = sosEventSchema.parse((await activate(asha, { location: HERE }).expect(201)).body);
    expect(n.location).toBeNull();
    expect(db.prepare('SELECT lat, lng FROM sos_events WHERE id = ?').get(n.id)).toEqual({ lat: null, lng: null });
    await asha.agent.put(`/api/sos/${n.id}/location-sharing`).send({ enabled: true }).expect(400);
  });

  it('has validated, per-user settings', async () => {
    const { app } = setup();
    const asha = await person(app, 'Asha');
    expect((await asha.agent.get('/api/users/me/sos-settings').expect(200)).body).toEqual({ locationDetail: 'precise', emergencyContacts: 'if_unacknowledged', escalateAfterMinutes: 3, shortcut: 'hold' });
    await asha.agent.patch('/api/users/me/sos-settings').send({ escalateAfterMinutes: 0 }).expect(400);
    await asha.agent.patch('/api/users/me/sos-settings').send({ escalateAfterMinutes: 16 }).expect(400);
    await asha.agent.patch('/api/users/me/sos-settings').send({}).expect(400);
    expect((await asha.agent.patch('/api/users/me/sos-settings').send({ escalateAfterMinutes: 5, shortcut: 'countdown' }).expect(200)).body).toMatchObject({ escalateAfterMinutes: 5, shortcut: 'countdown' });
  });

  it('stops all location sharing in one step, exports only the user’s own data, and clears history', async () => {
    const { app, db } = setup();
    const asha = await person(app, 'Asha');
    const meera = await person(app, 'Meera');
    await circleWith(asha, meera);
    const meeraContact = (await meera.agent.post('/api/users/me/emergency-contacts').send({ name: 'Meera Mum', phone: nextPhone() }).expect(201)).body;
    await addContact(asha);
    await activate(asha, { location: HERE }).expect(201);

    expect((await asha.agent.post('/api/users/me/stop-location-sharing').expect(200)).body).toEqual({ journeys: 0, sos: 1 });
    expect((await ownView(asha)).location).toBeNull();

    const res = await asha.agent.get('/api/users/me/export').expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.body;
    expect(data.account.display_name).toBe('Asha');
    expect(data.sos).toHaveLength(1);
    expect(data.emergencyContacts).toHaveLength(1);
    // Nothing of Meera's beyond her display name.
    expect(JSON.stringify(data)).not.toContain(meeraContact.phone);
    expect(JSON.stringify(data)).not.toContain(meera.phone);
    expect(JSON.stringify(data)).toContain('Meera');

    expect((await asha.agent.delete('/api/trips/history').expect(200)).body).toEqual({ deleted: 0 });
    void db;
  });

  it('gives moderators a filtered, token-protected audit log', async () => {
    const { app } = setup();
    const asha = await person(app, 'Asha');
    await activate(asha, { location: HERE }).expect(201);
    await asha.agent.get('/api/moderation/audit').expect(401);
    const res = await asha.agent.get('/api/moderation/audit').query({ action: 'sos.' }).set('x-admin-token', ADMIN).expect(200);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual(['sos.activated']);
    expect(JSON.stringify(res.body)).not.toMatch(COORDS);
    await asha.agent.get('/api/moderation/audit').query({ action: "sos.' OR 1=1 --" }).set('x-admin-token', ADMIN).expect(400);
  });

  it('removes a deleted account’s SOS data', async () => {
    const { app, db } = setup();
    const asha = await person(app, 'Asha');
    await addContact(asha);
    await activate(asha, { location: HERE }).expect(201);
    await asha.agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sos_events').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sos_recipients').get() as { n: number }).n).toBe(0);
  });
});
