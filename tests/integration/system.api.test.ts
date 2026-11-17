import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema, publicConfigSchema, readyResponseSchema } from '@mahilasathi/shared';
import { MIGRATIONS_DIR, loadConfig } from '../../server/src/config/index.js';
import { createTestApp, makeTempDir } from '../helpers/testApp.js';

function fakeClientDist(): string {
  const dir = makeTempDir('ms-client-');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>mahilaSathi</title><div id="root"></div>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

describe('system endpoints', () => {
  it('GET /api/health reports liveness', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(healthResponseSchema.parse(res.body).status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('GET /api/ready is ready once migrations are applied', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/ready').expect(200);
    const body = readyResponseSchema.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.checks.migrations.pending).toBe(0);
    expect(body.checks.migrations.applied).toBeGreaterThan(0);
  });

  it('GET /api/ready returns 503 when a migration is added but not yet applied', async () => {
    const migrationsDir = makeTempDir('ms-migrations-');
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(migrationsDir, f));
    const { app } = createTestApp({ migrationsDir });
    await request(app).get('/api/ready').expect(200);
    fs.writeFileSync(path.join(migrationsDir, '9999_pending.sql'), 'CREATE TABLE later (id INTEGER);');
    const res = await request(app).get('/api/ready').expect(503);
    const body = readyResponseSchema.parse(res.body);
    expect(body.status).toBe('not_ready');
    expect(body.checks.migrations.detail).toMatch(/db:migrate/);
  });

  it('GET /api/ready returns 503 when the database is unavailable', async () => {
    const { app, db } = createTestApp();
    db.close();
    const res = await request(app).get('/api/ready').expect(503);
    expect(res.body.checks.database.ok).toBe(false);
  });

  it('GET /api/config exposes provider modes but never key values', async () => {
    const secrets = {
      GEOAPIFY_API_KEY: 'geo-key-should-not-leak-123',
      NEXCONN_APP_KEY: 'nexconn-key-should-not-leak',
      NEXCONN_APP_SECRET: 'nexconn-secret-should-not-leak',
      JWT_SECRET: 'jwt-secret-should-not-leak-0123456789abcdef',
      ADMIN_TOKEN: 'admin-token-should-not-leak-0123456789abcd',
    };
    const { app } = createTestApp({ env: { ...secrets, DEMO_MODE: 'true' } });
    const res = await request(app).get('/api/config').expect(200);
    const body = publicConfigSchema.parse(res.body);
    expect(body.demoMode).toBe(true);
    expect(body.providers.geoapify).toEqual({ configured: true, mode: 'live' });
    expect(body.providers.nexconn).toEqual({ configured: true, mode: 'live' });
    expect(body.providers.otp.mode).toBe('dev-adapter');
    for (const value of Object.values(secrets)) expect(res.text).not.toContain(value);
  });

  it('labels missing providers as development adapters, not live', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.providers.geoapify).toEqual({ configured: false, mode: 'dev-adapter' });
    expect(res.body.providers.push).toEqual({ configured: false, mode: 'disabled' });
  });
});

describe('error handling', () => {
  it('returns the ApiError envelope for unknown API routes', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/does-not-exist').expect(404);
    const body = apiErrorSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects oversized bodies with 413', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }))
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('reuses a well-formed upstream request id and replaces a malformed one', async () => {
    const { app } = createTestApp();
    const good = await request(app).get('/api/health').set('X-Request-Id', 'edge-req-12345678');
    expect(good.headers['x-request-id']).toBe('edge-req-12345678');
    const bad = await request(app).get('/api/health').set('X-Request-Id', '<script>alert(1)</script>');
    expect(bad.headers['x-request-id']).not.toContain('<');
  });
});

describe('security headers and CORS', () => {
  it('sets hardening headers and hides the framework', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
  });

  it('only allows configured origins', async () => {
    const { app } = createTestApp({ env: { CORS_ORIGINS: 'http://localhost:5173' } });
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('single deployable', () => {
  it('serves the built client, its assets and SPA deep links from the same server as the API', async () => {
    const { app } = createTestApp({ clientDistDir: fakeClientDist() });
    const root = await request(app).get('/').set('Accept', 'text/html').expect(200);
    expect(root.text).toContain('<div id="root">');

    const deepLink = await request(app).get('/journeys/abc').set('Accept', 'text/html').expect(200);
    expect(deepLink.text).toContain('<div id="root">');
    expect(deepLink.headers['cache-control']).toBe('no-cache');

    const asset = await request(app).get('/assets/app-abc123.js').expect(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    await request(app).get('/assets/missing.js').expect(404);
    await request(app).get('/api/health').expect(200);
    // API 404s stay JSON even when the SPA is mounted.
    const api404 = await request(app).get('/api/nope').set('Accept', 'text/html').expect(404);
    expect(api404.body.error.code).toBe('NOT_FOUND');
  });

  it('explains how to build when the client bundle is missing', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/').expect(503);
    expect(res.text).toMatch(/client is not built/);
  });
});

describe('client IP header (CLIENT_IP_HEADER)', () => {
  const remaining = (res: request.Response) => Number(/remaining=(\d+)/.exec(res.headers['ratelimit'] ?? '')?.[1]);

  it('gives each visitor their own rate limit, keyed by the edge proxy header', async () => {
    const { app } = createTestApp({ env: { CLIENT_IP_HEADER: 'CF-Connecting-IP' } });
    const a1 = await request(app).get('/api/auth/me').set('CF-Connecting-IP', '203.0.113.7');
    const a2 = await request(app).get('/api/auth/me').set('CF-Connecting-IP', '203.0.113.7');
    const b1 = await request(app).get('/api/auth/me').set('CF-Connecting-IP', '2001:db8::1');
    expect(remaining(a2)).toBe(remaining(a1) - 1);
    expect(remaining(b1)).toBe(remaining(a1));
  });

  it('ignores values that are not IP addresses', async () => {
    const { app } = createTestApp({ env: { CLIENT_IP_HEADER: 'cf-connecting-ip' } });
    const first = await request(app).get('/api/auth/me').set('CF-Connecting-IP', 'not-an-ip');
    const second = await request(app).get('/api/auth/me').set('CF-Connecting-IP', 'also; bad');
    expect(remaining(second)).toBe(remaining(first) - 1); // both fell back to the socket address
  });

  it('rejects a header name that is not a plain token', () => {
    expect(() => loadConfig({ CLIENT_IP_HEADER: 'x forwarded' })).toThrow(/CLIENT_IP_HEADER/);
  });
});
