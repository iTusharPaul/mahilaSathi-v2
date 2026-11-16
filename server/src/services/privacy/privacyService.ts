import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { PrivacyRepository } from '../../repositories/privacyRepository.js';
import type { PulseRepository } from '../../repositories/pulseRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import type { Clock } from '../../utils/crypto.js';
import type { PulseService } from '../pulse/pulseService.js';
import type { SosService } from '../sos/sosService.js';

/** Profile → Privacy: download my data, stop all location sharing now, and clear journey history. */
export function createPrivacyService(deps: { repo: PrivacyRepository; pulseRepo: PulseRepository; pulse: PulseService; sos: SosService; audit: AuditRepository; clock: Clock }) {
  const { repo, pulseRepo, pulse, sos, audit, clock } = deps;
  return {
    exportData(user: UserRow) {
      audit.record({ actorType: 'user', actorId: user.id, action: 'privacy.data_exported', targetType: 'user', targetId: user.id });
      return {
        exportedAt: clock().toISOString(),
        notes: [
          'This file contains your own data held by mahilaSathi. Other people appear by display name or pseudonym only.',
          'Chat messages are held by the chat provider (Nexconn) and are not included.',
          'It includes precise locations and your emergency contacts’ phone numbers. Store it securely.',
        ],
        ...repo.exportFor(user.id),
      };
    },

    /** One tap: live location off on every open journey and on an active SOS; stored points deleted. */
    stopAllLocationSharing(user: UserRow): { journeys: number; sos: number } {
      const journeys = repo.stopTripLocations(user.id);
      const sosCount = sos.stopLocation(user.id);
      audit.record({ actorType: 'user', actorId: user.id, action: 'privacy.location_sharing_stopped', targetType: 'user', targetId: user.id, metadata: { journeys, sos: sosCount } });
      return { journeys, sos: sosCount };
    },

    /** Deletes ended journeys and withdraws the Pulse signals they contributed. */
    clearJourneyHistory(user: UserRow): { deleted: number } {
      const ids = repo.deleteEndedTrips(user.id);
      const cells = ids.flatMap((id) => [...pulseRepo.deleteSignalsForSource(id), ...pulseRepo.deleteSignalsForSource(`${id}:feedback`)]);
      pulse.recompute(cells);
      audit.record({ actorType: 'user', actorId: user.id, action: 'privacy.journey_history_cleared', targetType: 'user', targetId: user.id, metadata: { deleted: ids.length } });
      return { deleted: ids.length };
    },
  };
}

export type PrivacyService = ReturnType<typeof createPrivacyService>;
