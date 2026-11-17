import {
  MAX_EMERGENCY_CONTACTS,
  maskEmail,
  maskPhone,
  type EmergencyContact,
  type Me,
  type Preferences,
  type UpdateMe,
} from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { EmergencyContactRepository } from '../../repositories/emergencyContactRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';

export function createUserService(deps: {
  users: UserRepository;
  contacts: EmergencyContactRepository;
  audit: AuditRepository;
  registry: GeoRegistry;
  clock: Clock;
}) {
  const { users, contacts, audit, registry, clock } = deps;
  const nowIso = () => clock().toISOString();

  function toMe(u: UserRow): Me {
    let homeArea: Me['homeArea'] = null;
    if (u.home_neighbourhood_id) {
      const n = registry.neighbourhoodEntry(u.home_neighbourhood_id);
      if (n) {
        homeArea = {
          state: registry.state(n.stateId)!,
          district: registry.districtRef(n.districtId)!,
          city: registry.cityRef(n.cityId),
          neighbourhood: { id: n.id, name: n.name },
        };
      }
    }
    if (!homeArea && u.home_district_id) {
      const district = registry.districtRef(u.home_district_id);
      const stateId = registry.districtStateId(u.home_district_id);
      if (district && stateId) homeArea = { state: registry.state(stateId)!, district, city: null, neighbourhood: null };
    }
    return {
      id: u.id,
      maskedPhone: u.phone_e164 ? maskPhone(u.phone_e164) : '',
      signInMethod: u.google_sub ? 'google' : 'phone',
      maskedEmail: u.email ? maskEmail(u.email) : null,
      displayName: u.display_name,
      communityHandle: u.community_handle,
      homeArea,
      onboardingCompleted: u.onboarding_completed_at !== null,
      isDemo: u.is_demo === 1,
      createdAt: u.created_at,
    };
  }

  return {
    toMe,

    updateMe(user: UserRow, patch: UpdateMe, requestId?: string): Me {
      const fields: Parameters<UserRepository['update']>[1] = {};
      if (patch.displayName !== undefined) fields.display_name = patch.displayName;

      if (patch.homeNeighbourhoodId !== undefined) {
        if (patch.homeNeighbourhoodId === null) {
          fields.home_neighbourhood_id = null;
          if (patch.homeDistrictId === undefined) fields.home_district_id = null;
        } else {
          const n = registry.neighbourhoodEntry(patch.homeNeighbourhoodId);
          if (!n) throw new AppError('VALIDATION_FAILED', 'That neighbourhood is not available', [{ path: 'homeNeighbourhoodId', message: 'Unknown neighbourhood' }]);
          fields.home_neighbourhood_id = n.id;
          fields.home_district_id = n.districtId;
        }
      }
      if (patch.homeDistrictId !== undefined && fields.home_neighbourhood_id === undefined) {
        if (patch.homeDistrictId !== null && !registry.districtRef(patch.homeDistrictId)) {
          throw new AppError('VALIDATION_FAILED', 'That district is not available', [{ path: 'homeDistrictId', message: 'Unknown district' }]);
        }
        fields.home_district_id = patch.homeDistrictId;
        fields.home_neighbourhood_id = null;
      }

      if (patch.onboardingCompleted) {
        const displayName = fields.display_name ?? user.display_name;
        if (!displayName) throw new AppError('VALIDATION_FAILED', 'Choose a display name before finishing setup');
        if (!user.onboarding_completed_at) fields.onboarding_completed_at = nowIso();
      }

      const updated = users.update(user.id, fields, nowIso());
      if ('home_district_id' in fields || 'home_neighbourhood_id' in fields) {
        audit.record({ actorType: 'user', actorId: user.id, action: 'user.home_area_changed', targetType: 'user', targetId: user.id, requestId: requestId ?? null, metadata: { districtId: updated.home_district_id, neighbourhoodId: updated.home_neighbourhood_id } });
      }
      return toMe(updated);
    },

    getPreferences: (userId: string) => users.getPreferences(userId),

    updatePreferences(userId: string, patch: Partial<Preferences>, requestId?: string): Preferences {
      const before = users.getPreferences(userId);
      const after = users.updatePreferences(userId, patch, nowIso());
      if (before.locationSharingDefault !== after.locationSharingDefault) {
        audit.record({ actorType: 'user', actorId: userId, action: 'privacy.location_sharing_default_changed', targetType: 'user', targetId: userId, requestId: requestId ?? null, metadata: { from: before.locationSharingDefault, to: after.locationSharingDefault } });
      }
      return after;
    },

    listContacts: (userId: string) => contacts.list(userId),

    addContact(user: UserRow, input: { name: string; phone: string; relationship?: string | null | undefined }): EmergencyContact {
      if (input.phone === user.phone_e164) throw new AppError('VALIDATION_FAILED', 'An emergency contact must be someone else’s number');
      if (contacts.count(user.id) >= MAX_EMERGENCY_CONTACTS) {
        throw new AppError('CONFLICT', `You can add up to ${MAX_EMERGENCY_CONTACTS} emergency contacts`);
      }
      if (contacts.phoneTaken(user.id, input.phone)) throw new AppError('CONFLICT', 'This number is already one of your contacts');
      const created = contacts.create(user.id, { name: input.name, phone: input.phone, relationship: input.relationship ?? null }, nowIso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'emergency_contact.added', targetType: 'emergency_contact', targetId: created.id });
      return created;
    },

    updateContact(
      user: UserRow,
      id: string,
      patch: Partial<{ name: string; phone: string; relationship: string | null; priority: number }>,
    ): EmergencyContact {
      if (patch.phone && patch.phone === user.phone_e164) throw new AppError('VALIDATION_FAILED', 'An emergency contact must be someone else’s number');
      if (patch.phone && contacts.phoneTaken(user.id, patch.phone, id)) throw new AppError('CONFLICT', 'This number is already one of your contacts');
      const updated = contacts.update(user.id, id, patch, nowIso());
      if (!updated) throw notFound('Emergency contact');
      return updated;
    },

    deleteContact(userId: string, id: string): void {
      if (!contacts.delete(userId, id)) throw notFound('Emergency contact');
      audit.record({ actorType: 'user', actorId: userId, action: 'emergency_contact.removed', targetType: 'emergency_contact', targetId: id });
    },

    deleteAccount(userId: string, requestId?: string): void {
      users.softDelete(userId, nowIso());
      audit.record({ actorType: 'user', actorId: userId, action: 'user.deleted', targetType: 'user', targetId: userId, requestId: requestId ?? null });
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
