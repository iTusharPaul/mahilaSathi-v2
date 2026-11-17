import type { HealthResponse, ProviderStatus, PublicConfig, ReadyResponse } from '@mahilasathi/shared';
import type { AppConfig } from '../../config/index.js';
import type { Db } from '../../db/connection.js';
import { getMigrationStatus } from '../../db/migrator.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';
const startedAt = Date.now();

export function createSystemService(deps: { config: AppConfig; db: Db; migrationsDir: string; registry: GeoRegistry }) {
  const { config, db, migrationsDir, registry } = deps;

  const provider = (configured: boolean, whenMissing: ProviderStatus['mode']): ProviderStatus => ({
    configured,
    mode: configured ? 'live' : whenMissing,
  });

  return {
    health(): HealthResponse {
      return {
        status: 'ok',
        service: 'mahilasathi',
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        time: new Date().toISOString(),
      };
    },

    ready(): ReadyResponse {
      let database: ReadyResponse['checks']['database'];
      try {
        db.prepare('SELECT 1').get();
        database = { ok: true };
      } catch {
        database = { ok: false, detail: 'Database query failed' };
      }

      let migrations: ReadyResponse['checks']['migrations'];
      try {
        const status = getMigrationStatus(db, migrationsDir);
        migrations = {
          ok: status.pending.length === 0,
          applied: status.applied.length,
          pending: status.pending.length,
          ...(status.pending.length ? { detail: 'Pending migrations; run npm run db:migrate' } : {}),
        };
      } catch {
        migrations = { ok: false, applied: 0, pending: 0, detail: 'Migration ledger does not match code' };
      }

      const geography = registry.isLoaded
        ? { ok: true, datasetVersion: registry.dataset.version }
        : { ok: false, datasetVersion: null, detail: 'NCR geography not loaded' };

      return {
        status: database.ok && migrations.ok && geography.ok ? 'ready' : 'not_ready',
        checks: { database, migrations, geography },
      };
    },

    /** Only booleans and modes leave the server; key and secret values never do. */
    publicConfig(): PublicConfig {
      return {
        environment: config.env,
        demoMode: config.demoMode,
        communityModerationEnabled: config.communityModerationEnabled,
        auth: {
          googleClientId: config.google.clientId,
          phoneSignIn: config.google.clientId && config.otp.provider === 'mock' ? 'demo_accounts_only' : 'open',
        },
        dataStorage: config.dataReplicated ? 'replicated' : 'local',
        providers: {
          geoapify: provider(Boolean(config.geoapify.apiKey), 'dev-adapter'),
          nexconn: provider(Boolean(config.nexconn.appKey && config.nexconn.appSecret), 'dev-adapter'),
          otp: { configured: true, mode: config.otp.provider === 'mock' ? 'dev-adapter' : 'live' },
          push: { configured: config.push.vapid !== null, mode: config.push.vapid ? 'live' : 'disabled' },
          sms: { configured: config.sms.provider !== 'none', mode: config.sms.provider === 'none' ? 'disabled' : 'dev-adapter' },
        },
      };
    },
  };
}

export type SystemService = ReturnType<typeof createSystemService>;
