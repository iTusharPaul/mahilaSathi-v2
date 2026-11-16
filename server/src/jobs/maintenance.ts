import type { Logger } from 'pino';
import type { AuthService } from '../services/auth/authService.js';
import type { CommunityService } from '../services/community/communityService.js';
import type { RoutePlanningService } from '../services/routing/routePlanningService.js';
import type { TripService } from '../services/journeys/tripService.js';
import type { WalkTogetherService } from '../services/journeys/walkTogetherService.js';
import type { PulseService } from '../services/pulse/pulseService.js';
import type { SosService } from '../services/sos/sosService.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Housekeeping: journey delay detection, Walk Together and journey-room expiry every minute; retention and channel archiving hourly. All jobs are
 * idempotent and driven by database state, so a restart simply picks up where they left off.
 */
export function startMaintenanceJobs(deps: { auth: AuthService; community: CommunityService; planning: RoutePlanningService; trips: TripService; walk: WalkTogetherService; pulse: PulseService; sos: SosService; logger: Logger }): () => void {
  const { logger } = deps;
  const guarded = (name: string, fn: () => unknown | Promise<unknown>) => async () => {
    try {
      const result = await fn();
      if (result && (typeof result !== 'object' || Object.values(result).some(Boolean))) logger.info({ job: name, result }, 'maintenance job ran');
    } catch (err) {
      logger.error({ err, job: name }, 'maintenance job failed');
    }
  };

  const everyMinute = guarded('journeys-and-rooms', async () => ({
    ...(await deps.trips.tick()),
    walkRequestsExpired: deps.walk.expire(),
    roomsArchived: await deps.community.archiveExpiredRooms(),
  }));
  const hourly = guarded('retention', async () => ({
    ...deps.auth.purgeExpired(),
    relayMessages: deps.community.purgeRelay(),
    abandonedChannels: await deps.community.archiveAbandonedNeighbourhoods(),
    ...deps.planning.purge(),
    ...deps.trips.purge(),
    ...deps.pulse.maintain(),
    ...deps.sos.purge(),
  }));

  void everyMinute();
  void hourly();
  const t1 = setInterval(() => void everyMinute(), MINUTE_MS);
  const t2 = setInterval(() => void hourly(), HOUR_MS);
  t1.unref();
  t2.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
