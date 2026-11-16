import { describe, expect, it } from 'vitest';
import { MAX_EMERGENCY_CONTACTS, meSchema, preferencesSchema } from '@mahilasathi/shared';
import { OTP_POLICY } from '../../server/src/services/auth/authService.js';
import { createTestApp, nextPhone, signIn, testClock } from '../helpers/testApp.js';

describe('profile', () => {
  it('validates and saves a privacy-conscious display name', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    const bad = await agent.patch('/api/users/me').send({ displayName: '<script>' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    await agent.patch('/api/users/me').send({ displayName: 'x' }).expect(400);
    await agent.patch('/api/users/me').send({ unknownField: true }).expect(400);
    const ok = await agent.patch('/api/users/me').send({ displayName: 'Asha K.' }).expect(200);
    expect(meSchema.parse(ok.body).displayName).toBe('Asha K.');
  });

  it('sets the home area by neighbourhood or by district, and rejects unknown areas', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);

    const byNeighbourhood = await agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'gurugram-cyber-city' }).expect(200);
    expect(byNeighbourhood.body.homeArea).toEqual({
      state: { id: 'haryana', name: 'Haryana' },
      district: { id: 'hr-gurugram', name: 'Gurugram' },
      city: { id: 'gurugram', name: 'Gurugram' },
      neighbourhood: { id: 'gurugram-cyber-city', name: 'Cyber City' },
    });

    const byDistrict = await agent.patch('/api/users/me').send({ homeDistrictId: 'hr-jind' }).expect(200);
    expect(byDistrict.body.homeArea).toMatchObject({ district: { id: 'hr-jind' }, neighbourhood: null });

    await agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'bengaluru-koramangala' }).expect(400);
    await agent.patch('/api/users/me').send({ homeDistrictId: 'ka-bengaluru-urban' }).expect(400);

    const cleared = await agent.patch('/api/users/me').send({ homeNeighbourhoodId: null }).expect(200);
    expect(cleared.body.homeArea).toBeNull();
  });

  it('only completes onboarding once a display name exists', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    await agent.patch('/api/users/me').send({ onboardingCompleted: true }).expect(400);
    const done = await agent.patch('/api/users/me').send({ displayName: 'Meera', onboardingCompleted: true }).expect(200);
    expect(done.body.onboardingCompleted).toBe(true);
  });

  it('stores only area identifiers for the home area, never coordinates', async () => {
    const { app, db } = createTestApp();
    const { agent, user } = await signIn(app);
    await agent.patch('/api/users/me').send({ homeNeighbourhoodId: 'delhi-saket' }).expect(200);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Record<string, unknown>;
    expect(Object.keys(row).some((k) => /lat|lng|lon|coord/.test(k))).toBe(false);
    expect(row.home_neighbourhood_id).toBe('delhi-saket');
  });
});

describe('preferences', () => {
  it('defaults to location sharing off and saves changes', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    const initial = preferencesSchema.parse((await agent.get('/api/users/me/preferences').expect(200)).body);
    expect(initial.locationSharingDefault).toBe('off');
    const updated = await agent.patch('/api/users/me/preferences').send({ locationSharingDefault: 'guardians_approximate', notifyCommunity: true }).expect(200);
    expect(updated.body).toMatchObject({ locationSharingDefault: 'guardians_approximate', notifyCommunity: true, notifySos: true });
    await agent.patch('/api/users/me/preferences').send({ locationSharingDefault: 'everyone' }).expect(400);
  });
});

describe('emergency contacts', () => {
  it('adds, lists, updates and removes contacts with validation', async () => {
    const { app } = createTestApp();
    const { agent, phone } = await signIn(app);

    const contactPhone = nextPhone();
    const created = await agent.post('/api/users/me/emergency-contacts').send({ name: 'Didi', phone: contactPhone, relationship: 'Sister' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Didi', phone: `+91${contactPhone}`, relationship: 'Sister', priority: 0 });

    await agent.post('/api/users/me/emergency-contacts').send({ name: 'Again', phone: contactPhone }).expect(409);
    const self = await agent.post('/api/users/me/emergency-contacts').send({ name: 'Me', phone }).expect(400);
    expect(self.body.error.message).toMatch(/someone else/);
    await agent.post('/api/users/me/emergency-contacts').send({ name: '', phone: nextPhone() }).expect(400);

    const patched = await agent.patch(`/api/users/me/emergency-contacts/${created.body.id}`).send({ relationship: null }).expect(200);
    expect(patched.body.relationship).toBeNull();

    expect((await agent.get('/api/users/me/emergency-contacts').expect(200)).body.contacts).toHaveLength(1);
    await agent.delete(`/api/users/me/emergency-contacts/${created.body.id}`).expect(204);
    expect((await agent.get('/api/users/me/emergency-contacts').expect(200)).body.contacts).toHaveLength(0);
  });

  it(`limits contacts to ${MAX_EMERGENCY_CONTACTS}`, async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    for (let i = 0; i < MAX_EMERGENCY_CONTACTS; i++) {
      await agent.post('/api/users/me/emergency-contacts').send({ name: `C${i}`, phone: nextPhone() }).expect(201);
    }
    await agent.post('/api/users/me/emergency-contacts').send({ name: 'One too many', phone: nextPhone() }).expect(409);
  });

  it("never lets one user see or change another user's contacts", async () => {
    const { app } = createTestApp();
    const a = await signIn(app);
    const b = await signIn(app);
    const contact = (await a.agent.post('/api/users/me/emergency-contacts').send({ name: 'Maa', phone: nextPhone() }).expect(201)).body;

    expect((await b.agent.get('/api/users/me/emergency-contacts').expect(200)).body.contacts).toEqual([]);
    await b.agent.patch(`/api/users/me/emergency-contacts/${contact.id}`).send({ name: 'Taken over' }).expect(404);
    await b.agent.delete(`/api/users/me/emergency-contacts/${contact.id}`).expect(404);
    expect((await a.agent.get('/api/users/me/emergency-contacts').expect(200)).body.contacts[0].name).toBe('Maa');
  });
});

describe('account deletion', () => {
  it('requires explicit confirmation, removes personal data and ends the session', async () => {
    const clock = testClock();
    const { app, db } = createTestApp({ clock });
    const { agent, phone, user } = await signIn(app);
    await agent.patch('/api/users/me').send({ displayName: 'Riya', homeNeighbourhoodId: 'delhi-dwarka' }).expect(200);
    await agent.post('/api/users/me/emergency-contacts').send({ name: 'Papa', phone: nextPhone() }).expect(201);

    await agent.delete('/api/users/me').send({}).expect(400);
    await agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    await agent.get('/api/users/me').expect(401);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'deleted', phone_e164: null, display_name: null, home_neighbourhood_id: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM emergency_contacts WHERE user_id = ?').get(user.id) as { n: number }).n).toBe(0);

    // The same number can register again as a brand-new account.
    clock.advance(OTP_POLICY.resendCooldownMs);
    const again = await signIn(app, phone);
    expect(again.isNewUser).toBe(true);
    expect(again.user.id).not.toBe(user.id);
  });
});
