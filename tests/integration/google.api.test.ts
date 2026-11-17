import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, meSchema, publicConfigSchema, usageReportSchema } from '@mahilasathi/shared';
import { GoogleTokenError, type GoogleIdentity, type GoogleTokenVerifier } from '../../server/src/services/auth/googleIdToken.js';
import { createTestApp, signIn } from '../helpers/testApp.js';

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const ADMIN = 'google-usage-admin-token-0123456789abcdef';

/** Stands in for Google: each issued "token" maps to an identity; anything else is rejected like a bad signature. */
function fakeGoogle() {
  const issued = new Map<string, GoogleIdentity>();
  let n = 0;
  const verifier: GoogleTokenVerifier = async (credential) => {
    const id = issued.get(credential);
    if (!id) throw new GoogleTokenError('Google sign-in token rejected (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)');
    return id;
  };
  const token = (sub: string, email: string | null = `${sub}@gmail.com`) => {
    const credential = `eyJhbGciOiJSUzI1NiJ9.payload-${sub}-${++n}.signature`;
    issued.set(credential, { sub, email });
    return credential;
  };
  return { verifier, token };
}

function googleApp(env: Record<string, string> = {}) {
  const google = fakeGoogle();
  const ctx = createTestApp({
    env: { GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_TOKEN: ADMIN, ...env },
    googleVerifier: google.verifier,
    routingProviders: { places: null, cameras: null },
  });
  return { ...ctx, google };
}

async function googleSignIn(app: ReturnType<typeof createTestApp>['app'], credential: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/google').send({ credential }).expect(200);
  return { agent, body: res.body as { user: { id: string }; isNewUser: boolean } };
}

describe('Sign in with Google', () => {
  it('creates an account on first sign-in and reuses it after', async () => {
    const { app, db, google } = googleApp();
    const first = await googleSignIn(app, google.token('g-100', 'priya.sharma@gmail.com'));
    expect(first.body.isNewUser).toBe(true);
    const me = meSchema.parse((await first.agent.get('/api/auth/me').expect(200)).body);
    expect(me).toMatchObject({ signInMethod: 'google', maskedEmail: 'p•••@gmail.com', maskedPhone: '', isDemo: false, onboardingCompleted: false });

    const again = await googleSignIn(app, google.token('g-100', 'priya.new@gmail.com'));
    expect(again.body).toMatchObject({ isNewUser: false, user: { id: first.body.user.id } });
    // The email is kept current with the Google account.
    expect(db.prepare('SELECT email, phone_e164 FROM users WHERE id = ?').get(first.body.user.id)).toEqual({ email: 'priya.new@gmail.com', phone_e164: null });

    const logins = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'auth.login' AND actor_id = ?").all(first.body.user.id) as { metadata_json: string }[];
    expect(logins.map((l) => JSON.parse(l.metadata_json).method)).toEqual(['google', 'google']);
  });

  it('rejects tokens Google did not issue for this app', async () => {
    const { app } = googleApp();
    const res = await request(app).post('/api/auth/google').send({ credential: 'eyJhbGciOiJSUzI1NiJ9.forged-payload.signature' }).expect(401);
    expect(res.body.error.message).toBe('Google sign-in failed. Please try again.');
    expect(res.headers['set-cookie']).toBeUndefined();
    await request(app).post('/api/auth/google').send({ credential: 'not a token' }).expect(400);
    await request(app).post('/api/auth/google').send({}).expect(400);
  });

  it('is off unless GOOGLE_CLIENT_ID is set', async () => {
    const { app } = createTestApp();
    await request(app).post('/api/auth/google').send({ credential: 'eyJhbGciOiJSUzI1NiJ9.payload-x.signature' }).expect(404);
    const config = publicConfigSchema.parse((await request(app).get('/api/config').expect(200)).body);
    expect(config.auth).toEqual({ googleClientId: null, phoneSignIn: 'open' });
    expect(config.dataStorage).toBe('local');
    const backedUp = createTestApp({ env: { DATA_REPLICATION: 'litestream' } }).app;
    expect(publicConfigSchema.parse((await request(backedUp).get('/api/config').expect(200)).body).dataStorage).toBe('replicated');
  });

  it('limits development phone sign-in to the demo accounts once Google is on', async () => {
    const { app } = googleApp({ DEMO_MODE: 'true' });
    await app.services.demo.seed();
    const config = publicConfigSchema.parse((await request(app).get('/api/config').expect(200)).body);
    expect(config.auth).toEqual({ googleClientId: CLIENT_ID, phoneSignIn: 'demo_accounts_only' });

    const res = await request(app).post('/api/auth/send-otp').send({ phone: '9811122233' }).expect(403);
    expect(res.body.error.message).toMatch(/Continue with Google/);
    const demo = await signIn(app, DEMO_ACCOUNTS[0]!.phone);
    expect(demo.user.communityHandle).toBe('Lotus-42');
  });

  it('treats Google users as real people on a demo server', async () => {
    const { app, google } = googleApp({ DEMO_MODE: 'true', SMS_PROVIDER: 'mock' });
    await app.services.demo.seed();
    const real = await googleSignIn(app, google.token('g-200'));
    const sos = (await real.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body;
    expect(sos.demo).toBe(false);
    const lotus = await signIn(app, DEMO_ACCOUNTS[0]!.phone);
    expect((await lotus.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201)).body.demo).toBe(true);
  });

  it('includes the email in the data export and forgets the Google account on deletion', async () => {
    const { app, db, google } = googleApp();
    const user = await googleSignIn(app, google.token('g-300', 'asha@example.org'));
    const exported = (await user.agent.get('/api/users/me/export').expect(200)).body;
    expect(JSON.stringify(exported)).toContain('asha@example.org');
    expect(JSON.stringify(exported)).toContain('"google"');

    await user.agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    expect(db.prepare('SELECT google_sub, email, status FROM users WHERE id = ?').get(user.body.user.id)).toEqual({ google_sub: null, email: null, status: 'deleted' });
    // The same Google account can start afresh.
    const again = await googleSignIn(app, google.token('g-300', 'asha@example.org'));
    expect(again.body.isNewUser).toBe(true);
    expect(again.body.user.id).not.toBe(user.body.user.id);
  });

  it('lets Google sign-in through the CSP and its popup through COOP', async () => {
    const { app } = googleApp();
    const res = await request(app).get('/api/health').expect(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/script-src [^;]*https:\/\/accounts\.google\.com\/gsi\/client/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/accounts\.google\.com\/gsi\//);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');

    const off = await request(createTestApp().app).get('/api/health').expect(200);
    expect(off.headers['content-security-policy']).not.toMatch(/script-src [^;]*accounts\.google\.com/);
    expect(off.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});

describe('usage report', () => {
  it('is for moderators only and counts real people, never the demo accounts', async () => {
    const { app, google } = googleApp({ DEMO_MODE: 'true' });
    await request(app).get('/api/moderation/usage').expect(401);

    await app.services.demo.seed();
    const lotus = await signIn(app, DEMO_ACCOUNTS[0]!.phone);
    await lotus.agent.post('/api/sos').send({ idempotencyKey: crypto.randomUUID() }).expect(201);
    await googleSignIn(app, google.token('g-400'));
    await googleSignIn(app, google.token('g-401'));

    const res = await request(app).get('/api/moderation/usage').set('X-Admin-Token', ADMIN).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = usageReportSchema.parse(res.body);
    expect(r.accounts).toEqual({ total: 2, google: 2, phone: 0, deleted: 0 });
    expect(r.signUpsByDay.reduce((sum, d) => sum + d.count, 0)).toBe(2);
    expect(r.activeUsers.last24h).toBe(2);
    expect(r.sosRaised).toBe(0);
    // Counts only: nothing that identifies anyone.
    expect(JSON.stringify(r)).not.toMatch(/@|g-40|Lotus/);
  });
});
