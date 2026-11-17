import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { createApp, type AppDeps } from '../../server/src/app.js';
import { GEODATA_DIR, MIGRATIONS_DIR, loadConfig, type AppConfig } from '../../server/src/config/index.js';
import { openDatabase, type Db } from '../../server/src/db/connection.js';
import { runMigrations } from '../../server/src/db/migrator.js';
import { readGeoDataFiles, seedGeography, type GeoDataFiles } from '../../server/src/services/geography/geoSeeder.js';

export function makeTempDir(prefix = 'ms-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let cachedGeoData: GeoDataFiles | null = null;
/** Parsed once per test file: the district GeoJSON is a few hundred kilobytes. */
export function geoData(): GeoDataFiles {
  cachedGeoData ??= readGeoDataFiles(GEODATA_DIR);
  return cachedGeoData;
}

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Db;
  config: AppConfig;
}

/** A controllable clock for expiry tests. */
export function testClock(start = new Date('2026-11-12T18:00:00.000Z')) {
  let now = start.getTime();
  const clock = () => new Date(now);
  return Object.assign(clock, { advance: (ms: number) => void (now += ms) });
}

/** An app wired exactly like production, with an in-memory database and silent logging. */
export function createTestApp(
  options: {
    env?: Record<string, string>;
    clientDistDir?: string;
    migrate?: boolean;
    seedGeo?: boolean;
    migrationsDir?: string;
    /** Reuse an existing database (e.g. to simulate a server restart). Skips migration and seeding. */
    db?: Db;
  } & Partial<Pick<AppDeps, 'clock' | 'otpProvider' | 'geocoder' | 'nexconnApi' | 'routingProviders' | 'smsProvider' | 'pushSender' | 'googleVerifier'>> = {},
): TestContext {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...options.env });
  const db = options.db ?? openDatabase(config.databasePath);
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  if (options.migrate !== false && !options.db) {
    runMigrations(db, migrationsDir);
    if (options.seedGeo !== false) seedGeography(db, geoData());
  }
  const app = createApp({
    config,
    db,
    logger: pino({ level: 'silent' }),
    migrationsDir,
    clientDistDir: options.clientDistDir ?? path.join(makeTempDir(), 'no-client'),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.otpProvider ? { otpProvider: options.otpProvider } : {}),
    ...(options.geocoder !== undefined ? { geocoder: options.geocoder } : {}),
    ...(options.nexconnApi ? { nexconnApi: options.nexconnApi } : {}),
    ...(options.routingProviders ? { routingProviders: options.routingProviders } : {}),
    ...(options.smsProvider ? { smsProvider: options.smsProvider } : {}),
    ...(options.pushSender ? { pushSender: options.pushSender } : {}),
    ...(options.googleVerifier ? { googleVerifier: options.googleVerifier } : {}),
  });
  return { app, db, config };
}

let phoneCounter = 0;
/** A distinct valid Indian mobile number per call. */
export function nextPhone(): string {
  phoneCounter++;
  return `98${String(10_000_000 + phoneCounter).slice(-8)}`;
}

/** Signs a user in through the real OTP flow and returns an agent that carries the session cookie. */
export async function signIn(app: TestContext['app'], phone = nextPhone()) {
  const agent = request.agent(app);
  const sent = await agent.post('/api/auth/send-otp').send({ phone }).expect(201);
  const verified = await agent
    .post('/api/auth/verify-otp')
    .send({ otpSessionId: sent.body.otpSessionId, code: sent.body.delivery.devCode })
    .expect(200);
  return { agent, phone, user: verified.body.user as { id: string; communityHandle: string }, isNewUser: verified.body.isNewUser as boolean };
}
