import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, REPO_ROOT, loadConfig } from '../../server/src/config/index.js';

const STRONG = 'x'.repeat(40);

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies safe development defaults', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.port).toBe(8080);
    expect(config.demoMode).toBe(false);
    expect(config.communityModerationEnabled).toBe(true);
    expect(config.otp.provider).toBe('mock');
    expect(config.push.provider).toBe('none');
    expect(config.jwtSecretIsEphemeral).toBe(true);
    expect(config.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.databasePath).toBe(path.resolve(REPO_ROOT, 'data/mahilasathi.db'));
  });

  it('treats blank values copied from .env.example as unset', () => {
    const config = loadConfig({ PORT: '', GEOAPIFY_API_KEY: '  ', NEXCONN_APP_KEY: '', NEXCONN_APP_SECRET: '' });
    expect(config.port).toBe(8080);
    expect(config.geoapify.apiKey).toBeNull();
    expect(config.nexconn.appKey).toBeNull();
  });

  it('parses boolean flags', () => {
    expect(loadConfig({ DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(loadConfig({ DEMO_MODE: '0' }).demoMode).toBe(false);
    expect(problemsOf({ DEMO_MODE: 'maybe' })).toEqual([expect.stringContaining('DEMO_MODE')]);
  });

  it('auto-seeds demo data only in demo mode, and trusts one proxy by default', () => {
    expect(loadConfig({ DEMO_MODE: 'true', DEMO_AUTOSEED: 'true' }).demoAutoSeed).toBe(true);
    expect(loadConfig({ DEMO_AUTOSEED: 'true' }).demoAutoSeed).toBe(false);
    expect(loadConfig({}).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(problemsOf({ TRUST_PROXY: 'lots' })).toEqual([expect.stringContaining('TRUST_PROXY')]);
  });

  it('accepts only a Google OAuth web client id', () => {
    expect(loadConfig({}).google.clientId).toBeNull();
    expect(loadConfig({ GOOGLE_CLIENT_ID: '' }).google.clientId).toBeNull();
    const id = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
    expect(loadConfig({ GOOGLE_CLIENT_ID: id }).google.clientId).toBe(id);
    expect(problemsOf({ GOOGLE_CLIENT_ID: 'GOCSPX-this-is-a-client-secret' })).toEqual([expect.stringContaining('GOOGLE_CLIENT_ID')]);
  });

  it('requires strong secrets in production and reports every problem at once', () => {
    const problems = problemsOf({ NODE_ENV: 'production', DEMO_MODE: 'true' });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/JWT_SECRET is required/);
    expect(problems.join('\n')).toMatch(/ADMIN_TOKEN is required/);
    expect(problems.join('\n')).toMatch(/randomBytes/); // actionable fix included
  });

  it('rejects short secrets in any environment', () => {
    expect(problemsOf({ JWT_SECRET: 'short' })).toEqual([expect.stringContaining('at least 32')]);
  });

  it('refuses the mock OTP provider in production outside demo mode', () => {
    const problems = problemsOf({ NODE_ENV: 'production', JWT_SECRET: STRONG, ADMIN_TOKEN: STRONG });
    expect(problems).toEqual([expect.stringContaining('OTP_PROVIDER=mock cannot be used in production')]);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: STRONG, ADMIN_TOKEN: STRONG, DEMO_MODE: 'true' }),
    ).not.toThrow();
  });

  it('rejects unsupported providers instead of silently faking them', () => {
    expect(problemsOf({ OTP_PROVIDER: 'twilio' })).toEqual([expect.stringContaining('not supported')]);
    expect(problemsOf({ PUSH_PROVIDER: 'fcm' })).toEqual([expect.stringContaining('not supported')]);
  });

  it('requires the Nexconn key and secret together', () => {
    expect(problemsOf({ NEXCONN_APP_KEY: 'abc' })).toEqual([expect.stringContaining('NEXCONN_APP_KEY and NEXCONN_APP_SECRET')]);
    expect(problemsOf({ NEXCONN_APP_KEY: 'abc', NEXCONN_APP_SECRET: 'def' })).toEqual([]);
  });

  it('validates CORS origins', () => {
    expect(loadConfig({ CORS_ORIGINS: 'http://localhost:5173, https://app.example.in/' }).corsOrigins).toEqual([
      'http://localhost:5173',
      'https://app.example.in',
    ]);
    expect(problemsOf({ CORS_ORIGINS: 'https://app.example.in/path' })).toEqual([expect.stringContaining('CORS_ORIGINS')]);
    expect(problemsOf({ CORS_ORIGINS: 'not a url' })).toEqual([expect.stringContaining('CORS_ORIGINS')]);
  });

  it('rejects an invalid port or environment', () => {
    expect(problemsOf({ PORT: '99999' })).toEqual([expect.stringContaining('PORT')]);
    expect(problemsOf({ NODE_ENV: 'staging' })).toEqual([expect.stringContaining('NODE_ENV')]);
  });
});
