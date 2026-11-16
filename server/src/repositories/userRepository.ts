import crypto from 'node:crypto';
import type { Preferences } from '@mahilasathi/shared';
import type { Db } from '../db/connection.js';

export interface UserRow {
  id: string;
  phone_e164: string | null;
  display_name: string | null;
  community_handle: string;
  home_district_id: string | null;
  home_neighbourhood_id: string | null;
  onboarding_completed_at: string | null;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_demo: number;
}

interface PreferencesRow {
  location_sharing_default: Preferences['locationSharingDefault'];
  notify_journey_updates: number;
  notify_community: number;
  notify_sos: number;
}

const toPreferences = (r: PreferencesRow): Preferences => ({
  locationSharingDefault: r.location_sharing_default,
  notifyJourneyUpdates: r.notify_journey_updates === 1,
  notifyCommunity: r.notify_community === 1,
  notifySos: r.notify_sos === 1,
});

export function createUserRepository(db: Db) {
  const byId = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'");
  const byPhone = db.prepare("SELECT * FROM users WHERE phone_e164 = ? AND status = 'active'");
  const handleTaken = db.prepare('SELECT 1 FROM users WHERE community_handle = ?');

  return {
    findById: (id: string) => byId.get(id) as UserRow | undefined,
    findByPhone: (phone: string) => byPhone.get(phone) as UserRow | undefined,
    isHandleTaken: (handle: string) => handleTaken.get(handle) !== undefined,

    /** Flags a fictional demo account (demo seeding only). */
    markDemo: (id: string) => void db.prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(id),

    create(phone: string, handle: string, now: string): UserRow {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO users (id, phone_e164, community_handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, phone, handle, now, now);
      db.prepare('INSERT INTO user_preferences (user_id, updated_at) VALUES (?, ?)').run(id, now);
      return byId.get(id) as UserRow;
    },

    update(
      id: string,
      fields: Partial<Pick<UserRow, 'display_name' | 'home_district_id' | 'home_neighbourhood_id' | 'onboarding_completed_at'>>,
      now: string,
    ): UserRow {
      const allowed = ['display_name', 'home_district_id', 'home_neighbourhood_id', 'onboarding_completed_at'] as const;
      const sets = allowed.filter((k) => k in fields);
      if (sets.length) {
        db.prepare(`UPDATE users SET ${sets.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({
          ...Object.fromEntries(sets.map((k) => [k, fields[k] ?? null])),
          now,
          id,
        });
      }
      return byId.get(id) as UserRow;
    },

    /** Tombstones the account: personal fields cleared, dependent personal data removed. */
    softDelete(id: string, now: string): void {
      db.transaction(() => {
        db.prepare('DELETE FROM emergency_contacts WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(id);
        db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
        // Community: leave every channel and circle; an owned circle is closed with its private channel.
        db.prepare("UPDATE community_memberships SET status = 'left', left_at = ? WHERE user_id = ? AND status = 'active'").run(now, id);
        db.prepare("UPDATE circle_members SET status = 'left', ended_at = ? WHERE user_id = ? AND status = 'active' AND role = 'guardian'").run(now, id);
        db.prepare("UPDATE circle_members SET status = 'removed', ended_at = ? WHERE status = 'active' AND circle_id IN (SELECT id FROM circles WHERE owner_id = ?)").run(now, id);
        db.prepare('UPDATE circle_invites SET revoked_at = ? WHERE revoked_at IS NULL AND accepted_at IS NULL AND circle_id IN (SELECT id FROM circles WHERE owner_id = ?)').run(now, id);
        db.prepare("UPDATE community_channels SET status = 'archived', archived_at = ?, archive_reason = 'owner_deleted' WHERE status = 'active' AND id IN (SELECT channel_id FROM circles WHERE owner_id = ?)").run(now, id);
        db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').run(id, id);
        db.prepare('DELETE FROM route_plans WHERE user_id = ?').run(id);
        // Journeys (with routes, check-ins, shares, live locations, corridors and Walk Together requests
        // via cascades) and every Pulse signal and report. Aggregates are recomputed by the hourly job.
        db.prepare("UPDATE walk_together_matches SET status = 'cancelled', updated_at = ? WHERE (user_a = ? OR user_b = ?) AND status IN ('proposed', 'accepted')").run(now, id, id);
        db.prepare('DELETE FROM trips WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM community_pulse_signals WHERE contributor_id = ?').run(id);
        db.prepare('DELETE FROM community_reports WHERE user_id = ?').run(id);
        // SOS: the person's own events (recipients, deliveries and acknowledgements by cascade) and settings.
        // Where they were a guardian recipient on someone else's SOS, keep the record but drop their name.
        db.prepare('DELETE FROM sos_events WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM sos_settings WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id);
        db.prepare("UPDATE sos_recipients SET name = 'Former member' WHERE user_id = ?").run(id);
        db.prepare(
          `UPDATE users SET status = 'deleted', phone_e164 = NULL, display_name = NULL, home_district_id = NULL,
             home_neighbourhood_id = NULL, deleted_at = @now, updated_at = @now WHERE id = @id`,
        ).run({ id, now });
      })();
    },

    getPreferences(userId: string): Preferences {
      const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as PreferencesRow | undefined;
      if (row) return toPreferences(row);
      db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(userId);
      return toPreferences(db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as PreferencesRow);
    },

    updatePreferences(userId: string, patch: Partial<Preferences>, now: string): Preferences {
      const current = this.getPreferences(userId);
      const next = { ...current, ...patch };
      db.prepare(
        `UPDATE user_preferences SET location_sharing_default = ?, notify_journey_updates = ?, notify_community = ?,
           notify_sos = ?, updated_at = ? WHERE user_id = ?`,
      ).run(
        next.locationSharingDefault,
        next.notifyJourneyUpdates ? 1 : 0,
        next.notifyCommunity ? 1 : 0,
        next.notifySos ? 1 : 0,
        now,
        userId,
      );
      return next;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
