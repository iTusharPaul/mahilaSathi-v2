import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { authResultSchema, meSchema, sendOtpResponseSchema } from '@mahilasathi/shared';
import { OTP_POLICY } from '../../server/src/services/auth/authService.js';
import type { OtpProvider } from '../../server/src/services/auth/otpProvider.js';
import { createTestApp, nextPhone, signIn, testClock } from '../helpers/testApp.js';

const send = (app: Parameters<typeof request>[0], phone: string) => request(app).post('/api/auth/send-otp').send({ phone });

describe('OTP sign-in', () => {
  it('rejects invalid phone numbers', async () => {
    const { app } = createTestApp();
    const res = await send(app, '12345').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('signs in through send → verify, sets a secure session cookie and creates a pseudonymous user', async () => {
    const { app } = createTestApp();
    const phone = nextPhone();
    const sent = sendOtpResponseSchema.parse((await send(app, `+91 ${phone}`).expect(201)).body);
    expect(sent.delivery).toMatchObject({ provider: 'mock', mode: 'dev-adapter' });
    expect(sent.delivery.devCode).toMatch(/^\d{6}$/);
    expect(sent.maskedPhone).toBe(`+91 ••••• •${phone.slice(-4)}`);

    const res = await request(app)
      .post('/api/auth/verify-otp')
      .send({ otpSessionId: sent.otpSessionId, code: sent.delivery.devCode })
      .expect(200);
    const body = authResultSchema.parse(res.body);
    expect(body.isNewUser).toBe(true);
    expect(body.user.communityHandle).toMatch(/^[A-Za-z]+-\d{2,4}$/);
    expect(body.user.onboardingCompleted).toBe(false);
    expect(JSON.stringify(body)).not.toContain(phone);

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ms_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]!).expect(200);
    expect(meSchema.parse(me.body).id).toBe(body.user.id);
  });

  it('enforces resend cooldown and a per-number send limit', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const phone = nextPhone();
    await send(app, phone).expect(201);
    const tooSoon = await send(app, phone).expect(429);
    expect(tooSoon.body.error.message).toMatch(/wait \d+ seconds/);

    clock.advance(OTP_POLICY.resendCooldownMs);
    await send(app, phone).expect(201);
    clock.advance(OTP_POLICY.resendCooldownMs);
    await send(app, phone).expect(201);
    clock.advance(OTP_POLICY.resendCooldownMs);
    const limited = await send(app, phone).expect(429);
    expect(limited.body.error.message).toMatch(/Too many codes/);

    clock.advance(OTP_POLICY.windowMs);
    await send(app, phone).expect(201);
  });

  it('signs a returning user into the same account', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const first = await signIn(app);
    clock.advance(OTP_POLICY.resendCooldownMs);
    const second = await signIn(app, first.phone);
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it('counts down attempts and locks the code after too many wrong guesses', async () => {
    const { app } = createTestApp();
    const sent = (await send(app, nextPhone()).expect(201)).body;
    const wrong = sent.delivery.devCode === '000000' ? '111111' : '000000';
    for (let i = OTP_POLICY.maxAttempts - 1; i >= 1; i--) {
      const res = await request(app).post('/api/auth/verify-otp').send({ otpSessionId: sent.otpSessionId, code: wrong }).expect(400);
      expect(res.body.error.message).toContain(`${i} attempt`);
    }
    await request(app).post('/api/auth/verify-otp').send({ otpSessionId: sent.otpSessionId, code: wrong }).expect(400);
    // Even the right code is refused once locked.
    const locked = await request(app)
      .post('/api/auth/verify-otp')
      .send({ otpSessionId: sent.otpSessionId, code: sent.delivery.devCode })
      .expect(400);
    expect(locked.body.error.message).toMatch(/Too many incorrect attempts/);
  });

  it('rejects expired, reused and superseded codes', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });

    const expired = (await send(app, nextPhone()).expect(201)).body;
    clock.advance(OTP_POLICY.ttlMs + 1);
    const res = await request(app).post('/api/auth/verify-otp').send({ otpSessionId: expired.otpSessionId, code: expired.delivery.devCode }).expect(400);
    expect(res.body.error.message).toMatch(/expired/);

    const phone = nextPhone();
    const used = (await send(app, phone).expect(201)).body;
    await request(app).post('/api/auth/verify-otp').send({ otpSessionId: used.otpSessionId, code: used.delivery.devCode }).expect(200);
    await request(app).post('/api/auth/verify-otp').send({ otpSessionId: used.otpSessionId, code: used.delivery.devCode }).expect(400);

    const phone2 = nextPhone();
    const old = (await send(app, phone2).expect(201)).body;
    clock.advance(OTP_POLICY.resendCooldownMs);
    await send(app, phone2).expect(201);
    await request(app).post('/api/auth/verify-otp').send({ otpSessionId: old.otpSessionId, code: old.delivery.devCode }).expect(400);
  });

  it('stores only hashes of OTP codes and session tokens', async () => {
    const { app, db } = createTestApp();
    const sent = (await send(app, nextPhone()).expect(201)).body;
    const res = await request(app)
      .post('/api/auth/verify-otp')
      .send({ otpSessionId: sent.otpSessionId, code: sent.delivery.devCode })
      .expect(200);
    const token = /ms_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;

    const otpRows = JSON.stringify(db.prepare('SELECT * FROM otp_sessions').all());
    const sessionRows = JSON.stringify(db.prepare('SELECT * FROM user_sessions').all());
    expect(otpRows).not.toContain(`"${sent.delivery.devCode}"`);
    expect(otpRows).toMatch(/"code_hash":"[0-9a-f]{64}"/);
    expect(sessionRows).not.toContain(token);
    expect(sessionRows).toMatch(/"token_hash":"[0-9a-f]{64}"/);
  });

  it('never returns a dev code from a live provider', async () => {
    const live: OtpProvider = { name: 'test-sms', mode: 'live', send: async () => ({ devCode: '123456' }) };
    const { app } = createTestApp({ otpProvider: live });
    const res = await send(app, nextPhone()).expect(201);
    expect(res.body.delivery).toEqual({ provider: 'test-sms', mode: 'live' });
  });

  it('reports provider failure honestly and does not leave a usable code behind', async () => {
    const failing: OtpProvider = { name: 'test-sms', mode: 'live', send: async () => { throw new Error('SMS gateway down'); } };
    const { app, db } = createTestApp({ otpProvider: failing });
    const res = await send(app, nextPhone()).expect(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(res.body.error.message).not.toContain('gateway');
    expect((db.prepare('SELECT invalidated_at FROM otp_sessions').get() as { invalidated_at: string | null }).invalidated_at).not.toBeNull();
  });
});

describe('sessions', () => {
  it('requires a session for protected routes', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/users/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await request(app).get('/api/auth/me').set('Cookie', 'ms_session=forged-token').expect(401);
  });

  it('logout revokes the session server-side', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    await agent.get('/api/auth/me').expect(200);
    const res = await agent.post('/api/auth/logout').expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/ms_session=;/);
    await agent.get('/api/auth/me').expect(401);
  });

  it('expires sessions after their lifetime', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const { agent } = await signIn(app);
    clock.advance(31 * 24 * 60 * 60_000);
    await agent.get('/api/auth/me').expect(401);
  });

  it('blocks cross-site state-changing requests', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    const res = await agent.patch('/api/users/me').set('Origin', 'https://evil.example').send({ displayName: 'Hacked' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await agent.patch('/api/users/me').send({ displayName: 'Asha' }).expect(200);
  });

  it('purges expired OTP records and old sessions', async () => {
    const clock = testClock();
    const { app, db } = createTestApp({ clock });
    await signIn(app);
    clock.advance(40 * 24 * 60 * 60_000);
    const purged = app.services.auth.purgeExpired();
    expect(purged).toEqual({ otp: 1, sessions: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM otp_sessions').get() as { n: number }).n).toBe(0);
  });
});
