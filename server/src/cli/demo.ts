import fs from 'node:fs';
import pino from 'pino';
import { DEMO_ACCOUNTS } from '@mahilasathi/shared';
import { createApp } from '../app.js';
import { CLIENT_DIST_DIR, ConfigError, GEODATA_DIR, MIGRATIONS_DIR, loadConfigFromProcess } from '../config/index.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrator.js';
import { readGeoDataFiles, seedGeography } from '../services/geography/geoSeeder.js';

/**
 * npm run demo:seed       Create the fictional demo accounts (DEMO_MODE=true only).
 * npm run demo:companion  Start a walk for Neem-08 and ask for Walk Together, so Lotus-42 has a match.
 * npm run demo:reset      Delete the local database and seed fresh demo data (stop the dev server first).
 * npm run coverage:assess Assess data coverage for every curated neighbourhood from live place data.
 *                         Optional: --from lat,lng --to lat,lng --minutes 45
 */
const command = process.argv[2] ?? 'seed';
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const point = (s: string | undefined): [number, number] | undefined => {
  if (!s) return undefined;
  const [lat, lng] = s.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`Expected "lat,lng", got "${s}"`);
  return [lng!, lat!];
};

async function main() {
  const config = loadConfigFromProcess();
  if (command === 'coverage') {
    const db = openDatabase(config.databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    seedGeography(db, readGeoDataFiles(GEODATA_DIR));
    const app = createApp({ config, db, logger: pino({ level: 'warn' }), migrationsDir: MIGRATIONS_DIR, clientDistDir: CLIENT_DIST_DIR });
    if (!config.geoapify.apiKey) console.log('GEOAPIFY_API_KEY is not set: coverage needs live place data, so nothing was assessed.');
    else {
      const r = await app.services.coverage.assessAll((id, c) => console.log(`  ${id.padEnd(32)} ${c ? c.level : 'skipped (place data unavailable)'}`));
      console.log(`Assessed ${r.assessed}, skipped ${r.skipped}.`);
    }
    db.close();
    return;
  }
  if (!config.demoMode) {
    console.error('Refusing: DEMO_MODE is not true. Demo accounts must never be mixed into a real deployment.');
    process.exitCode = 2;
    return;
  }
  if (command === 'reset') {
    if (config.databasePath === ':memory:') throw new Error('DATABASE_PATH is :memory:, nothing to reset.');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${config.databasePath}${suffix}`, { force: true });
      } catch {
        throw new Error(`Could not delete ${config.databasePath}${suffix}. Stop the dev server first, then run this again.`);
      }
    }
    console.log(`Deleted ${config.databasePath}. Seeding fresh demo data…`);
  }
  const db = openDatabase(config.databasePath);
  runMigrations(db, MIGRATIONS_DIR);
  seedGeography(db, readGeoDataFiles(GEODATA_DIR));
  const app = createApp({ config, db, logger: pino({ level: 'warn' }), migrationsDir: MIGRATIONS_DIR, clientDistDir: CLIENT_DIST_DIR });
  try {
    if (command === 'seed' || command === 'reset') {
      const r = await app.services.demo.seed();
      console.log(`Demo accounts in ${config.databasePath} (fictional; sign in with the development code shown on screen):`);
      for (const a of r.accounts) {
        const meta = DEMO_ACCOUNTS.find((d) => d.handle === a.handle);
        console.log(`  ${a.handle.padEnd(11)} phone ${a.phone}  ${meta?.role ?? ''}${a.created ? '  (created)' : ''}`);
      }
      for (const n of r.notes) console.log(`  - ${n}`);
    } else if (command === 'companion') {
      const from = point(arg('from'));
      const to = point(arg('to'));
      const minutes = Number(arg('minutes') ?? 45);
      const r = await app.services.demo.startCompanion(from && to ? { from, to } : undefined, minutes);
      console.log(`Neem-08 is walking and looking for company until ${new Date(r.window.end).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (trip ${r.tripId}).`);
      console.log(r.matches ? `Already matched with ${r.matches} walker(s).` : 'No match yet: Lotus-42 can now ask for Walk Together on a similar walk.');
    } else {
      console.error(`Unknown command "${command}". Use "seed" or "companion".`);
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : `Demo command failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
