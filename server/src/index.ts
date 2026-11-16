import { createApp } from './app.js';
import { CLIENT_DIST_DIR, ConfigError, GEODATA_DIR, MIGRATIONS_DIR, loadConfigFromProcess } from './config/index.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrator.js';
import { startMaintenanceJobs } from './jobs/maintenance.js';
import { startSosWorker } from './jobs/sosWorker.js';
import { readGeoDataFiles, seedGeography } from './services/geography/geoSeeder.js';
import { createLogger } from './utils/logger.js';

function main(): void {
  let config;
  try {
    config = loadConfigFromProcess();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config);
  if (config.jwtSecretIsEphemeral) {
    logger.warn('JWT_SECRET not set: using an ephemeral secret, so sessions end when the server restarts');
  }
  if (config.demoMode) logger.warn('DEMO_MODE is on: synthetic data and development adapters are enabled');
  if (!config.geoapify.apiKey) logger.warn('GEOAPIFY_API_KEY not set: place search uses the local NCR gazetteer only');

  const db = openDatabase(config.databasePath);
  const applied = runMigrations(db, MIGRATIONS_DIR);
  if (applied.length) logger.info({ migrations: applied.map((m) => m.filename) }, 'applied migrations');
  const seeded = seedGeography(db, readGeoDataFiles(GEODATA_DIR));
  if (seeded.districts || seeded.places) logger.info(seeded, 'loaded NCR geography');

  const app = createApp({ config, db, logger, migrationsDir: MIGRATIONS_DIR, clientDistDir: CLIENT_DIST_DIR });
  const stopJobs = startMaintenanceJobs({ auth: app.services.auth, community: app.services.community, planning: app.services.planning, trips: app.services.trips, walk: app.services.walk, pulse: app.services.pulse, sos: app.services.sos, logger });
  const stopSos = startSosWorker({ sos: app.services.sos, logger });
  if (app.services.sos.smsMode === 'disabled') logger.warn('SMS_PROVIDER is none: SOS alerts reach the Guardian Circle in the app only; emergency contacts are not messaged');
  logger.info({ chat: app.services.chatProvider.mode }, app.services.chatProvider.mode === 'nexconn' ? 'community chat: Nexconn' : 'community chat: development relay (NEXCONN_APP_KEY/SECRET not set)');
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, `mahilaSathi listening on http://localhost:${config.port}`);
    if (config.demoAutoSeed) {
      // Demo hosts whose disk resets on restart: recreate the fictional accounts so the demo always works.
      app.services.demo
        .seed()
        .then((r) => logger.info({ accounts: r.accounts.length, created: r.accounts.filter((a) => a.created).length }, 'demo accounts ready'))
        .catch((err) => logger.error({ err }, 'demo seeding failed'));
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopJobs();
    stopSos();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
}

main();
